import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProcessWagerTransactionUseCase } from '../../../src/application/wagering/process-wager-transaction.usecase';
import { PendingReferenceClaims } from '../../../src/infrastructure/persistence/pending-reference-claims';
import { PendingReferenceWorker } from '../../../src/infrastructure/workers/pending-reference.worker';
import { assertWalletMatchesLedger } from '../../support/assert-wallet-matches-ledger';
import { eventually } from '../../support/eventually';
import { httpClient } from '../../support/http';
import { startTestApp, type TestApp } from '../../support/test-app';
import { buildTestConfig } from '../../support/test-config';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { type CreatedWallet, type TransactionBody, wageringApi } from '../../support/wagering-api';

const QUEUES = { transactions: 'unused-tx.fifo', dlq: 'unused-dlq.fifo', events: 'unused-events.fifo' };
const brl = (amount: string) => ({ amount, currency: 'BRL' });

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

async function startApp(overrides: Record<string, string> = {}) {
  const app = await startTestApp(buildTestConfig({ databaseUrl: db.url, queues: QUEUES, overrides }));
  return { app, wagering: wageringApi(httpClient(app.baseUrl)) };
}

async function transactionRow(id: string) {
  const [row] = await db.sql`
    SELECT status, failure_code, attempts, reference_transaction_id, lease_until,
           resulting_balance::text AS balance,
           (extract(epoch FROM (next_attempt_at - now())) * 1000)::int AS due_in_ms
      FROM wager_transactions WHERE id = ${id}`;
  return row;
}

async function eventTypes(transactionId: string): Promise<string[]> {
  const rows = await db.sql`
    SELECT event_type FROM outbox_messages WHERE payload ->> 'causationId' = ${transactionId} ORDER BY seq`;
  return rows.map((row: { event_type: string }) => row.event_type);
}

