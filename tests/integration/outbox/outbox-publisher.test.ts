import { afterEach, describe, expect, test } from 'bun:test';
import { CreateQueueCommand, DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { CLOCK, type Clock } from '../../../src/application/ports/clock.port';
import { ID_GENERATOR, type IdGenerator } from '../../../src/application/ports/id-generator.port';
import { OUTBOX_STORE, type OutboxStore } from '../../../src/application/ports/outbox.port';
import { TELEMETRY, type Telemetry } from '../../../src/application/ports/telemetry.port';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../src/application/ports/unit-of-work.port';
import { ProcessWagerTransactionUseCase } from '../../../src/application/wagering/process-wager-transaction.usecase';
import { Money } from '../../../src/domain/money';
import { WagerTransactionKind } from '../../../src/domain/wager-transaction';
import { OutboxPublisherWorker } from '../../../src/infrastructure/workers/outbox-publisher.worker';
import { assertWalletMatchesLedger } from '../../support/assert-wallet-matches-ledger';
import { httpClient } from '../../support/http';
import { bodyOf, expectQueueEmpty, receiveMessages } from '../../support/sqs-helpers';
import { startTestApp, type TestApp } from '../../support/test-app';
import { buildTestConfig } from '../../support/test-config';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { uniqueSuffix } from '../../support/test-env';
import { createTestQueues, type TestQueues } from '../../support/test-queues';
import { wageringApi } from '../../support/wagering-api';

const brl = (amount: string) => ({ amount, currency: 'BRL' });

/** Banco, filas e app exclusivos por teste: a outbox de um teste não vaza para outro. */
interface Env {
  db: TestDatabase;
  queues: TestQueues;
  apps: TestApp[];
}

let env: Env | undefined;

async function setup(overrides: Record<string, string> = {}): Promise<Env & { app: TestApp }> {
  const db = await createTestDatabase();
  const queues = await createTestQueues();
  const app = await startTestApp(buildTestConfig({ databaseUrl: db.url, queues: queues.names, overrides }));
  env = { db, queues, apps: [app] };
  return { ...env, app };
}

async function anotherInstance(overrides: Record<string, string> = {}): Promise<TestApp> {
  const app = await startTestApp(buildTestConfig({ databaseUrl: env!.db.url, queues: env!.queues.names, overrides }));
  env!.apps.push(app);
  return app;
}

afterEach(async () => {
  if (!env) return;
  await Promise.all(env.apps.map((app) => app.close()));
  await env.queues.destroy();
  await env.db.drop();
  env = undefined;
});

const workerOf = (app: TestApp) => app.app.get(OutboxPublisherWorker);

async function outboxRows(db: TestDatabase) {
  return db.sql`
    SELECT id, event_type, attempts, published_at, locked_until, last_error,
           next_attempt_at > now() AS scheduled_ahead
      FROM outbox_messages ORDER BY seq`;
}

describe('publisher da outbox', () => {
  test('publica eventos confirmados na fila de eventos, com grupo = wallet e deduplicação = eventId', async () => {
    const { app, db, queues } = await setup();
    const wagering = wageringApi(httpClient(app.baseUrl));
    const wallet = await wagering.createWallet('100.00');
    const bet = await wagering.submit(wagering.transaction(wallet, { money: brl('25.00') }));

    // Antes de o publisher rodar, nada saiu: os eventos estão só na outbox.
    expect(await expectQueueEmpty(queues.client, queues.urls.events)).toEqual([]);
    expect(await app.app.get<OutboxStore>(OUTBOX_STORE).lagSeconds()).toBeGreaterThanOrEqual(0);

    expect(await workerOf(app).runOnce()).toEqual({ claimed: 2, published: 2, failed: 0 });

    const messages = await receiveMessages(queues.client, queues.urls.events, { expected: 2 });
    const rows = await outboxRows(db);
    expect(messages.map((m) => bodyOf(m).eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    for (const message of messages) {
      const body = bodyOf(message);
      expect(body.causationId).toBe(bet.body.transactionId);
      expect(message.Attributes?.MessageGroupId).toBe(wallet.id);
      expect(message.Attributes?.MessageDeduplicationId).toBe(body.eventId);
      expect(message.MessageAttributes?.eventType?.StringValue).toBe(body.eventType);
      expect(rows.map((row: { id: string }) => row.id)).toContain(body.eventId);
    }
    expect(rows.every((row: { published_at: Date | null; locked_until: Date | null }) => row.published_at && !row.locked_until)).toBe(true);
    expect(await app.app.get<OutboxStore>(OUTBOX_STORE).lagSeconds()).toBe(0);
    expect(await workerOf(app).runOnce()).toEqual({ claimed: 0, published: 0, failed: 0 });
  });

  test('falha antes do commit: nem transação, nem ledger, nem evento, e nada é publicado', async () => {
    const { app, db, queues } = await setup();
    const wagering = wageringApi(httpClient(app.baseUrl));
    const wallet = await wagering.createWallet('100.00');
    await workerOf(app).runOnce();

    // O mesmo caso de uso, sobre o UnitOfWork real, com uma falha logo antes do COMMIT.
    const realUnitOfWork = app.app.get<UnitOfWork>(UNIT_OF_WORK);
    const failingUnitOfWork: UnitOfWork = {
      run: (work, options) =>
        realUnitOfWork.run(async (scope) => {
          await work(scope);
          throw new Error('falha simulada antes do commit');
        }, options),
    };
    const useCase = new ProcessWagerTransactionUseCase(
      failingUnitOfWork,
      app.app.get<Clock>(CLOCK),
      app.app.get<IdGenerator>(ID_GENERATOR),
      { referenceRetry: { baseDelayMs: 1000, maxDelayMs: 1000, maxAttempts: 3 } },
      app.app.get<Telemetry>(TELEMETRY),
    );

    await expect(
      useCase.execute({
        idempotencyKey: 'k-falha',
        providerId: 'provider-a',
        externalTransactionId: 'tx-falha',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: Money.from(brl('40.00')),
        correlationId: 'corr-falha',
      }),
    ).rejects.toThrow('falha simulada antes do commit');

    const [{ transactions }] = await db.sql`
      SELECT count(*)::int AS transactions FROM wager_transactions WHERE external_transaction_id = 'tx-falha'`;
    expect(transactions).toBe(0);
    const [{ pending }] = await db.sql`SELECT count(*)::int AS pending FROM outbox_messages WHERE published_at IS NULL`;
    expect(pending).toBe(0);
    const [{ balance }] = await db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.id}`;
    expect(balance).toBe('100.00');
    await assertWalletMatchesLedger(db.sql, wallet.id);

    expect((await workerOf(app).runOnce()).claimed).toBe(0);
    expect(await expectQueueEmpty(queues.client, queues.urls.events)).toEqual([]);
  });

  test('dois publishers sobre a mesma outbox: nenhum evento perdido, nenhum publicado duas vezes', async () => {
    const { app, db, queues } = await setup({ OUTBOX_BATCH_SIZE: '7' });
    const other = await anotherInstance({ OUTBOX_BATCH_SIZE: '7' });
    const wagering = wageringApi(httpClient(app.baseUrl));
    const wallets = await Promise.all(Array.from({ length: 5 }, () => wagering.createWallet('100.00')));
    await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 6 }, () => wagering.submit(wagering.transaction(wallet, { money: brl('1.00') }))),
      ),
    );
    const expectedIds = (await outboxRows(db)).map((row: { id: string }) => row.id);
    expect(expectedIds).toHaveLength(60);

    let published = 0;
    for (;;) {
      const [a, b] = await Promise.all([workerOf(app).runOnce(), workerOf(other).runOnce()]);
      published += a.published + b.published;
      if (a.claimed === 0 && b.claimed === 0) break;
    }
    expect(published).toBe(60);

    const messages = await receiveMessages(queues.client, queues.urls.events, { expected: 60, timeoutMs: 20_000 });
    const receivedIds = messages.map((m) => bodyOf(m).eventId);
    expect(new Set(receivedIds).size).toBe(60);
    expect([...new Set(receivedIds)].sort()).toEqual([...expectedIds].sort());
  });

  test('publisher que morre depois de reservar: o lease segura e, vencido, outra instância publica', async () => {
    const { app, db, queues } = await setup();
    const wagering = wageringApi(httpClient(app.baseUrl));
    const wallet = await wagering.createWallet('100.00');
    await wagering.submit(wagering.transaction(wallet, { money: brl('5.00') }));

    // Instância "morta": reservou e nunca publicou nem marcou.
    const claimed = await app.app.get<OutboxStore>(OUTBOX_STORE).claimDue(50, 60_000);
    expect(claimed.messages).toHaveLength(2);

    const survivor = await anotherInstance();
    expect((await workerOf(survivor).runOnce()).claimed).toBe(0);
    expect(await expectQueueEmpty(queues.client, queues.urls.events)).toEqual([]);

    await db.sql`UPDATE outbox_messages SET locked_until = now() - interval '1 second'`;
    expect((await workerOf(survivor).runOnce()).published).toBe(2);
    expect(await receiveMessages(queues.client, queues.urls.events, { expected: 2 })).toHaveLength(2);
  });

  test('SQS indisponível: conta tentativa, agenda com backoff e entrega quando a fila volta', async () => {
    const missingQueue = `wager-events-ausente-${uniqueSuffix()}.fifo`;
    const { app, db, queues } = await setup({ QUEUE_NAME_EVENTS: missingQueue });
    const wagering = wageringApi(httpClient(app.baseUrl));
    const wallet = await wagering.createWallet('100.00');
    await wagering.submit(wagering.transaction(wallet, { kind: 'LOSS', money: brl('1.00') }));

    expect(await workerOf(app).runOnce()).toEqual({ claimed: 1, published: 0, failed: 1 });
    const [failed] = await outboxRows(db);
    expect(failed).toMatchObject({ attempts: 1, published_at: null, locked_until: null, scheduled_ahead: true });
    expect(failed.last_error).toEqual(expect.any(String));

    // Ainda não venceu: não tenta de novo antes do backoff.
    expect((await workerOf(app).runOnce()).claimed).toBe(0);

    const created = await queues.client.send(
      new CreateQueueCommand({
        QueueName: missingQueue,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      }),
    );
    await db.sql`UPDATE outbox_messages SET next_attempt_at = now()`;
    expect(await workerOf(app).runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });

    const [message] = await receiveMessages(queues.client, created.QueueUrl!, { expected: 1 });
    expect(bodyOf(message!).eventType).toBe('WagerTransactionProcessed');
    expect((await outboxRows(db))[0]).toMatchObject({ attempts: 1, locked_until: null });
    await queues.client.send(new DeleteQueueCommand({ QueueUrl: created.QueueUrl! }));
  });
});
