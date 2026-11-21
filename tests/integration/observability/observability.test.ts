import { afterEach, describe, expect, test } from 'bun:test';
import { eventually } from '../../support/eventually';
import { httpClient } from '../../support/http';
import { logEntries, metricValue } from '../../support/log-capture';
import { type SpawnedInstance, spawnInstance } from '../../support/spawn-instance';
import { type SeededWallet, seedWallet } from '../../support/sql-fixtures';
import { queueDepth, sendRaw } from '../../support/sqs-helpers';
import { startTestApp, type TestApp } from '../../support/test-app';
import { buildTestConfig, testEnvVars } from '../../support/test-config';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { createTestQueues, type TestQueues } from '../../support/test-queues';
import { wageringApi } from '../../support/wagering-api';

const brl = (amount: string) => ({ amount, currency: 'BRL' });

let db: TestDatabase;
let queues: TestQueues;
const apps: TestApp[] = [];
const instances: SpawnedInstance[] = [];

async function prepare(): Promise<void> {
  db = await createTestDatabase();
  queues = await createTestQueues();
}

/** App no mesmo processo: para métricas e respostas HTTP. */
async function setup(overrides: Record<string, string> = {}) {
  await prepare();
  const app = await startTestApp(buildTestConfig({ databaseUrl: db.url, queues: queues.names, overrides }));
  apps.push(app);
  const api = httpClient(app.baseUrl);
  return { baseUrl: app.baseUrl, api, wagering: wageringApi(api) };
}

/** Instância em processo próprio, como em produção: a saída dela é o log real em JSON. */
async function setupSpawned(overrides: Record<string, string> = {}) {
  await prepare();
  const instance = await spawnInstance(
    testEnvVars({ databaseUrl: db.url, queues: queues.names, overrides: { LOG_LEVEL: 'info', ...overrides } }),
  );
  instances.push(instance);
  const api = httpClient(instance.baseUrl);
  return { instance, api, wagering: wageringApi(api) };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(instances.splice(0).map((instance) => instance.stop('SIGKILL')));
  await queues?.destroy();
  await db?.drop();
});

