import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../../support/assert-wallet-matches-ledger';
import { type HttpClient, httpClient } from '../../support/http';
import { startTestApp, type TestApp } from '../../support/test-app';
import { buildTestConfig } from '../../support/test-config';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { type CreatedWallet, wageringApi } from '../../support/wagering-api';

const QUEUES = { transactions: 'unused-tx.fifo', dlq: 'unused-dlq.fifo', events: 'unused-events.fifo' };
const brl = (amount: string) => ({ amount, currency: 'BRL' });

let db: TestDatabase;
let app: TestApp;
let api: HttpClient;
let wagering: ReturnType<typeof wageringApi>;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(buildTestConfig({ databaseUrl: db.url, queues: QUEUES }));
  api = httpClient(app.baseUrl);
  wagering = wageringApi(api);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

async function walletState(walletId: string) {
  const [wallet] = await db.sql`SELECT balance::text AS balance, version FROM wallets WHERE id = ${walletId}`;
  const entries = await db.sql`
    SELECT direction, amount::text AS amount FROM wallet_ledger_entries WHERE wallet_id = ${walletId} ORDER BY seq`;
  return { balance: wallet.balance as string, version: wallet.version as number, entries };
}

async function eventsOf(transactionId: string): Promise<Array<{ type: string; payload: any }>> {
  const rows = await db.sql`
    SELECT event_type AS type, payload FROM outbox_messages
     WHERE payload ->> 'causationId' = ${transactionId} ORDER BY seq`;
  return rows;
}

describe('regras: BET, WIN, LOSS', () => {
  let wallet: CreatedWallet;

  beforeAll(async () => {
    wallet = await wagering.createWallet('100.00');
  });

  test('BET debita, gera um lançamento DEBIT e responde 200 com o saldo', async () => {
    const res = await wagering.submit(wagering.transaction(wallet, { money: brl('25.00') }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: brl('75.00'),
      idempotentReplay: false,
    });
    const state = await walletState(wallet.id);
    expect(state.balance).toBe('75.00');
    expect(state.version).toBe(2);
    expect(state.entries.at(-1)).toEqual({ direction: 'DEBIT', amount: '25.00' });
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });

  test('WIN credita', async () => {
    const before = await walletState(wallet.id);
    const res = await wagering.submit(wagering.transaction(wallet, { kind: 'WIN', money: brl('40.10') }));
    expect(res.status).toBe(200);
    const after = await walletState(wallet.id);
    expect(after.entries.at(-1)).toEqual({ direction: 'CREDIT', amount: '40.10' });
    expect(after.version).toBe(before.version + 1);
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });

  test.each(['10.00', '0.00'])('LOSS de %s não mexe no saldo nem no ledger e não muda a version', async (amount) => {
    const before = await walletState(wallet.id);
    const res = await wagering.submit(wagering.transaction(wallet, { kind: 'LOSS', money: brl(amount) }));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PROCESSED');
    expect(res.body.balance).toEqual(brl(before.balance));
    expect(await walletState(wallet.id)).toEqual(before);
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });

  test('BET sem saldo → 422 REJECTED INSUFFICIENT_FUNDS, persistida, sem lançamento', async () => {
    const before = await walletState(wallet.id);
    const body = wagering.transaction(wallet, { money: brl('1000.00') });
    const res = await wagering.submit(body);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl(before.balance),
      idempotentReplay: false,
    });
    expect(await walletState(wallet.id)).toEqual(before);
    const [row] = await db.sql`SELECT status, failure_code FROM wager_transactions WHERE id = ${res.body.transactionId}`;
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
  });

  test('moeda diferente da wallet → 422 CURRENCY_MISMATCH', async () => {
    const res = await wagering.submit(wagering.transaction(wallet, { money: { amount: '1.00', currency: 'USD' } }));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('CURRENCY_MISMATCH');
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });

  test('playerId diferente do dono da wallet → 422 PLAYER_WALLET_MISMATCH', async () => {
    const res = await wagering.submit(wagering.transaction(wallet, { playerId: Bun.randomUUIDv7() }));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('PLAYER_WALLET_MISMATCH');
  });

  test('wallet inexistente → 404 sem persistir nada', async () => {
    const body = wagering.transaction(wallet, { walletId: Bun.randomUUIDv7() });
    const res = await wagering.submit(body);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
    const rows = await db.sql`SELECT 1 FROM wager_transactions WHERE external_transaction_id = ${body.externalTransactionId}`;
    expect(rows).toHaveLength(0);
  });
});

