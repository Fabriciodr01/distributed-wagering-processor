import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../../support/assert-wallet-matches-ledger';
import { type HttpClient, httpClient } from '../../support/http';
import { applyTransaction } from '../../support/sql-fixtures';
import { startTestApp, type TestApp } from '../../support/test-app';
import { buildTestConfig } from '../../support/test-config';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

// A API de wallets não usa SQS; os nomes só precisam passar na validação da config.
const QUEUES = { transactions: 'unused-tx.fifo', dlq: 'unused-dlq.fifo', events: 'unused-events.fifo' };

const uuid = () => Bun.randomUUIDv7();
const brl = (amount: string) => ({ amount, currency: 'BRL' });

let db: TestDatabase;
let app: TestApp;
let api: HttpClient;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(buildTestConfig({ databaseUrl: db.url, queues: QUEUES }));
  api = httpClient(app.baseUrl);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

async function createWallet(initial = '100.00', currency = 'BRL', playerId = uuid()) {
  const res = await api.post('/wallets', { playerId, initialBalance: { amount: initial, currency } });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
}

describe('POST /wallets', () => {
  test('saldo inicial > 0: 201, version 1, transação OPENING e um lançamento CREDIT na mesma transação', async () => {
    const playerId = uuid();
    const res = await api.post('/wallets', { playerId, initialBalance: brl('1000.00') });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      playerId,
      balance: brl('1000.00'),
      version: 1,
    });

    const transactions = await db.sql`
      SELECT kind, status, provider_id, amount::text AS amount, resulting_balance::text AS resulting
        FROM wager_transactions WHERE wallet_id = ${res.body.id}`;
    expect(transactions).toEqual([
      { kind: 'OPENING', status: 'PROCESSED', provider_id: 'internal', amount: '1000.00', resulting: '1000.00' },
    ]);
    const entries = await db.sql`
      SELECT direction, amount::text AS amount, balance_before::text AS before, balance_after::text AS after
        FROM wallet_ledger_entries WHERE wallet_id = ${res.body.id}`;
    expect(entries).toEqual([{ direction: 'CREDIT', amount: '1000.00', before: '0.00', after: '1000.00' }]);
    await assertWalletMatchesLedger(db.sql, res.body.id);
  });

  test('saldo inicial 0: sem transação e sem lançamento', async () => {
    const wallet = await createWallet('0.00');
    expect(wallet.balance).toEqual(brl('0.00'));
    expect(wallet.version).toBe(1);
    const [{ total }] = await db.sql`
      SELECT (SELECT count(*) FROM wager_transactions WHERE wallet_id = ${wallet.id})
           + (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = ${wallet.id}) AS total`;
    expect(Number(total)).toBe(0);
    await assertWalletMatchesLedger(db.sql, wallet.id);
  });

  test('wallet duplicada para o mesmo player + moeda → 409 WALLET_ALREADY_EXISTS; outra moeda é permitida', async () => {
    const playerId = uuid();
    await createWallet('10.00', 'BRL', playerId);
    const duplicate = await api.post('/wallets', { playerId, initialBalance: brl('5.00') });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('WALLET_ALREADY_EXISTS');
    await createWallet('5.00', 'USD', playerId);
  });

  test('criações simultâneas do mesmo player + moeda: exatamente uma vence', async () => {
    const playerId = uuid();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => api.post('/wallets', { playerId, initialBalance: brl('50.00') })),
    );
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([201, ...Array(9).fill(409)]);
    const [{ total }] = await db.sql`SELECT count(*)::int AS total FROM wallets WHERE player_id = ${playerId}`;
    expect(total).toBe(1);
  });

  test.each([
    ['sem playerId', { initialBalance: brl('1.00') }, 'playerId'],
    ['playerId que não é UUID', { playerId: 'abc', initialBalance: brl('1.00') }, 'playerId'],
    ['sem initialBalance', { playerId: uuid() }, 'initialBalance'],
    ['amount numérico', { playerId: uuid(), initialBalance: { amount: 10, currency: 'BRL' } }, 'initialBalance'],
    ['amount com 1 casa', { playerId: uuid(), initialBalance: brl('10.5') }, 'initialBalance'],
    ['amount negativo', { playerId: uuid(), initialBalance: brl('-1.00') }, 'initialBalance'],
    ['notação científica', { playerId: uuid(), initialBalance: brl('1e3') }, 'initialBalance'],
    ['moeda minúscula', { playerId: uuid(), initialBalance: { amount: '1.00', currency: 'brl' } }, 'initialBalance'],
  ])('payload inválido (%s) → 400 VALIDATION_ERROR sem persistir nada', async (_, body, field) => {
    const [{ before }] = await db.sql`SELECT count(*)::int AS before FROM wallets`;
    const res = await api.post('/wallets', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { field: string }) => d.field.split('.')[0])).toContain(field);
    const [{ after }] = await db.sql`SELECT count(*)::int AS after FROM wallets`;
    expect(after).toBe(before);
  });

  test('JSON malformado → 400 VALIDATION_ERROR', async () => {
    const res = await api.postRaw('/wallets', '{"playerId": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /wallets/:walletId', () => {
  test('devolve a wallet', async () => {
    const created = await createWallet('42.10');
    const res = await api.get(`/wallets/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created);
  });

  test('wallet inexistente → 404 WALLET_NOT_FOUND', async () => {
    const res = await api.get(`/wallets/${uuid()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  test('id que não é UUID → 400 VALIDATION_ERROR', async () => {
    const res = await api.get('/wallets/nao-e-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  type Page = { items: Array<{ id: string; direction: string; balanceAfter: { amount: string } }>; nextCursor: string | null };

  /** Wallet com abertura + N débitos de 1.00 (N + 1 lançamentos). */
  async function walletWithEntries(debits: number) {
    const created = await createWallet('1000.00');
    const seeded = { walletId: created.id, playerId: created.playerId, currency: 'BRL' };
    for (let i = 0; i < debits; i += 1) {
      await applyTransaction(db.sql, seeded, { direction: 'DEBIT', amount: '1.00' });
    }
    return seeded;
  }

  async function allPages(walletId: string, limit: number): Promise<{ ids: string[]; pages: number }> {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await api.get<Page>(`/wallets/${walletId}/ledger?${query}`);
      expect(res.status).toBe(200);
      ids.push(...res.body.items.map((item) => item.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor);
    return { ids, pages };
  }

  test('mais recente primeiro, com o formato de lançamento', async () => {
    const wallet = await walletWithEntries(2);
    const res = await api.get<Page>(`/wallets/${wallet.walletId}/ledger`);
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items.map((item) => item.balanceAfter.amount)).toEqual(['998.00', '999.00', '1000.00']);
    expect(res.body.items[2] as unknown).toEqual({
      id: expect.any(String),
      transactionId: expect.any(String),
      direction: 'CREDIT',
      money: brl('1000.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('1000.00'),
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  test('percorre todas as páginas sem repetir nem pular itens', async () => {
    const wallet = await walletWithEntries(9);
    const expected = (await db.sql`
      SELECT id FROM wallet_ledger_entries WHERE wallet_id = ${wallet.walletId} ORDER BY seq DESC`).map(
      (row: { id: string }) => row.id,
    );
    const { ids, pages } = await allPages(wallet.walletId, 3);
    expect(ids).toEqual(expected);
    expect(pages).toBe(4);
    // Página exata: a última cheia não deixa cursor para uma página vazia.
    expect((await allPages(wallet.walletId, 5)).pages).toBe(2);
  });

  test('cursor é estável sob inserções concorrentes', async () => {
    const wallet = await walletWithEntries(5);
    const first = await api.get<Page>(`/wallets/${wallet.walletId}/ledger?limit=3`);
    await applyTransaction(db.sql, wallet, { direction: 'DEBIT', amount: '1.00' });
    const second = await api.get<Page>(`/wallets/${wallet.walletId}/ledger?limit=3&cursor=${first.body.nextCursor}`);
    const seen = [...first.body.items, ...second.body.items].map((item) => item.id);
    expect(new Set(seen).size).toBe(6);
    expect(second.body.items.map((item) => item.balanceAfter.amount)).toEqual(['998.00', '999.00', '1000.00']);
    expect(second.body.nextCursor).toBeNull();
  });

  test('limit padrão é 50', async () => {
    const wallet = await walletWithEntries(55);
    const res = await api.get<Page>(`/wallets/${wallet.walletId}/ledger`);
    expect(res.body.items).toHaveLength(50);
    expect(res.body.nextCursor).not.toBeNull();
  });

  test.each([
    ['limit acima de 200', 'limit=201'],
    ['limit zero', 'limit=0'],
    ['limit não numérico', 'limit=abc'],
    ['limit fracionário', 'limit=1.5'],
    ['cursor malformado', 'cursor=%25%25%25'],
    ['cursor com conteúdo inválido', `cursor=${Buffer.from('v1:abc').toString('base64url')}`],
    ['cursor de outro formato', `cursor=${Buffer.from('42').toString('base64url')}`],
  ])('%s → 400 VALIDATION_ERROR', async (_, query) => {
    const wallet = await createWallet('1.00');
    const res = await api.get(`/wallets/${wallet.id}/ledger?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('wallet inexistente → 404', async () => {
    const res = await api.get(`/wallets/${uuid()}/ledger`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });
});

describe('formato de erro', () => {
  test('rota inexistente → 404 NOT_FOUND no formato padrão', async () => {
    const res = await api.get('/nao-existe');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });

  test('Postgres inalcançável → 503 SERVICE_UNAVAILABLE com Retry-After', async () => {
    const offline = await startTestApp(
      buildTestConfig({ databaseUrl: 'postgres://wager:wager@127.0.0.1:1/wager', queues: QUEUES }),
    );
    try {
      const res = await httpClient(offline.baseUrl).post('/wallets', { playerId: uuid(), initialBalance: brl('1.00') });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.headers.get('retry-after')).toBe('1');
    } finally {
      await offline.close();
    }
  });
});
