import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger';
import { eventually } from '../support/eventually';
import { type HttpResult, httpClient } from '../support/http';
import { metricValue } from '../support/log-capture';
import { type SpawnedInstance, spawnInstance } from '../support/spawn-instance';
import { bodyOf, queueDepth, receiveMessages, sendRaw } from '../support/sqs-helpers';
import { testEnvVars } from '../support/test-config';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, type TestQueues } from '../support/test-queues';
import { type CreatedWallet, wageringApi } from '../support/wagering-api';

/**
 * Cenário obrigatório #4: três processos da aplicação ao mesmo tempo, sobre o mesmo
 * Postgres e as mesmas filas. Cada instância roda todos os papéis (HTTP, consumidor,
 * publisher da outbox e worker de PENDING_REFERENCE), então os publishers também disputam.
 */

const INSTANCES = 3;
const brl = (amount: string) => ({ amount, currency: 'BRL' });

let db: TestDatabase;
let queues: TestQueues;
let instances: SpawnedInstance[] = [];
let clients: ReturnType<typeof wageringApi>[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues();
  const env = testEnvVars({
    databaseUrl: db.url,
    queues: queues.names,
    overrides: { RUN_CONSUMER: 'true', RUN_OUTBOX_PUBLISHER: 'true', DB_POOL_MAX: '10' },
  });
  // Sobem em paralelo: o teste também prova que o boot concorrente não atrapalha.
  instances = await Promise.all(
    Array.from({ length: INSTANCES }, () => spawnInstance(env, { waitForReady: true, timeout: 30_000 })),
  );
  clients = instances.map((instance) => wageringApi(httpClient(instance.baseUrl)));
}, 60_000);

afterAll(async () => {
  // SIGKILL mesmo se o teste falhou: nenhum processo fica órfão segurando conexões.
  await Promise.all(instances.map((instance) => instance.stop('SIGKILL')));
  await queues?.destroy();
  await db?.drop();
});

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

async function scrapeAll(): Promise<string[]> {
  return Promise.all(instances.map(async (instance) => (await fetch(`${instance.baseUrl}/metrics`)).text()));
}

async function sumMetric(name: string, labels: Record<string, string> = {}): Promise<number> {
  return (await scrapeAll()).reduce((total, exposition) => total + metricValue(exposition, name, labels), 0);
}

