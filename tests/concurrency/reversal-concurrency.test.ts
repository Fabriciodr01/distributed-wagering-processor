import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger';
import { httpClient } from '../support/http';
import { startTestApp, type TestApp } from '../support/test-app';
import { buildTestConfig } from '../support/test-config';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { wageringApi } from '../support/wagering-api';

const QUEUES = { transactions: 'unused-tx.fifo', dlq: 'unused-dlq.fifo', events: 'unused-events.fifo' };
const brl = (amount: string) => ({ amount, currency: 'BRL' });

let db: TestDatabase;
let app: TestApp;
let wagering: ReturnType<typeof wageringApi>;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(buildTestConfig({ databaseUrl: db.url, queues: QUEUES }));
  wagering = wageringApi(httpClient(app.baseUrl));
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe('reversões concorrentes da mesma referência', () => {
  test.each([
    ['dois REFUND', ['REFUND', 'REFUND']],
    ['REFUND e ROLLBACK', ['REFUND', 'ROLLBACK']],
    ['dez reversões misturadas', Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 'REFUND' : 'ROLLBACK'))],
  ])('%s em paralelo: exatamente uma é aplicada', async (_, kinds) => {
    const wallet = await wagering.createWallet('100.00');
    const bet = wagering.transaction(wallet, { money: brl('40.00') });
    await wagering.submit(bet);

    const results = await Promise.all(
      kinds.map((kind) =>
        wagering.submit(
          wagering.transaction(wallet, {
            kind,
            referenceExternalTransactionId: bet.externalTransactionId,
            money: bet.money,
            roundId: bet.roundId,
          }),
        ),
      ),
    );

    const processed = results.filter((res) => res.body.status === 'PROCESSED');
    expect(processed).toHaveLength(1);
    const rejected = results.filter((res) => res.body.status === 'REJECTED');
    expect(rejected).toHaveLength(kinds.length - 1);
    expect(rejected.every((res) => res.body.failureCode === 'REFERENCE_ALREADY_REVERSED')).toBe(true);

    const [{ balance }] = await db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.id}`;
    expect(balance).toBe('100.00');
    const [{ credits }] = await db.sql`
      SELECT count(*)::int AS credits FROM wallet_ledger_entries
       WHERE wallet_id = ${wallet.id} AND direction = 'CREDIT'`;
    expect(credits).toBe(2);
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });
});
