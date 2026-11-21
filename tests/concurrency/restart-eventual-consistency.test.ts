import { afterEach, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger';
import { eventually } from '../support/eventually';
import { httpClient } from '../support/http';
import { metricValue } from '../support/log-capture';
import { type SpawnedInstance, spawnInstance } from '../support/spawn-instance';
import { bodyOf, receiveMessages } from '../support/sqs-helpers';
import { testEnvVars } from '../support/test-config';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, type TestQueues } from '../support/test-queues';
import { wageringApi } from '../support/wagering-api';

/**
 * Cenário obrigatório #8: reinício do serviço com prova de consistência eventual.
 * A instância A commita várias transações (uma delas aguardando referência) e morre com
 * SIGKILL antes de publicar qualquer evento e antes de reavaliar a pendência. A instância B,
 * que sobe depois, conclui tudo só a partir do que está no Postgres.
 */

const brl = (amount: string) => ({ amount, currency: 'BRL' });

let db: TestDatabase;
let queues: TestQueues;
const instances: SpawnedInstance[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.stop('SIGKILL')));
  await queues?.destroy();
  await db?.drop();
});

async function spawn(overrides: Record<string, string>): Promise<SpawnedInstance> {
  const instance = await spawnInstance(testEnvVars({ databaseUrl: db.url, queues: queues.names, overrides }), {
    waitForReady: true,
  });
  instances.push(instance);
  return instance;
}

describe('reinício do serviço', () => {
  test('commitado e não publicado + pendência em aberto: a instância nova publica tudo e aplica a pendência', async () => {
    db = await createTestDatabase();
    queues = await createTestQueues();

    // A: só HTTP. Publisher e worker desligados simulam "morreu antes de chegar lá".
    const a = await spawn({ RUN_OUTBOX_PUBLISHER: 'false', RUN_PENDING_REFERENCE_WORKER: 'false' });
    const api = wageringApi(httpClient(a.baseUrl));
    const wallet = await api.createWallet('100.00');

    const bet = api.transaction(wallet, { money: brl('10.00') });
    const win = api.transaction(wallet, { kind: 'WIN', money: brl('25.00') });
    const loss = api.transaction(wallet, {
      kind: 'LOSS',
      money: brl('0.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const laterBet = api.transaction(wallet, { money: brl('20.00') });
    const refund = api.transaction(wallet, {
      kind: 'REFUND',
      money: laterBet.money,
      referenceExternalTransactionId: laterBet.externalTransactionId,
    });

    expect((await api.submit(bet)).status).toBe(200);
    expect((await api.submit(win)).status).toBe(200);
    expect((await api.submit(loss)).status).toBe(200);
    const pending = await api.submit(refund);
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');
    expect((await api.submit(laterBet)).status).toBe(200);

    // Sem shutdown gracioso.
    await a.stop('SIGKILL');
    expect(a.process.signalCode).toBe('SIGKILL');

    const [refundRow] = await db.sql`SELECT status FROM wager_transactions WHERE id = ${pending.body.transactionId}`;
    expect(refundRow.status).toBe('PENDING_REFERENCE');
    const [{ unpublished }] = await db.sql`
      SELECT count(*)::int AS unpublished FROM outbox_messages WHERE published_at IS NULL`;
    // BET 2 + WIN 2 + LOSS 1 + REFUND pendente 1 + BET posterior 2.
    expect(unpublished).toBe(8);
    const [{ balance: beforeRestart }] = await db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.id}`;
    expect(beforeRestart).toBe('95.00');

    // B: publisher e worker ligados, nenhum estado herdado além do banco.
    const b = await spawn({
      RUN_OUTBOX_PUBLISHER: 'true',
      RUN_PENDING_REFERENCE_WORKER: 'true',
      PENDING_REF_BASE_DELAY_MS: '50',
      PENDING_REF_MAX_DELAY_MS: '400',
    });

    await eventually(
      async () => {
        const [row] = await db.sql`
          SELECT status, failure_code FROM wager_transactions WHERE id = ${pending.body.transactionId}`;
        expect(row).toEqual({ status: 'PROCESSED', failure_code: null });
        const [{ left }] = await db.sql`SELECT count(*)::int AS left FROM outbox_messages WHERE published_at IS NULL`;
        expect(left).toBe(0);
      },
      { timeout: 20_000, interval: 200 },
    );

    // Todo evento da outbox chega à fila de eventos (at-least-once: compara por eventId).
    const outboxRows: Array<{ id: string }> = await db.sql`SELECT id::text AS id FROM outbox_messages`;
    const outboxIds = new Set(outboxRows.map((row) => row.id));
    expect(outboxIds.size).toBe(10);
    const delivered = await receiveMessages(queues.client, queues.urls.events, { expected: outboxIds.size, timeoutMs: 15_000 });
    expect(new Set(delivered.map((message) => bodyOf<{ eventId: string }>(message).eventId))).toEqual(outboxIds);

    await eventually(async () => {
      const metrics = await (await fetch(`${b.baseUrl}/metrics`)).text();
      expect(metricValue(metrics, 'outbox_lag_seconds')).toBe(0);
    });

    const client = httpClient(b.baseUrl);
    const current = await client.get(`/wallets/${wallet.id}`);
    expect(current.body.balance).toEqual(brl('115.00'));
    const reconciliation = await client.post(`/wallets/${wallet.id}/reconciliation`);
    expect(reconciliation.body).toMatchObject({ consistent: true, checkedEntries: 5 });
    await assertWalletMatchesLedger(db.sql, wallet.id);
  }, 60_000);
});