describe('validação da submissão', () => {
  let wallet: CreatedWallet;

  beforeAll(async () => {
    wallet = await wagering.createWallet('100.00');
  });

  test('sem Idempotency-Key → 400', async () => {
    const res = await api.post('/wagering/transactions', wagering.transaction(wallet));
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('Idempotency-Key');
  });

  test('Idempotency-Key acima de 255 caracteres → 400', async () => {
    const res = await wagering.submit(wagering.transaction(wallet), 'k'.repeat(256));
    expect(res.status).toBe(400);
  });

  test.each([
    ['OPENING', { kind: 'OPENING' }],
    ['kind desconhecido', { kind: 'JACKPOT' }],
    ['REFUND sem referência', { kind: 'REFUND' }],
    ['ROLLBACK sem referência', { kind: 'ROLLBACK' }],
    ['BET com referência', { referenceExternalTransactionId: 'outra' }],
    ['BET de valor zero', { money: brl('0.00') }],
    ['valor com 3 casas', { money: brl('1.001') }],
    ['provider reservado', { providerId: 'internal' }],
    ['walletId que não é UUID', { walletId: 'abc' }],
    ['roundId vazio', { roundId: '' }],
  ])('%s → 400 VALIDATION_ERROR sem persistir', async (_, overrides) => {
    const body = wagering.transaction(wallet, overrides as never);
    const res = await wagering.submit(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const rows = await db.sql`SELECT 1 FROM wager_transactions WHERE external_transaction_id = ${body.externalTransactionId}`;
    expect(rows).toHaveLength(0);
  });
});

describe('idempotência', () => {
  test('replay devolve o resultado original, com o saldo daquele momento', async () => {
    const wallet = await wagering.createWallet('100.00');
    const first = wagering.transaction(wallet, { money: brl('25.00') });
    const original = await wagering.submit(first);
    await wagering.submit(wagering.transaction(wallet, { money: brl('25.00') }));

    const replay = await wagering.submit(first);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual(brl('75.00'));

    const state = await walletState(wallet.id);
    expect(state.balance).toBe('50.00');
    expect(state.entries.filter((entry: { direction: string }) => entry.direction === 'DEBIT')).toHaveLength(2);
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });

  test('replay de uma rejeição devolve o mesmo 422', async () => {
    const wallet = await wagering.createWallet('1.00');
    const body = wagering.transaction(wallet, { money: brl('5.00') });
    const original = await wagering.submit(body);
    const replay = await wagering.submit(body);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
  });

  test('mesma chave com payload diferente → 409 IDEMPOTENCY_KEY_CONFLICT, sem efeito', async () => {
    const wallet = await wagering.createWallet('100.00');
    const body = wagering.transaction(wallet, { money: brl('10.00') });
    await wagering.submit(body);
    const conflict = await wagering.submit({ ...body, money: brl('11.00') }, `${body.providerId}:${body.externalTransactionId}`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect((await walletState(wallet.id)).balance).toBe('90.00');
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });

  test('mesmo externalTransactionId com outra chave: payload igual é replay, diferente é 409', async () => {
    const wallet = await wagering.createWallet('100.00');
    const body = wagering.transaction(wallet, { money: brl('10.00') });
    const original = await wagering.submit(body, 'chave-1');

    const sameReplay = await wagering.submit(body, 'chave-2');
    expect(sameReplay.status).toBe(200);
    expect(sameReplay.body).toEqual({ ...original.body, idempotentReplay: true });

    const conflict = await wagering.submit({ ...body, money: brl('12.00') }, 'chave-3');
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
    expect((await walletState(wallet.id)).balance).toBe('90.00');
  });

  test('a mesma chave em providers diferentes são transações distintas', async () => {
    const wallet = await wagering.createWallet('100.00');
    const a = wagering.transaction(wallet, { providerId: 'provider-a', externalTransactionId: 'x-1' });
    const b = wagering.transaction(wallet, { providerId: 'provider-b', externalTransactionId: 'x-1' });
    expect((await wagering.submit(a, 'mesma-chave')).body.idempotentReplay).toBe(false);
    expect((await wagering.submit(b, 'mesma-chave')).body.idempotentReplay).toBe(false);
    expect((await walletState(wallet.id)).balance).toBe('50.00');
  });
});

describe('consultas', () => {
  test('por id interno e por (provider, externalTransactionId)', async () => {
    const wallet = await wagering.createWallet('100.00');
    const body = wagering.transaction(wallet, { money: brl('30.00') });
    const submitted = await wagering.submit(body);

    const expected = {
      transactionId: submitted.body.transactionId,
      providerId: 'provider-a',
      externalTransactionId: body.externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: 'BET',
      money: brl('30.00'),
      status: 'PROCESSED',
      balance: brl('70.00'),
      createdAt: expect.any(String),
      processedAt: expect.any(String),
    };
    const byId = await api.get(`/wagering/transactions/${submitted.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual(expected);

    const byExternal = await api.get(`/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byExternal.status).toBe(200);
    expect(byExternal.body).toEqual(expected);
  });

  test('inexistente → 404 TRANSACTION_NOT_FOUND', async () => {
    expect((await api.get(`/wagering/transactions/${Bun.randomUUIDv7()}`)).body.error.code).toBe('TRANSACTION_NOT_FOUND');
    const res = await api.get('/providers/provider-a/wagering/transactions/nao-existe');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TRANSACTION_NOT_FOUND');
  });
});

describe('outbox na mesma transação', () => {
  let wallet: CreatedWallet;

  beforeAll(async () => {
    wallet = await wagering.createWallet('100.00');
  });

  test('BET aplicada: WagerTransactionProcessed + WalletBalanceChanged', async () => {
    const res = await wagering.submit(wagering.transaction(wallet, { money: brl('20.00') }));
    const events = await eventsOf(res.body.transactionId);
    expect(events.map((event) => event.type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    const [processed, changed] = events;
    expect(processed!.payload).toMatchObject({
      eventType: 'WagerTransactionProcessed',
      version: 1,
      aggregateId: wallet.id,
      data: { transactionId: res.body.transactionId, status: 'PROCESSED', money: brl('20.00'), balance: brl('80.00') },
    });
    expect(changed!.payload.data).toMatchObject({
      direction: 'DEBIT',
      balanceBefore: brl('100.00'),
      balanceAfter: brl('80.00'),
      walletVersion: 2,
    });
  });

  test('LOSS gera só WagerTransactionProcessed; rejeição gera só WagerTransactionRejected', async () => {
    const loss = await wagering.submit(wagering.transaction(wallet, { kind: 'LOSS', money: brl('5.00') }));
    expect((await eventsOf(loss.body.transactionId)).map((event) => event.type)).toEqual(['WagerTransactionProcessed']);

    const rejected = await wagering.submit(wagering.transaction(wallet, { money: brl('999.00') }));
    const events = await eventsOf(rejected.body.transactionId);
    expect(events.map((event) => event.type)).toEqual(['WagerTransactionRejected']);
    expect(events[0]!.payload.data.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('replay e erro de requisição não geram eventos', async () => {
    const body = wagering.transaction(wallet, { money: brl('1.00') });
    const res = await wagering.submit(body);
    await wagering.submit(body);
    expect(await eventsOf(res.body.transactionId)).toHaveLength(2);

    const [{ before }] = await db.sql`SELECT count(*)::int AS before FROM outbox_messages`;
    await wagering.submit(wagering.transaction(wallet, { walletId: Bun.randomUUIDv7() }));
    await wagering.submit(wagering.transaction(wallet, { kind: 'REFUND' }));
    const [{ after }] = await db.sql`SELECT count(*)::int AS after FROM outbox_messages`;
    expect(after).toBe(before);
  });

  test('o correlationId do header chega aos eventos', async () => {
    const body = wagering.transaction(wallet, { money: brl('1.00') });
    const res = await api.post('/wagering/transactions', body, {
      'idempotency-key': `k-${body.externalTransactionId}`,
      'x-correlation-id': 'corr-abc-123',
    });
    const events = await eventsOf(res.body.transactionId);
    expect(events.every((event) => event.payload.correlationId === 'corr-abc-123')).toBe(true);
  });
});

describe('referências (fluxo básico)', () => {
  test('REFUND antes da BET → 202 PENDING_REFERENCE agendada para reavaliação', async () => {
    const wallet = await wagering.createWallet('100.00');
    const refund = wagering.transaction(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-ainda-nao-chegou' });
    const res = await wagering.submit(refund);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: brl('100.00'), idempotentReplay: false });
    const [row] = await db.sql`
      SELECT status, next_attempt_at > now() AS scheduled FROM wager_transactions WHERE id = ${res.body.transactionId}`;
    expect(row).toEqual({ status: 'PENDING_REFERENCE', scheduled: true });
    expect((await eventsOf(res.body.transactionId)).map((event) => event.type)).toEqual([
      'WagerTransactionPendingReference',
    ]);
    expect((await wagering.submit(refund)).status).toBe(202);
  });

  test('REFUND de BET aplicada credita; o segundo REFUND é REFERENCE_ALREADY_REVERSED', async () => {
    const wallet = await wagering.createWallet('100.00');
    const bet = wagering.transaction(wallet, { money: brl('30.00') });
    await wagering.submit(bet);
    const refund = (id: string) =>
      wagering.transaction(wallet, {
        kind: 'REFUND',
        externalTransactionId: id,
        referenceExternalTransactionId: bet.externalTransactionId,
        money: brl('30.00'),
      });

    const first = await wagering.submit(refund('refund-1'));
    expect(first.status).toBe(200);
    expect(first.body.balance).toEqual(brl('100.00'));

    const second = await wagering.submit(refund('refund-2'));
    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });
});
