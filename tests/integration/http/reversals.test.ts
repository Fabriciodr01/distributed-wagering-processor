import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../../support/assert-wallet-matches-ledger';
import { httpClient } from '../../support/http';
import { startTestApp, type TestApp } from '../../support/test-app';
import { buildTestConfig } from '../../support/test-config';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { type CreatedWallet, type TransactionBody, wageringApi } from '../../support/wagering-api';

const QUEUES = { transactions: 'unused-tx.fifo', dlq: 'unused-dlq.fifo', events: 'unused-events.fifo' };
const brl = (amount: string) => ({ amount, currency: 'BRL' });

let db: TestDatabase;
let app: TestApp;
let wagering: ReturnType<typeof wageringApi>;

beforeAll(async () => {
  db = await createTestDatabase();
  // Sem worker: aqui só interessa a decisão síncrona da submissão.
  app = await startTestApp(
    buildTestConfig({ databaseUrl: db.url, queues: QUEUES, overrides: { RUN_PENDING_REFERENCE_WORKER: 'false' } }),
  );
  wagering = wageringApi(httpClient(app.baseUrl));
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

/** Submete e exige o status HTTP esperado; devolve o corpo enviado e a resposta. */
async function apply(wallet: CreatedWallet, overrides: Partial<TransactionBody>, expectedStatus = 200) {
  const body = wagering.transaction(wallet, overrides);
  const res = await wagering.submit(body);
  expect(res.status, JSON.stringify(res.body)).toBe(expectedStatus);
  return { body, res };
}

const reversal = (kind: 'REFUND' | 'ROLLBACK', reference: TransactionBody, overrides: Partial<TransactionBody> = {}) => ({
  kind,
  referenceExternalTransactionId: reference.externalTransactionId,
  money: reference.money,
  roundId: reference.roundId,
  ...overrides,
});

async function balanceOf(walletId: string): Promise<string> {
  const [{ balance }] = await db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${walletId}`;
  return balance;
}

async function ledgerCount(walletId: string): Promise<number> {
  const [{ total }] = await db.sql`SELECT count(*)::int AS total FROM wallet_ledger_entries WHERE wallet_id = ${walletId}`;
  return total;
}

describe('reversões aplicadas', () => {
  test('REFUND de BET credita o valor apostado e aponta para a referência', async () => {
    const wallet = await wagering.createWallet('100.00');
    const bet = await apply(wallet, { money: brl('30.00') });
    const refund = await apply(wallet, reversal('REFUND', bet.body));

    expect(refund.res.body.balance).toEqual(brl('100.00'));
    const [row] = await db.sql`SELECT reference_transaction_id FROM wager_transactions WHERE id = ${refund.res.body.transactionId}`;
    expect(row.reference_transaction_id).toBe(bet.res.body.transactionId);
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });

  test('ROLLBACK de BET credita, de WIN debita e de REFUND debita', async () => {
    const wallet = await wagering.createWallet('100.00');
    const bet = await apply(wallet, { money: brl('20.00') });
    await apply(wallet, reversal('ROLLBACK', bet.body));
    expect(await balanceOf(wallet.id)).toBe('100.00');

    const win = await apply(wallet, { kind: 'WIN', money: brl('15.00') });
    await apply(wallet, reversal('ROLLBACK', win.body));
    expect(await balanceOf(wallet.id)).toBe('100.00');

    const bet2 = await apply(wallet, { money: brl('10.00') });
    const refund = await apply(wallet, reversal('REFUND', bet2.body));
    await apply(wallet, reversal('ROLLBACK', refund.body));
    expect(await balanceOf(wallet.id)).toBe('90.00');
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });

  test('WIN pode referenciar a BET da mesma rodada', async () => {
    const wallet = await wagering.createWallet('100.00');
    const bet = await apply(wallet, { money: brl('10.00') });
    const win = await apply(wallet, {
      kind: 'WIN',
      money: brl('35.00'),
      referenceExternalTransactionId: bet.body.externalTransactionId,
    });
    expect(win.res.body.balance).toEqual(brl('125.00'));
  });
});

describe('reversões recusadas (422, auditáveis, sem lançamento)', () => {
  async function expectRejected(wallet: CreatedWallet, overrides: Partial<TransactionBody>, failureCode: string) {
    const before = { balance: await balanceOf(wallet.id), entries: await ledgerCount(wallet.id) };
    const { res } = await apply(wallet, overrides, 422);
    expect(res.body.failureCode).toBe(failureCode);
    expect({ balance: await balanceOf(wallet.id), entries: await ledgerCount(wallet.id) }).toEqual(before);
    const [row] = await db.sql`SELECT status, failure_code FROM wager_transactions WHERE id = ${res.body.transactionId}`;
    expect(row).toEqual({ status: 'REJECTED', failure_code: failureCode });
    await assertWalletMatchesLedger(db.sql, wallet.id);
  }

  test('REFUND duplicado → REFERENCE_ALREADY_REVERSED', async () => {
    const wallet = await wagering.createWallet('100.00');
    const bet = await apply(wallet, { money: brl('30.00') });
    await apply(wallet, reversal('REFUND', bet.body));
    await expectRejected(wallet, reversal('REFUND', bet.body), 'REFERENCE_ALREADY_REVERSED');
  });

  test('ROLLBACK depois de REFUND da mesma BET → REFERENCE_ALREADY_REVERSED (sem crédito duplo)', async () => {
    const wallet = await wagering.createWallet('100.00');
    const bet = await apply(wallet, { money: brl('30.00') });
    await apply(wallet, reversal('REFUND', bet.body));
    await expectRejected(wallet, reversal('ROLLBACK', bet.body), 'REFERENCE_ALREADY_REVERSED');
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  test.each([
    ['ROLLBACK de LOSS', 'ROLLBACK', 'LOSS'],
    ['ROLLBACK de ROLLBACK', 'ROLLBACK', 'ROLLBACK'],
    ['REFUND de WIN', 'REFUND', 'WIN'],
    ['REFUND de REFUND', 'REFUND', 'REFUND'],
  ] as const)('%s → REFERENCE_KIND_NOT_ALLOWED', async (_, kind, referenceKind) => {
    const wallet = await wagering.createWallet('100.00');
    let reference: TransactionBody;
    if (referenceKind === 'LOSS' || referenceKind === 'WIN') {
      reference = (await apply(wallet, { kind: referenceKind, money: brl('10.00') })).body;
    } else {
      const bet = await apply(wallet, { money: brl('10.00') });
      const base = referenceKind === 'REFUND' ? 'REFUND' : 'ROLLBACK';
      reference = (await apply(wallet, reversal(base, bet.body))).body;
    }
    await expectRejected(wallet, reversal(kind, reference), 'REFERENCE_KIND_NOT_ALLOWED');
  });

  test('valor diferente da referência → AMOUNT_MISMATCH', async () => {
    const wallet = await wagering.createWallet('100.00');
    const bet = await apply(wallet, { money: brl('30.00') });
    await expectRejected(wallet, reversal('REFUND', bet.body, { money: brl('29.99') }), 'AMOUNT_MISMATCH');
  });

  test('rodada diferente → REFERENCE_MISMATCH', async () => {
    const wallet = await wagering.createWallet('100.00');
    const bet = await apply(wallet, { money: brl('30.00') });
    await expectRejected(wallet, reversal('REFUND', bet.body, { roundId: 'outra-rodada' }), 'REFERENCE_MISMATCH');
  });

  test('referência de outra wallet do mesmo provider → REFERENCE_MISMATCH', async () => {
    const owner = await wagering.createWallet('100.00');
    const other = await wagering.createWallet('100.00');
    const bet = await apply(owner, { money: brl('30.00') });
    await expectRejected(other, reversal('REFUND', bet.body), 'REFERENCE_MISMATCH');
  });

  test('moeda diferente da wallet → CURRENCY_MISMATCH', async () => {
    const wallet = await wagering.createWallet('100.00');
    const bet = await apply(wallet, { money: brl('30.00') });
    await expectRejected(
      wallet,
      reversal('REFUND', bet.body, { money: { amount: '30.00', currency: 'USD' } }),
      'CURRENCY_MISMATCH',
    );
  });

  test('referência recusada → REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await wagering.createWallet('10.00');
    const bet = await apply(wallet, { money: brl('50.00') }, 422);
    await expectRejected(wallet, reversal('REFUND', bet.body), 'REFERENCE_NOT_PROCESSED');
  });

  test('reversão que deixaria saldo negativo → REVERSAL_WOULD_OVERDRAW, distinto de saldo insuficiente', async () => {
    const wallet = await wagering.createWallet('100.00');
    const win = await apply(wallet, { kind: 'WIN', money: brl('50.00') });
    await apply(wallet, { money: brl('140.00') });
    expect(await balanceOf(wallet.id)).toBe('10.00');
    await expectRejected(wallet, reversal('ROLLBACK', win.body), 'REVERSAL_WOULD_OVERDRAW');
  });
});

describe('referência ainda ausente', () => {
  test('referência de outro provider não é encontrada: fica PENDING_REFERENCE', async () => {
    const wallet = await wagering.createWallet('100.00');
    const bet = await apply(wallet, { money: brl('30.00'), providerId: 'provider-a' });
    const { res } = await apply(wallet, reversal('REFUND', bet.body, { providerId: 'provider-b' }), 202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
    expect(await balanceOf(wallet.id)).toBe('70.00');
  });
});