async function scrape(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/metrics`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/plain');
  return res.text();
}

/** Altera o saldo por fora, desligando os triggers (só o superuser de teste consegue). */
async function forceBalance(walletId: string, balance: string): Promise<void> {
  await db.sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`UPDATE wallets SET balance = ${balance} WHERE id = ${walletId}`;
  });
}

describe('reconciliação', () => {
  test('wallet consistente: calcula pelo ledger no mesmo snapshot', async () => {
    const { api, wagering } = await setup();
    const wallet = await wagering.createWallet('100.00');
    await wagering.submit(wagering.transaction(wallet, { money: brl('30.00') }));
    await wagering.submit(wagering.transaction(wallet, { kind: 'WIN', money: brl('5.25') }));

    const res = await api.post(`/wallets/${wallet.id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: wallet.id,
      storedBalance: brl('75.25'),
      calculatedBalance: brl('75.25'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 3,
    });
  });

  test('divergência forçada no banco: sinalizada, logada sem valores, contada, e o saldo não é corrigido', async () => {
    const { instance, api, wagering } = await setupSpawned();
    const wallet = await wagering.createWallet('100.00');
    await wagering.submit(wagering.transaction(wallet, { money: brl('40.00') }));
    await forceBalance(wallet.id, '70.00');

    try {
      const res = await api.post(`/wallets/${wallet.id}/reconciliation`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        storedBalance: brl('70.00'),
        calculatedBalance: brl('60.00'),
        difference: brl('10.00'),
        consistent: false,
        checkedEntries: 2,
      });

      const [{ balance }] = await db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.id}`;
      expect(balance).toBe('70.00');
      expect(metricValue(await scrape(instance.baseUrl), 'wallet_reconciliation_divergences_total')).toBe(1);

      const alert = await eventually(() => {
        const found = logEntries(instance.output()).find((e) => e.walletId === wallet.id && e.level === 50);
        if (!found) throw new Error('alerta ainda não apareceu');
        return found;
      });
      expect(alert).toMatchObject({ checkedEntries: 2, msg: expect.stringContaining('diverge') });
      expect(JSON.stringify(alert)).not.toContain('70.00');
    } finally {
      // Desfaz a divergência para a invariante de fim de suíte (ela também a pegaria).
      await forceBalance(wallet.id, '60.00');
    }
  });

  test('saldo abaixo do ledger aparece como diferença negativa', async () => {
    const { api, wagering } = await setup();
    const wallet = await wagering.createWallet('50.00');
    await forceBalance(wallet.id, '45.50');
    try {
      const res = await api.post(`/wallets/${wallet.id}/reconciliation`);
      expect(res.body.difference).toEqual(brl('-4.50'));
    } finally {
      await forceBalance(wallet.id, '50.00');
    }
  });

  test('wallet inexistente → 404; id inválido → 400', async () => {
    const { api } = await setup();
    expect((await api.post(`/wallets/${Bun.randomUUIDv7()}/reconciliation`)).status).toBe(404);
    expect((await api.post('/wallets/abc/reconciliation')).status).toBe(400);
  });
});

describe('logs estruturados', () => {
  function messageFor(wallet: SeededWallet) {
    const externalTransactionId = `tx-${Bun.randomUUIDv7()}`;
    return {
      messageId: `msg-${Bun.randomUUIDv7()}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-log',
        externalTransactionId,
        idempotencyKey: `provider-log:${externalTransactionId}`,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '37.89', currency: 'BRL' },
      },
    };
  }

  test('a linha de uma transação da fila tem os 5 ids e nenhum valor financeiro', async () => {
    const { instance } = await setupSpawned({ RUN_CONSUMER: 'true' });
    const wallet = await seedWallet(db.sql, { balance: '512.34' });
    const message = messageFor(wallet);
    await sendRaw(queues.client, queues.urls.transactions, JSON.stringify(message), {
      groupId: wallet.walletId,
      deduplicationId: message.messageId,
    });

    const line = await eventually(
      () => {
        const found = logEntries(instance.output()).find((entry) => entry.msg === 'Mensagem processada');
        if (!found) throw new Error('linha ainda não apareceu');
        return found;
      },
      { timeout: 15_000 },
    );
    const [tx] = await db.sql`
      SELECT id FROM wager_transactions WHERE external_transaction_id = ${message.data.externalTransactionId}`;
    expect(line).toMatchObject({
      level: 30,
      correlationId: message.messageId,
      messageId: message.messageId,
      transactionId: tx.id,
      walletId: wallet.walletId,
      providerId: 'provider-log',
      status: 'PROCESSED',
    });

    await eventually(async () =>
      expect(await queueDepth(queues.client, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 }),
    );
    const everything = instance.output();
    for (const forbidden of ['37.89', '512.34', '474.45', '"amount"', '"money"', '"balance"']) {
      expect(everything).not.toContain(forbidden);
    }
  });

  test('na API, o X-Correlation-Id recebido identifica a linha e volta no response', async () => {
    const { instance, api, wagering } = await setupSpawned();
    const wallet = await wagering.createWallet('100.00');
    const body = wagering.transaction(wallet, { money: brl('12.34') });
    const res = await api.post('/wagering/transactions', body, {
      'idempotency-key': `k-${body.externalTransactionId}`,
      'x-correlation-id': 'corr-observabilidade-1',
    });
    expect(res.headers.get('x-correlation-id')).toBe('corr-observabilidade-1');

    const line = await eventually(() => {
      const found = logEntries(instance.output()).find((entry) => entry.msg === 'Transação recebida pela API');
      if (!found) throw new Error('linha ainda não apareceu');
      return found;
    });
    expect(line).toMatchObject({
      correlationId: 'corr-observabilidade-1',
      transactionId: res.body.transactionId,
      walletId: wallet.id,
      providerId: 'provider-a',
    });
    expect(instance.output()).not.toContain('12.34');

    const generated = await api.get(`/wallets/${wallet.id}`);
    expect(generated.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('métricas', () => {
  test('/metrics expõe todas as métricas da D-16', async () => {
    const { baseUrl } = await setup();
    const exposition = await scrape(baseUrl);
    for (const name of [
      'wager_transactions_total',
      'wager_duplicates_total',
      'wager_retries_total',
      'wager_dlq_messages_total',
      'wager_lock_conflicts_total',
      'outbox_lag_seconds',
      'wager_processing_duration_seconds',
      'wallet_reconciliation_divergences_total',
    ]) {
      expect(exposition).toContain(`# TYPE ${name}`);
    }
  });

  test('as métricas se movem com os cenários: status, duplicata, DLQ, retry, lock, lag e latência', async () => {
    const { baseUrl, api, wagering } = await setup({
      RUN_CONSUMER: 'true',
      DB_LOCK_TIMEOUT_MS: '200',
      PENDING_REF_MAX_ATTEMPTS: '5',
    });
    const wallet = await wagering.createWallet('10.00');

    // Status por tipo + duplicata (replay HTTP).
    const bet = wagering.transaction(wallet, { money: brl('4.00') });
    await wagering.submit(bet);
    await wagering.submit(bet);
    await wagering.submit(wagering.transaction(wallet, { money: brl('99.00') }));

    // Retry do worker de PENDING_REFERENCE.
    await wagering.submit(wagering.transaction(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'nunca' }));

    // DLQ por mensagem inválida.
    await sendRaw(queues.client, queues.urls.transactions, '{ quebrado', { groupId: wallet.id, deduplicationId: 'dlq-1' });

    // Conflito de lock: a wallet travada por fora faz a submissão estourar o lock_timeout (503).
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      locked();
      await held;
    });
    await lockTaken;
    const blocked = await wagering.submit(wagering.transaction(wallet, { money: brl('1.00') }));
    release();
    await holder;
    expect(blocked.status).toBe(503);

    await eventually(
      async () => {
        const exposition = await scrape(baseUrl);
        expect(metricValue(exposition, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(1);
        expect(metricValue(exposition, 'wager_transactions_total', { status: 'REJECTED', kind: 'BET' })).toBe(1);
        expect(metricValue(exposition, 'wager_duplicates_total', { source: 'http' })).toBe(1);
        expect(metricValue(exposition, 'wager_dlq_messages_total', { reason: 'invalid_message' })).toBe(1);
        expect(metricValue(exposition, 'wager_lock_conflicts_total', { type: 'lock_timeout' })).toBe(1);
        expect(metricValue(exposition, 'wager_retries_total', { type: 'pending_reference' })).toBeGreaterThan(0);
        expect(metricValue(exposition, 'wager_processing_duration_seconds_count', { source: 'http' })).toBe(4);
        // Publisher desligado: os eventos esperam na outbox e o lag cresce.
        expect(metricValue(exposition, 'outbox_lag_seconds')).toBeGreaterThan(0);
      },
      { timeout: 15_000, interval: 200 },
    );
    expect((await api.get(`/wallets/${wallet.id}`)).body.balance).toEqual(brl('6.00'));
  });
});