async function balanceOf(walletId: string): Promise<string> {
  const [{ balance }] = await db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${walletId}`;
  return balance;
}

async function debitsOf(walletId: string): Promise<number> {
  const [{ total }] = await db.sql`
    SELECT count(*)::int AS total FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = 'DEBIT'`;
  return total;
}

function describeFailures(responses: HttpResult<any>[]): string {
  const bad = responses.filter((res) => res.status >= 500);
  return `${bad.length} respostas 5xx: ${JSON.stringify(bad.slice(0, 3).map((res) => res.body))}\n${instances
    .map((instance) => instance.output().slice(-2000))
    .join('\n---\n')}`;
}

describe(`${INSTANCES} instâncias simultâneas (processos separados)`, () => {
  test('150 apostas de 1.00, cada uma enviada às 3 instâncias: 100 aplicadas, 50 recusadas, um efeito por aposta', async () => {
    const wallet = await clients[0]!.createWallet('100.00');
    const bets = Array.from({ length: 150 }, () => clients[0]!.transaction(wallet, { money: brl('1.00') }));

    // 450 requisições em ordem aleatória, todas em voo ao mesmo tempo.
    const sends = shuffle(
      bets.flatMap((bet, betIndex) => clients.map((client) => ({ betIndex, run: () => client.submit(bet) }))),
    );
    const responses = await Promise.all(sends.map(async ({ betIndex, run }) => ({ betIndex, res: await run() })));
    const all = responses.map(({ res }) => res);

    expect(all.filter((res) => res.status >= 500), describeFailures(all)).toHaveLength(0);

    const byBet = new Map<number, HttpResult<any>[]>();
    for (const { betIndex, res } of responses) byBet.set(betIndex, [...(byBet.get(betIndex) ?? []), res]);

    let processed = 0;
    let rejected = 0;
    for (const [, results] of byBet) {
      expect(results).toHaveLength(INSTANCES);
      // As três respostas descrevem a mesma transação, com o mesmo resultado.
      expect(new Set(results.map((res) => res.body.transactionId)).size).toBe(1);
      expect(new Set(results.map((res) => res.body.status)).size).toBe(1);
      expect(new Set(results.map((res) => res.status)).size).toBe(1);
      // Exatamente uma decidiu; as outras duas são replay.
      expect(results.filter((res) => res.body.idempotentReplay === false)).toHaveLength(1);
      const [first] = results;
      if (first!.body.status === 'PROCESSED') processed += 1;
      else {
        expect(first!.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
        rejected += 1;
      }
    }
    expect(processed).toBe(100);
    expect(rejected).toBe(50);

    expect(await balanceOf(wallet.id)).toBe('0.00');
    expect(await debitsOf(wallet.id)).toBe(100);
    const [{ rows }] = await db.sql`
      SELECT count(*)::int AS rows FROM wager_transactions WHERE wallet_id = ${wallet.id} AND kind = 'BET'`;
    expect(rows).toBe(150);

    const reconciliation = await httpClient(instances[2]!.baseUrl).post(`/wallets/${wallet.id}/reconciliation`);
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body.consistent).toBe(true);

    // Os três publishers disputam a mesma outbox: todo evento é publicado, nenhum se perde.
    const [{ events }] = await db.sql`
      SELECT count(*)::int AS events FROM outbox_messages WHERE aggregate_id = ${wallet.id}`;
    expect(events).toBe(100 * 2 + 50);
    await eventually(
      async () => {
        const [{ pending }] = await db.sql`
          SELECT count(*)::int AS pending FROM outbox_messages WHERE published_at IS NULL`;
        expect(pending).toBe(0);
      },
      { timeout: 20_000, interval: 200 },
    );
    const outboxRows: Array<{ id: string }> = await db.sql`
      SELECT id::text AS id FROM outbox_messages WHERE aggregate_id = ${wallet.id}`;
    const outboxIds = new Set(outboxRows.map((row) => row.id));
    const delivered = await receiveMessages(queues.client, queues.urls.events, { expected: events, timeoutMs: 30_000 });
    const deliveredIds = new Set(delivered.map((message) => bodyOf<{ eventId: string }>(message).eventId));
    expect(deliveredIds).toEqual(outboxIds);

    await assertWalletMatchesLedger(db.sql, wallet.id);
  }, 90_000);

  test('wallets distintas em paralelo, espalhadas pelas instâncias: saldo exato e igual ao ledger em cada uma', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, (_, i) => clients[i % INSTANCES]!.createWallet('50.00')),
    );
    const sends = wallets.flatMap((wallet, w) =>
      Array.from({ length: 20 }, (_, b) => {
        const client = clients[(w + b) % INSTANCES]!;
        return () => client.submit(client.transaction(wallet, { money: brl('2.00') }));
      }),
    );
    const responses = await Promise.all(shuffle(sends).map((run) => run()));

    expect(responses.filter((res) => res.status !== 200), describeFailures(responses)).toHaveLength(0);
    expect(responses.every((res) => res.body.status === 'PROCESSED')).toBe(true);
    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe('10.00');
      expect(await debitsOf(wallet.id)).toBe(20);
      await assertWalletMatchesLedger(db.sql, wallet.id);
    }
  }, 60_000);

  test('pela fila: 30 mensagens de 10 wallets + 10 redeliveries com o mesmo messageId, um efeito por messageId', async () => {
    const wallets: CreatedWallet[] = await Promise.all(
      Array.from({ length: 10 }, () => clients[0]!.createWallet('100.00')),
    );
    const duplicatesBefore = await sumMetric('wager_duplicates_total', { source: 'sqs' });

    const envelopes = wallets.flatMap((wallet) =>
      Array.from({ length: 3 }, () => {
        const externalTransactionId = `tx-${Bun.randomUUIDv7()}`;
        return {
          walletId: wallet.id,
          envelope: {
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
              money: brl('5.00'),
            },
          },
        };
      }),
    );

    const originals = envelopes.map(({ walletId, envelope }) =>
      sendRaw(queues.client, queues.urls.transactions, JSON.stringify(envelope), {
        groupId: walletId,
        deduplicationId: envelope.messageId,
      }),
    );
    // Redelivery: o mesmo envelope com outro id de deduplicação do SQS (o FIFO não a reconhece).
    // Grupo diferente de propósito: assim ela pode ser entregue a outra instância ao mesmo tempo
    // que a original, e só o inbox no Postgres impede o segundo efeito.
    const redeliveries = envelopes.slice(0, 10).map(({ walletId, envelope }) =>
      sendRaw(queues.client, queues.urls.transactions, JSON.stringify(envelope), {
        groupId: `redelivery-${walletId}`,
        deduplicationId: `${envelope.messageId}-again`,
      }),
    );
    await Promise.all([...originals, ...redeliveries]);

    await eventually(
      async () => expect(await queueDepth(queues.client, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 }),
      { timeout: 30_000, interval: 250 },
    );

    const messageIds = envelopes.map(({ envelope }) => envelope.messageId);
    const [{ inbox }] = await db.sql`
      SELECT count(*)::int AS inbox FROM inbox_messages
       WHERE message_id IN ${db.sql(messageIds)} AND processed_at IS NOT NULL`;
    expect(inbox).toBe(30);

    const externalIds = envelopes.map(({ envelope }) => envelope.data.externalTransactionId);
    const rows = await db.sql`
      SELECT external_transaction_id, status FROM wager_transactions WHERE external_transaction_id IN ${db.sql(externalIds)}`;
    expect(rows).toHaveLength(30);
    expect(rows.every((row: { status: string }) => row.status === 'PROCESSED')).toBe(true);

    for (const wallet of wallets) {
      expect(await debitsOf(wallet.id)).toBe(3);
      expect(await balanceOf(wallet.id)).toBe('85.00');
      await assertWalletMatchesLedger(db.sql, wallet.id);
    }

    // As 10 redeliveries foram reconhecidas pelo inbox (em qualquer uma das instâncias).
    await eventually(async () =>
      expect((await sumMetric('wager_duplicates_total', { source: 'sqs' })) - duplicatesBefore).toBe(10),
    );
    expect(await queueDepth(queues.client, queues.urls.dlq)).toEqual({ visible: 0, inFlight: 0 });
  }, 60_000);
});
