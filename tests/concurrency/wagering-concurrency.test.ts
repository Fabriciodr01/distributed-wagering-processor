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
  app = await startTestApp(
    buildTestConfig({ databaseUrl: db.url, queues: QUEUES, overrides: { DB_POOL_MAX: '20' } }),
  );
  wagering = wageringApi(httpClient(app.baseUrl));
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

async function ledgerDebits(walletId: string): Promise<number> {
  const [{ total }] = await db.sql`
    SELECT count(*)::int AS total FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = 'DEBIT'`;
  return total;
}

async function balanceOf(walletId: string): Promise<string> {
  const [{ balance }] = await db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${walletId}`;
  return balance;
}

describe('concorrência real no banco', () => {
  test('cenário obrigatório: 100.00 e duas apostas de 80.00 simultâneas', async () => {
    const wallet = await wagering.createWallet('100.00');
    const bets = [
      wagering.transaction(wallet, { money: brl('80.00') }),
      wagering.transaction(wallet, { money: brl('80.00') }),
    ];
    const results = await Promise.all(bets.map((bet) => wagering.submit(bet)));

    expect(results.map((res) => res.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((res) => res.body.status === 'REJECTED')!.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(wallet.id)).toBe('20.00');
    expect(await ledgerDebits(wallet.id)).toBe(1);

    // Retry do provedor (as duas de novo, em paralelo) devolve o mesmo resultado e não debita outra vez.
    const retries = await Promise.all(bets.map((bet) => wagering.submit(bet)));
    expect(retries.map((res) => res.body)).toEqual(results.map((res) => ({ ...res.body, idempotentReplay: true })));
    expect(await balanceOf(wallet.id)).toBe('20.00');
    expect(await ledgerDebits(wallet.id)).toBe(1);
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });

  test('a mesma aposta 50 vezes em paralelo gera um único débito', async () => {
    const wallet = await wagering.createWallet('100.00');
    const body = wagering.transaction(wallet, { money: brl('10.00') });
    const results = await Promise.all(Array.from({ length: 50 }, () => wagering.submit(body)));

    expect(results.every((res) => res.status === 200)).toBe(true);
    expect(new Set(results.map((res) => res.body.transactionId)).size).toBe(1);
    expect(results.filter((res) => res.body.idempotentReplay === false)).toHaveLength(1);
    expect(results.every((res) => res.body.balance.amount === '90.00')).toBe(true);
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(await ledgerDebits(wallet.id)).toBe(1);
    const [{ total }] = await db.sql`
      SELECT count(*)::int AS total FROM wager_transactions WHERE external_transaction_id = ${body.externalTransactionId}`;
    expect(total).toBe(1);
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });

  test('wallets distintas processadas em paralelo não interferem entre si', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => wagering.createWallet('50.00')));
    const results = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, () => wagering.submit(wagering.transaction(wallet, { money: brl('7.00') }))),
      ),
    );

    expect(results.every((res) => res.status === 200)).toBe(true);
    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe('15.00');
      expect(await ledgerDebits(wallet.id)).toBe(5);
      await assertWalletMatchesLedger(db.sql, wallet.id);
    }
  });

  test('hot wallet: 30 apostas pequenas simultâneas consomem o saldo exato, sem ficar negativo', async () => {
    const wallet = await wagering.createWallet('10.00');
    const results = await Promise.all(
      Array.from({ length: 30 }, () => wagering.submit(wagering.transaction(wallet, { money: brl('0.50') }))),
    );

    const processed = results.filter((res) => res.body.status === 'PROCESSED');
    const rejected = results.filter((res) => res.body.status === 'REJECTED');
    expect(processed).toHaveLength(20);
    expect(rejected).toHaveLength(10);
    expect(rejected.every((res) => res.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(await balanceOf(wallet.id)).toBe('0.00');
    expect(await ledgerDebits(wallet.id)).toBe(20);

    // O saldo observado de cada aposta aplicada é único: as 20 foram serializadas pelo lock.
    const observed = processed.map((res) => res.body.balance.amount);
    expect(new Set(observed).size).toBe(20);
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });

  test('créditos e débitos misturados na mesma wallet mantêm saldo igual ao ledger', async () => {
    const wallet = await wagering.createWallet('100.00');
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        wagering.submit(wagering.transaction(wallet, { kind: i % 2 === 0 ? 'BET' : 'WIN', money: brl('3.00') })),
      ),
    );
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });
});
