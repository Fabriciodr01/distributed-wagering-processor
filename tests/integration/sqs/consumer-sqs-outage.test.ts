import { afterEach, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../../support/assert-wallet-matches-ledger';
import { eventually } from '../../support/eventually';
import { httpClient } from '../../support/http';
import { type SeededWallet, seedWallet } from '../../support/sql-fixtures';
import { expectQueueEmpty, queueDepth, sendRaw } from '../../support/sqs-helpers';
import { TcpProxy } from '../../support/tcp-proxy';
import { startTestApp, type TestApp } from '../../support/test-app';
import { buildTestConfig } from '../../support/test-config';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { testInfra } from '../../support/test-env';
import { createTestQueues, type TestQueues } from '../../support/test-queues';

/**
 * Queda real do SQS com o consumidor rodando: a aplicação fala com o MiniStack através de um
 * proxy TCP, e o teste derruba o proxy (conexão recusada) e depois o religa na mesma porta.
 * As mensagens são publicadas direto no MiniStack durante a queda, como faria um provedor.
 */
let db: TestDatabase | undefined;
let queues: TestQueues | undefined;
let proxy: TcpProxy | undefined;
let app: TestApp | undefined;

afterEach(async () => {
  await app?.close();
  proxy?.stop();
  await queues?.destroy();
  await db?.drop();
  app = proxy = queues = db = undefined;
});

function transactionMessage(wallet: SeededWallet, amount: string) {
  const externalTransactionId = `tx-${Bun.randomUUIDv7()}`;
  return {
    messageId: `msg-${Bun.randomUUIDv7()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
  };
}

describe('consumidor com o SQS fora do ar', () => {
  test('o laço sobrevive, /health/ready responde 503 e, com o SQS de volta, cada mensagem é processada uma vez', async () => {
    db = await createTestDatabase();
    queues = await createTestQueues();
    const { client, urls } = queues;
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    proxy = TcpProxy.start(testInfra.sqsEndpoint);
    app = await startTestApp(
      buildTestConfig({
        databaseUrl: db.url,
        queues: queues.names,
        overrides: {
          SQS_ENDPOINT: proxy.url,
          RUN_CONSUMER: 'true',
          RUN_PENDING_REFERENCE_WORKER: 'false',
          CONSUMER_WAIT_TIME_S: '1',
        },
      }),
    );
    const api = httpClient(app.baseUrl);
    const send = (message: ReturnType<typeof transactionMessage>) =>
      sendRaw(client, urls.transactions, JSON.stringify(message), {
        groupId: wallet.walletId,
        deduplicationId: message.messageId,
      });
    const drained = () =>
      eventually(async () => expect(await queueDepth(client, urls.transactions)).toEqual({ visible: 0, inFlight: 0 }), {
        timeout: 20_000,
        interval: 200,
      });

    // Antes da queda: o caminho pelo proxy funciona.
    const before = transactionMessage(wallet, '10.00');
    await send(before);
    await drained();
    expect((await api.get('/health/ready')).status).toBe(200);

    proxy.cut();
    await eventually(async () => {
      const ready = await api.get('/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.checks).toMatchObject({ postgres: { status: 'up' }, sqs: { status: 'down' } });
    });
    expect((await api.get('/health/live')).status).toBe(200);
    // O long polling que já estava no MiniStack quando o proxy caiu ainda espera até
    // CONSUMER_WAIT_TIME_S (1 s). Se uma mensagem chegasse nessa janela, o broker a entregaria
    // para a conexão morta e ela ficaria invisível até o visibility timeout (at-least-once, mas
    // não é o que este teste mede). Espera essa rodada expirar antes de publicar.
    await Bun.sleep(1_500);

    const during = [transactionMessage(wallet, '5.00'), transactionMessage(wallet, '15.00')];
    for (const message of during) await send(message);
    // Várias rodadas de polling falham (conexão recusada + pausa de 1 s) sem derrubar o laço;
    // nada sai da fila enquanto o consumidor não alcança o broker.
    await Bun.sleep(3_000);
    expect(await queueDepth(client, urls.transactions)).toEqual({ visible: 2, inFlight: 0 });

    proxy.restore();
    // A mesma instância (sem restart) volta a consumir.
    await drained();
    await eventually(async () => expect((await api.get('/health/ready')).status).toBe(200));

    const rows = await db.sql`
      SELECT external_transaction_id, status, resulting_balance::text AS balance
        FROM wager_transactions WHERE provider_id <> 'internal' ORDER BY created_at`;
    expect(rows).toEqual([
      { external_transaction_id: before.data.externalTransactionId, status: 'PROCESSED', balance: '90.00' },
      { external_transaction_id: during[0]!.data.externalTransactionId, status: 'PROCESSED', balance: '85.00' },
      { external_transaction_id: during[1]!.data.externalTransactionId, status: 'PROCESSED', balance: '70.00' },
    ]);
    const [{ inbox }] = await db.sql`SELECT count(*)::int AS inbox FROM inbox_messages WHERE processed_at IS NOT NULL`;
    expect(inbox).toBe(3);
    const [{ balance }] = await db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.walletId}`;
    expect(balance).toBe('70.00');
    await assertWalletMatchesLedger(db.sql, wallet.walletId);
    expect(await expectQueueEmpty(client, urls.dlq)).toEqual([]);
  }, 60_000);
});