async function balanceOf(walletId: string): Promise<string> {
  const [{ balance }] = await db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${walletId}`;
  return balance;
}

const reversalOf = (kind: 'REFUND' | 'ROLLBACK', reference: TransactionBody): Partial<TransactionBody> => ({
  kind,
  referenceExternalTransactionId: reference.externalTransactionId,
  money: reference.money,
  roundId: reference.roundId,
});

describe('worker de PENDING_REFERENCE em execução', () => {
  let running: TestApp;
  let wagering: ReturnType<typeof wageringApi>;

  beforeAll(async () => {
    ({ app: running, wagering } = await startApp());
  });

  afterAll(async () => {
    await running?.close();
  });

  test('REFUND chega antes da BET: fica pendente e é aplicado quando a BET chega', async () => {
    const wallet = await wagering.createWallet('100.00');
    const bet = wagering.transaction(wallet, { money: brl('30.00') });
    const refundBody = wagering.transaction(wallet, reversalOf('REFUND', bet));
    const refund = await wagering.submit(refundBody);
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe('PENDING_REFERENCE');

    const betRes = await wagering.submit(bet);
    expect(betRes.body.balance).toEqual(brl('70.00'));

    await eventually(async () => expect((await transactionRow(refund.body.transactionId)).status).toBe('PROCESSED'));
    const row = await transactionRow(refund.body.transactionId);
    expect(row.reference_transaction_id).toBe(betRes.body.transactionId);
    expect(row.balance).toBe('100.00');
    expect(row.lease_until).toBeNull();
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await eventTypes(refund.body.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    // O replay da submissão original agora devolve o resultado final, com o saldo da decisão.
    const replay = await wagering.submit(refundBody);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      transactionId: refund.body.transactionId,
      status: 'PROCESSED',
      balance: brl('100.00'),
      idempotentReplay: true,
    });
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });

  test('ROLLBACK de WIN e WIN referenciando BET também esperam a referência', async () => {
    const wallet = await wagering.createWallet('100.00');
    const bet = wagering.transaction(wallet, { money: brl('10.00') });
    const win = wagering.transaction(wallet, {
      kind: 'WIN',
      money: brl('25.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const rollback = await wagering.submit(wagering.transaction(wallet, reversalOf('ROLLBACK', win)));
    const winRes = await wagering.submit(win);
    expect([rollback.status, winRes.status]).toEqual([202, 202]);

    await wagering.submit(bet);
    await eventually(async () => {
      expect((await transactionRow(winRes.body.transactionId)).status).toBe('PROCESSED');
      expect((await transactionRow(rollback.body.transactionId)).status).toBe('PROCESSED');
    });
    expect(await balanceOf(wallet.id)).toBe('90.00');
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });

  test('referência que chega recusada encerra a pendência com REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await wagering.createWallet('5.00');
    const bet = wagering.transaction(wallet, { money: brl('50.00') });
    const refund = await wagering.submit(wagering.transaction(wallet, reversalOf('REFUND', bet)));
    expect((await wagering.submit(bet)).status).toBe(422);

    await eventually(async () => {
      const row = await transactionRow(refund.body.transactionId);
      expect(row.status).toBe('REJECTED');
      expect(row.failure_code).toBe('REFERENCE_NOT_PROCESSED');
    });
    expect(await eventTypes(refund.body.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await balanceOf(wallet.id)).toBe('5.00');
  });
});

describe('referência decidida acorda as dependentes', () => {
  // Backoff de 60 s: sem acordar, a pendência só seria reavaliada daqui a um minuto.
  const SLOW = { PENDING_REF_BASE_DELAY_MS: '60000', PENDING_REF_MAX_DELAY_MS: '60000', PENDING_REF_POLL_INTERVAL_MS: '100' };
  let running: TestApp;
  let wagering: ReturnType<typeof wageringApi>;

  beforeAll(async () => {
    ({ app: running, wagering } = await startApp(SLOW));
  });

  afterAll(async () => {
    await running?.close();
  });

  test('REFUND antes da BET: aplicado logo depois da BET, sem esperar o backoff', async () => {
    const wallet = await wagering.createWallet('100.00');
    const bet = wagering.transaction(wallet, { money: brl('30.00') });
    const refund = await wagering.submit(wagering.transaction(wallet, reversalOf('REFUND', bet)));
    expect(refund.status).toBe(202);
    const pending = await transactionRow(refund.body.transactionId);
    expect(pending.due_in_ms).toBeGreaterThan(50_000);

    const startedAt = Date.now();
    expect((await wagering.submit(bet)).status).toBe(200);
    // O commit da BET já deixou a dependente vencida; a próxima rodada do worker (100 ms) a aplica.
    expect((await transactionRow(refund.body.transactionId)).due_in_ms).toBeLessThanOrEqual(0);
    await eventually(async () => expect((await transactionRow(refund.body.transactionId)).status).toBe('PROCESSED'), {
      timeout: 2_000,
      interval: 50,
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });

  test('referência recusada: a dependente é encerrada logo com REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await wagering.createWallet('10.00');
    const bet = wagering.transaction(wallet, { money: brl('50.00') });
    const rollback = await wagering.submit(wagering.transaction(wallet, reversalOf('ROLLBACK', bet)));
    expect(rollback.status).toBe(202);

    expect((await wagering.submit(bet)).body.failureCode).toBe('INSUFFICIENT_FUNDS');
    await eventually(
      async () =>
        expect(await transactionRow(rollback.body.transactionId)).toMatchObject({
          status: 'REJECTED',
          failure_code: 'REFERENCE_NOT_PROCESSED',
        }),
      { timeout: 2_000, interval: 50 },
    );
    expect(await balanceOf(wallet.id)).toBe('10.00');
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });
});

describe('limite de tentativas', () => {
  test('referência que nunca chega: REJECTED REFERENCE_NOT_FOUND_EXPIRED com evento, sem lançamento', async () => {
    const { app, wagering } = await startApp({ PENDING_REF_MAX_ATTEMPTS: '3' });
    try {
      const wallet = await wagering.createWallet('100.00');
      const refund = await wagering.submit(
        wagering.transaction(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-que-nunca-chega' }),
      );
      expect(refund.status).toBe(202);

      await eventually(async () => expect((await transactionRow(refund.body.transactionId)).status).toBe('REJECTED'));
      const row = await transactionRow(refund.body.transactionId);
      expect(row.failure_code).toBe('REFERENCE_NOT_FOUND_EXPIRED');
      expect(row.attempts).toBe(3);
      expect(await eventTypes(refund.body.transactionId)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionRejected',
      ]);
      expect(await balanceOf(wallet.id)).toBe('100.00');
      await assertWalletMatchesLedger(db.sql, wallet.id);
    } finally {
      await app.close();
    }
  });
});

describe('controle manual do worker', () => {
  let manual: TestApp;
  let wagering: ReturnType<typeof wageringApi>;
  let worker: PendingReferenceWorker;
  let useCase: ProcessWagerTransactionUseCase;

  beforeAll(async () => {
    ({ app: manual, wagering } = await startApp({
      RUN_PENDING_REFERENCE_WORKER: 'false',
      PENDING_REF_BASE_DELAY_MS: '1000',
      PENDING_REF_MAX_DELAY_MS: '4000',
      PENDING_REF_MAX_ATTEMPTS: '5',
    }));
    worker = manual.app.get(PendingReferenceWorker);
    useCase = manual.app.get(ProcessWagerTransactionUseCase);
  });

  afterAll(async () => {
    await manual?.close();
  });

  async function pendingRefund(wallet: CreatedWallet): Promise<string> {
    const res = await wagering.submit(
      wagering.transaction(wallet, { kind: 'REFUND', referenceExternalTransactionId: `ausente-${Bun.randomUUIDv7()}` }),
    );
    expect(res.status).toBe(202);
    return res.body.transactionId;
  }

  const makeDue = (id: string) => db.sql`UPDATE wager_transactions SET next_attempt_at = now() WHERE id = ${id}`;

  test('backoff exponencial limitado, contado pelo relógio do banco', async () => {
    const wallet = await wagering.createWallet('10.00');
    const id = await pendingRefund(wallet);
    const first = await transactionRow(id);
    expect(first.attempts).toBe(1);
    expect(first.due_in_ms).toBeGreaterThan(500);
    expect(first.due_in_ms).toBeLessThanOrEqual(1000);

    // Só fica elegível quando vence.
    expect(await worker.runOnce()).toBe(0);

    const expectedDelays = [2000, 4000, 4000];
    for (const [index, delay] of expectedDelays.entries()) {
      await makeDue(id);
      expect(await worker.runOnce()).toBe(1);
      const row = await transactionRow(id);
      expect(row.status).toBe('PENDING_REFERENCE');
      expect(row.attempts).toBe(index + 2);
      expect(row.due_in_ms).toBeGreaterThan(delay - 500);
      expect(row.due_in_ms).toBeLessThanOrEqual(delay);
      expect(row.lease_until).toBeNull();
    }
    // A pendência não reemite o evento a cada tentativa.
    expect(await eventTypes(id)).toEqual(['WagerTransactionPendingReference']);
  });

  test('lotes reservados por instâncias concorrentes não se sobrepõem, e o lease segura a reserva', async () => {
    const wallet = await wagering.createWallet('10.00');
    const ids = await Promise.all(Array.from({ length: 10 }, () => pendingRefund(wallet)));
    await db.sql`UPDATE wager_transactions SET next_attempt_at = now() WHERE id IN ${db.sql(ids)}`;

    const claims = manual.app.get(PendingReferenceClaims);
    const [a, b] = await Promise.all([claims.claimDue(5, 60_000), claims.claimDue(5, 60_000)]);
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    expect(new Set([...a, ...b]).size).toBe(10);
    expect(await claims.claimDue(10, 60_000)).toEqual([]);

    // Lease vencido (instância que morreu): outra instância assume.
    await db.sql`UPDATE wager_transactions SET lease_until = now() - interval '1 second' WHERE id IN ${db.sql(ids)}`;
    expect((await claims.claimDue(20, 60_000)).sort()).toEqual([...ids].sort());
  });

  test('erro inesperado conta tentativa e, no limite, vira FAILED PERMANENT_PROCESSING_ERROR sem evento', async () => {
    const wallet = await wagering.createWallet('10.00');
    const id = await pendingRefund(wallet);
    for (let i = 0; i < 3; i += 1) expect(await useCase.recordReprocessFailure(id)).toBe('rescheduled');
    expect(await useCase.recordReprocessFailure(id)).toBe('failed');

    const row = await transactionRow(id);
    expect(row.status).toBe('FAILED');
    expect(row.failure_code).toBe('PERMANENT_PROCESSING_ERROR');
    expect(row.attempts).toBe(5);
    expect(await eventTypes(id)).toEqual(['WagerTransactionPendingReference']);
    expect(await useCase.recordReprocessFailure(id)).toBe('skipped');
  });

  test('reavaliar algo que já foi decidido não faz nada', async () => {
    const wallet = await wagering.createWallet('10.00');
    const bet = await wagering.submit(wagering.transaction(wallet, { money: brl('1.00') }));
    expect(await useCase.reprocessPendingReference(bet.body.transactionId)).toBe('skipped');
    expect(await useCase.reprocessPendingReference(Bun.randomUUIDv7())).toBe('skipped');
  });
});

describe('várias instâncias', () => {
  test('dois workers sobre as mesmas pendências aplicam cada reversão exatamente uma vez', async () => {
    const first = await startApp();
    const second = await startApp();
    try {
      const wallet = await first.wagering.createWallet('0.00');
      const bets = Array.from({ length: 20 }, () => first.wagering.transaction(wallet, { kind: 'WIN', money: brl('1.00') }));
      const rollbacks = await Promise.all(
        bets.map((bet, i) =>
          (i % 2 === 0 ? first : second).wagering.submit(first.wagering.transaction(wallet, reversalOf('ROLLBACK', bet))),
        ),
      );
      expect(rollbacks.every((res) => res.status === 202)).toBe(true);

      await Promise.all(bets.map((bet, i) => (i % 2 === 0 ? second : first).wagering.submit(bet)));
      await eventually(
        async () => {
          const [{ pending }] = await db.sql`
            SELECT count(*)::int AS pending FROM wager_transactions
             WHERE wallet_id = ${wallet.id} AND status = 'PENDING_REFERENCE'`;
          expect(pending).toBe(0);
        },
        { timeout: 20_000 },
      );

      const [{ processed }] = await db.sql`
        SELECT count(*)::int AS processed FROM wager_transactions
         WHERE wallet_id = ${wallet.id} AND kind = 'ROLLBACK' AND status = 'PROCESSED'`;
      expect(processed).toBe(20);
      expect(await balanceOf(wallet.id)).toBe('0.00');
      await assertWalletMatchesLedger(db.sql, wallet.id);
    } finally {
      await Promise.all([first.app.close(), second.app.close()]);
    }
  });
});
