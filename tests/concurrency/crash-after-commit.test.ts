import { afterEach, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger';
import { eventually } from '../support/eventually';
import { httpClient } from '../support/http';
import { metricValue } from '../support/log-capture';
import { type SpawnedInstance, spawnInstance } from '../support/spawn-instance';
import { bodyOf, queueDepth, receiveMessages, sendRaw } from '../support/sqs-helpers';
import { testEnvVars } from '../support/test-config';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, type TestQueues } from '../support/test-queues';
import { wageringApi } from '../support/wagering-api';

/**
 * Cenário obrigatório #5: o consumidor morre (SIGKILL) depois do commit e antes do ack.
 * A mensagem volta para a fila quando a visibilidade vence, outra instância a recebe e o
 * inbox no Postgres reconhece a redelivery: nenhum segundo débito, nenhum evento a mais.
 */

let db: TestDatabase;
let queues: TestQueues;
const instances: SpawnedInstance[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.stop('SIGKILL')));
  await queues?.destroy();
  await db?.drop();
});

async function spawn(overrides: Record<string, string>): Promise<SpawnedInstance> {
  const instance = await spawnInstance(
    testEnvVars({
      databaseUrl: db.url,
      queues: queues.names,
      overrides: {
        RUN_CONSUMER: 'true',
        CONSUMER_VISIBILITY_TIMEOUT_S: '2',
        CONSUMER_WAIT_TIME_S: '1',
        ...overrides,
      },
    }),
    { waitForReady: true },
  );
  instances.push(instance);
  return instance;
}

describe('consumidor morto entre o commit e o ack', () => {
  test('a redelivery é reconhecida pelo inbox: um débito, um inbox, um par de eventos', async () => {
    db = await createTestDatabase();
    queues = await createTestQueues({ visibilityTimeoutS: 2 });

    const a = await spawn({ FAULT_KILL_AFTER_COMMIT: '1', RUN_OUTBOX_PUBLISHER: 'false' });
    const wallet = await wageringApi(httpClient(a.baseUrl)).createWallet('100.00');

    const externalTransactionId = `tx-${Bun.randomUUIDv7()}`;
    const envelope = {
      messageId: `msg-${Bun.randomUUIDv7()}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    };
    await sendRaw(queues.client, queues.urls.transactions, JSON.stringify(envelope), {
      groupId: wallet.id,
      deduplicationId: envelope.messageId,
    });

    // A instância A commita e se mata antes de apagar a mensagem.
    const exitCode = await Promise.race([
      a.process.exited,
      Bun.sleep(20_000).then(() => {
        throw new Error(`A instância não morreu após o commit\n${a.output()}`);
      }),
    ]);
    expect(a.process.signalCode === 'SIGKILL' || (exitCode ?? 0) !== 0, a.output()).toBe(true);

    // O efeito está commitado...
    const [tx] = await db.sql`
      SELECT id, status FROM wager_transactions WHERE external_transaction_id = ${externalTransactionId}`;
    expect(tx.status).toBe('PROCESSED');
    const [{ debits }] = await db.sql`
      SELECT count(*)::int AS debits FROM wallet_ledger_entries WHERE wallet_id = ${wallet.id} AND direction = 'DEBIT'`;
    expect(debits).toBe(1);
    const [{ inbox }] = await db.sql`
      SELECT count(*)::int AS inbox FROM inbox_messages WHERE message_id = ${envelope.messageId}`;
    expect(inbox).toBe(1);
    const [{ balance }] = await db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.id}`;
    expect(balance).toBe('90.00');
    // ...mas a mensagem não foi confirmada: continua na fila (em voo até a visibilidade vencer).
    const depth = await queueDepth(queues.client, queues.urls.transactions);
    expect(depth.visible + depth.inFlight).toBe(1);

    // A instância B (sem gancho de falha, com publisher) recebe a redelivery.
    const b = await spawn({ RUN_OUTBOX_PUBLISHER: 'true' });
    await eventually(
      async () => expect(await queueDepth(queues.client, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 }),
      { timeout: 20_000, interval: 200 },
    );

    const transactions = await db.sql`
      SELECT id, status FROM wager_transactions WHERE external_transaction_id = ${externalTransactionId}`;
    expect(transactions).toEqual([{ id: tx.id, status: 'PROCESSED' }]);
    const [after] = await db.sql`
      SELECT (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${wallet.id} AND direction = 'DEBIT') AS debits,
             (SELECT count(*)::int FROM inbox_messages WHERE message_id = ${envelope.messageId}) AS inbox,
             (SELECT count(*)::int FROM outbox_messages WHERE payload ->> 'causationId' = ${tx.id}) AS events,
             (SELECT balance::text FROM wallets WHERE id = ${wallet.id}) AS balance`;
    expect(after).toEqual({ debits: 1, inbox: 1, events: 2, balance: '90.00' });

    const metrics = await (await fetch(`${b.baseUrl}/metrics`)).text();
    expect(metricValue(metrics, 'wager_duplicates_total', { source: 'sqs' })).toBe(1);
    // B não decidiu nada de novo: só reconheceu a redelivery.
    expect(metricValue(metrics, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(0);
    expect(await queueDepth(queues.client, queues.urls.dlq)).toEqual({ visible: 0, inFlight: 0 });

    // Os dois eventos gravados por A são publicados por B, cada um uma vez.
    const delivered = await receiveMessages(queues.client, queues.urls.events, { expected: 2, timeoutMs: 15_000 });
    expect(delivered.map((message) => bodyOf(message).eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    await assertWalletMatchesLedger(db.sql, wallet.id);
  }, 60_000);
});
