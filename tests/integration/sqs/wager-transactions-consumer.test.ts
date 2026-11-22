import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { afterEach, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../../support/assert-wallet-matches-ledger';
import { eventually } from '../../support/eventually';
import { httpClient } from '../../support/http';
import { HASH, type SeededWallet, seedWallet } from '../../support/sql-fixtures';
import { bodyOf, expectQueueEmpty, queueDepth, receiveMessages, sendRaw } from '../../support/sqs-helpers';
import { startTestApp, type TestApp } from '../../support/test-app';
import { buildTestConfig } from '../../support/test-config';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { createTestQueues, type TestQueues } from '../../support/test-queues';

const CONSUMER = 'wager-transactions-consumer';
const UNREACHABLE_DB = 'postgres://wager:wager@127.0.0.1:1/wager';

/** Banco, filas e apps exclusivos por teste: mensagens e inbox de um teste não vazam para outro. */
let db: TestDatabase;
let queues: TestQueues;
const apps: TestApp[] = [];

async function setup(): Promise<void> {
  db = await createTestDatabase();
  queues = await createTestQueues();
}

async function startConsumer(overrides: Record<string, string> = {}, databaseUrl = db.url): Promise<TestApp> {
  const app = await startTestApp(
    buildTestConfig({
      databaseUrl,
      queues: queues.names,
      overrides: { RUN_CONSUMER: 'true', RUN_PENDING_REFERENCE_WORKER: 'false', ...overrides },
    }),
  );
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await queues?.destroy();
  await db?.drop();
});

function transactionMessage(wallet: SeededWallet, data: Record<string, unknown> = {}, messageId = `msg-${Bun.randomUUIDv7()}`) {
  const externalTransactionId = (data.externalTransactionId as string) ?? `tx-${Bun.randomUUIDv7()}`;
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...data,
    },
  };
}

type Envelope = ReturnType<typeof transactionMessage>;

function send(message: Envelope | string, groupId: string, deduplicationId?: string) {
  const body = typeof message === 'string' ? message : JSON.stringify(message);
  const dedup = deduplicationId ?? (typeof message === 'string' ? Bun.randomUUIDv7() : message.messageId);
  return sendRaw(queues.client, queues.urls.transactions, body, { groupId, deduplicationId: dedup });
}

async function waitDrained(): Promise<void> {
  await eventually(async () => expect(await queueDepth(queues.client, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 }), {
    timeout: 15_000,
    interval: 200,
  });
}

async function transactionByExternalId(externalTransactionId: string) {
  const [row] = await db.sql`
    SELECT id, status, failure_code, resulting_balance::text AS balance
      FROM wager_transactions WHERE external_transaction_id = ${externalTransactionId}`;
  return row;
}

async function balanceOf(walletId: string): Promise<string> {
  const [{ balance }] = await db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${walletId}`;
  return balance;
}

describe('consumidor de wager-transactions.fifo', () => {
  test('mensagem válida é processada pelo mesmo caso de uso da API, com inbox e outbox, e só então sai da fila', async () => {
    await setup();
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    await startConsumer();
    const message = transactionMessage(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    await send(message, wallet.walletId);

    await waitDrained();
    const tx = await transactionByExternalId(message.data.externalTransactionId);
    expect(tx).toMatchObject({ status: 'PROCESSED', balance: '75.00' });
    expect(await balanceOf(wallet.walletId)).toBe('75.00');

    const [inbox] = await db.sql`SELECT consumer_name, processed_at FROM inbox_messages WHERE message_id = ${message.messageId}`;
    expect(inbox.consumer_name).toBe(CONSUMER);
    expect(inbox.processed_at).not.toBeNull();

    const events = await db.sql`
      SELECT event_type, payload ->> 'correlationId' AS correlation FROM outbox_messages
       WHERE payload ->> 'causationId' = ${tx.id} ORDER BY seq`;
    expect(events).toEqual([
      { event_type: 'WagerTransactionProcessed', correlation: message.messageId },
      { event_type: 'WalletBalanceChanged', correlation: message.messageId },
    ]);
    await assertWalletMatchesLedger(db.sql, wallet.walletId);
  });

  test('redelivery da mesma messageId (fora da janela de dedup do FIFO) tem um único efeito', async () => {
    await setup();
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    await startConsumer();
    const message = transactionMessage(wallet);
    // Deduplication ids diferentes: o broker entrega as duas, só o inbox impede o segundo efeito.
    await send(message, wallet.walletId, 'entrega-1');
    await send(message, wallet.walletId, 'entrega-2');

    await waitDrained();
    expect(await balanceOf(wallet.walletId)).toBe('90.00');
    const [{ total }] = await db.sql`SELECT count(*)::int AS total FROM inbox_messages`;
    expect(total).toBe(1);
    expect(await expectQueueEmpty(queues.client, queues.urls.dlq)).toEqual([]);
  });

  test('rejeição de negócio e PENDING_REFERENCE são resultados válidos: commit e ack, sem DLQ', async () => {
    await setup();
    const wallet = await seedWallet(db.sql, { balance: '5.00' });
    await startConsumer();
    const rejected = transactionMessage(wallet, { money: { amount: '50.00', currency: 'BRL' } });
    const pending = transactionMessage(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-ausente' });
    await send(rejected, wallet.walletId);
    await send(pending, wallet.walletId);

    await waitDrained();
    expect(await transactionByExternalId(rejected.data.externalTransactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
    expect(await transactionByExternalId(pending.data.externalTransactionId)).toMatchObject({ status: 'PENDING_REFERENCE' });
    expect(await expectQueueEmpty(queues.client, queues.urls.dlq)).toEqual([]);
  });

  test.each([
    ['corpo que não é JSON', () => '{"messageId": ', 'invalid_message'],
    ['fora do contrato (sem idempotencyKey)', (w: SeededWallet) => {
      const message = transactionMessage(w);
      const { idempotencyKey: _, ...data } = message.data;
      return { ...message, data };
    }, 'invalid_message'],
    ['tipo de mensagem desconhecido', (w: SeededWallet) => ({ ...transactionMessage(w), type: 'Outra' }), 'invalid_message'],
    ['kind OPENING', (w: SeededWallet) => transactionMessage(w, { kind: 'OPENING' }), 'invalid_message'],
    ['REFUND sem referência', (w: SeededWallet) => transactionMessage(w, { kind: 'REFUND' }), 'rejected_request'],
    ['wallet inexistente', (w: SeededWallet) => transactionMessage(w, { walletId: Bun.randomUUIDv7() }), 'rejected_request'],
  ])('permanente (%s) vai direto para a DLQ, sem efeito', async (_, build, reason) => {
    await setup();
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    await startConsumer();
    const message = build(wallet);
    await send(message as Envelope | string, wallet.walletId);

    const [dead] = await receiveMessages(queues.client, queues.urls.dlq, { expected: 1, timeoutMs: 15_000 });
    expect(dead?.MessageAttributes?.deadLetterReason?.StringValue).toBe(reason);
    expect(dead?.Body).toBe(typeof message === 'string' ? message : JSON.stringify(message));
    expect(dead?.Attributes?.MessageGroupId).toBe(wallet.walletId);
    await waitDrained();
    const [{ total }] = await db.sql`SELECT count(*)::int AS total FROM wager_transactions WHERE provider_id <> 'internal'`;
    expect(total).toBe(0);
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
  });

  test('mesma messageId com conteúdo diferente é conflito permanente: DLQ, e o primeiro efeito fica', async () => {
    await setup();
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    await startConsumer();
    const original = transactionMessage(wallet, {}, 'msg-conflito');
    const conflicting = transactionMessage(wallet, { money: { amount: '99.00', currency: 'BRL' } }, 'msg-conflito');
    await send(original, wallet.walletId, 'd-1');
    await send(conflicting, wallet.walletId, 'd-2');

    const [dead] = await receiveMessages(queues.client, queues.urls.dlq, { expected: 1, timeoutMs: 15_000 });
    expect(bodyOf(dead!).data.money.amount).toBe('99.00');
    await waitDrained();
    expect(await balanceOf(wallet.walletId)).toBe('90.00');
  });

  test('falha transitória (Postgres fora): a mensagem volta e é processada quando o banco volta, uma vez só', async () => {
    await setup();
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    // Instância sem banco: recebe, falha como transitória e devolve com backoff (1 s).
    const offline = await startConsumer({ CONSUMER_RETRY_BASE_S: '1' }, UNREACHABLE_DB);
    const message = transactionMessage(wallet);
    await send(message, wallet.walletId);
    await eventually(async () => expect((await queueDepth(queues.client, queues.urls.transactions)).inFlight).toBe(1), {
      timeout: 10_000,
      interval: 100,
    });
    await offline.close();
    apps.splice(apps.indexOf(offline), 1);
    expect(await transactionByExternalId(message.data.externalTransactionId)).toBeUndefined();

    // "O banco voltou": uma instância com o Postgres alcançável processa a redelivery.
    await startConsumer();
    await waitDrained();
    expect(await transactionByExternalId(message.data.externalTransactionId)).toMatchObject({ status: 'PROCESSED' });
    expect(await balanceOf(wallet.walletId)).toBe('90.00');
    expect(await expectQueueEmpty(queues.client, queues.urls.dlq)).toEqual([]);
  });

  /** Leva uma mensagem até o limite de retries transitórios do app: FAILED gravado e mensagem na DLQ. */
  async function exhaustRetries() {
    await setup();
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    const message = transactionMessage(wallet);

    // Outra "instância" travada no meio da mesma mensagem: o inbox dela segura o lock da linha
    // e cada tentativa do consumidor estoura o lock_timeout (falha transitória).
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.sql
      .begin(async (tx) => {
        await tx`
          INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
          VALUES (${CONSUMER}, ${message.messageId}, ${HASH}, now())`;
        await held;
        throw new Error('rollback');
      })
      .catch(() => {});

    const app = await startConsumer({ CONSUMER_RETRY_BASE_S: '0', CONSUMER_MAX_ATTEMPTS: '5', DB_LOCK_TIMEOUT_MS: '200' });
    await send(message, wallet.walletId);

    try {
      const [dead] = await receiveMessages(queues.client, queues.urls.dlq, { expected: 1, timeoutMs: 20_000 });
      expect(dead?.MessageAttributes?.deadLetterReason?.StringValue).toBe('retries_exhausted');
    } finally {
      release();
      await holder;
    }
    await waitDrained();
    return { app, wallet, message };
  }

  test('transitório persistente até o limite do app: FAILED auditável (PROCESSING_RETRIES_EXHAUSTED) e DLQ', async () => {
    const { wallet, message } = await exhaustRetries();
    expect(await transactionByExternalId(message.data.externalTransactionId)).toMatchObject({
      status: 'FAILED',
      failure_code: 'PROCESSING_RETRIES_EXHAUSTED',
    });
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
  });

  test('FAILED é terminal: reenvio com a mesma chave (HTTP ou fila) devolve o FAILED original, sem lançamento', async () => {
    const { app, wallet, message } = await exhaustRetries();
    const failed = await transactionByExternalId(message.data.externalTransactionId);
    const { idempotencyKey, ...body } = message.data;

    const api = httpClient(app.baseUrl);
    const resent = await api.post('/wagering/transactions', body, { 'idempotency-key': idempotencyKey });
    expect(resent.status).toBe(422);
    expect(resent.body).toEqual({
      transactionId: failed.id,
      status: 'FAILED',
      failureCode: 'PROCESSING_RETRIES_EXHAUSTED',
      idempotentReplay: true,
    });

    // Pela fila, com outro messageId: também é replay do FAILED, confirmado sem ir para a DLQ.
    await send(transactionMessage(wallet, message.data), wallet.walletId);
    await waitDrained();
    expect(await expectQueueEmpty(queues.client, queues.urls.dlq)).toEqual([]);

    const rows = await db.sql`
      SELECT status FROM wager_transactions WHERE external_transaction_id = ${message.data.externalTransactionId}`;
    expect(rows).toEqual([{ status: 'FAILED' }]);
    const [{ entries }] = await db.sql`
      SELECT count(*)::int AS entries FROM wallet_ledger_entries l
        JOIN wager_transactions t ON t.id = l.transaction_id
       WHERE t.external_transaction_id = ${message.data.externalTransactionId}`;
    expect(entries).toBe(0);
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
    await assertWalletMatchesLedger(db.sql, wallet.walletId);
  });

  test('shutdown: conclui a mensagem em andamento e devolve as não iniciadas com visibilidade 0', async () => {
    await setup();
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    const messages = [transactionMessage(wallet), transactionMessage(wallet), transactionMessage(wallet)];

    // Segura a wallet para a 1ª mensagem ficar "em andamento" durante o shutdown.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM wallets WHERE id = ${wallet.walletId} FOR UPDATE`;
      locked();
      await held;
    });
    await lockTaken;

    for (const message of messages) await send(message, wallet.walletId);
    const app = await startConsumer({ CONSUMER_VISIBILITY_TIMEOUT_S: '60' });
    await eventually(async () => {
      const [{ waiting }] = await db.sql`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      expect(waiting).toBe(1);
    });

    const closing = app.close();
    apps.splice(apps.indexOf(app), 1);
    release();
    await holder;
    await closing;

    expect(await transactionByExternalId(messages[0]!.data.externalTransactionId)).toMatchObject({ status: 'PROCESSED' });
    for (const message of messages.slice(1)) {
      expect(await transactionByExternalId(message.data.externalTransactionId)).toBeUndefined();
    }
    // Visibilidade 60 s no recebimento: só estão disponíveis de novo porque foram devolvidas com 0.
    const returned = await receiveMessages(queues.client, queues.urls.transactions, { expected: 2, timeoutMs: 5_000 });
    expect(returned.map((m) => bodyOf(m).messageId)).toEqual(messages.slice(1).map((m) => m.messageId));
    expect(returned.every((m) => m.Attributes?.ApproximateReceiveCount === '2')).toBe(true);
  });

  /** Segura a linha da wallet numa transação do teste até `release()`. */
  async function holdWallet(walletId: string) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM wallets WHERE id = ${walletId} FOR UPDATE`;
      locked();
      await held;
    });
    await lockTaken;
    return {
      release: async () => {
        release();
        await holder;
      },
    };
  }

  async function lockWaiters(): Promise<number> {
    const [{ waiting }] = await db.sql`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    return waiting;
  }

  test('processamento mais longo que a visibilidade: o heartbeat renova e a mensagem não é reentregue', async () => {
    await setup();
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    // Visibilidade de 2 s e 5 s de processamento: sem renovação, a mensagem voltaria à fila
    // no meio do caminho e outro consumidor a receberia (com ApproximateReceiveCount = 2).
    await startConsumer({ CONSUMER_VISIBILITY_TIMEOUT_S: '2', FAULT_PROCESSING_DELAY_MS: '5000' });
    const message = transactionMessage(wallet);
    await send(message, wallet.walletId);
    await eventually(async () => expect((await queueDepth(queues.client, queues.urls.transactions)).inFlight).toBe(1), {
      timeout: 10_000,
      interval: 100,
    });
    const receivedAt = Date.now();

    // Um "outro consumidor" disputa a fila durante todo o processamento: não pode receber nada.
    const stolen: Array<string | undefined> = [];
    while (!(await transactionByExternalId(message.data.externalTransactionId))) {
      const { Messages = [] } = await queues.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.urls.transactions,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      );
      stolen.push(...Messages.map((m) => m.Attributes?.ApproximateReceiveCount));
    }
    // O processamento passou de duas vezes a visibilidade.
    expect(Date.now() - receivedAt).toBeGreaterThan(4_000);

    await waitDrained();
    expect(stolen).toEqual([]);
    expect(await balanceOf(wallet.walletId)).toBe('90.00');
    const [{ total }] = await db.sql`SELECT count(*)::int AS total FROM inbox_messages`;
    expect(total).toBe(1);
    expect(await expectQueueEmpty(queues.client, queues.urls.dlq)).toEqual([]);
    await assertWalletMatchesLedger(db.sql, wallet.walletId);
  }, 30_000);

  test('grupos diferentes do lote rodam em paralelo; dentro do grupo, em série e na ordem de envio', async () => {
    await setup();
    const slow = await seedWallet(db.sql, { balance: '100.00' });
    const fast = await seedWallet(db.sql, { balance: '100.00' });
    const ordered = ['10.00', '20.00', '30.00'].map((amount) =>
      transactionMessage(slow, { money: { amount, currency: 'BRL' } }),
    );
    const other = transactionMessage(fast);
    // Tudo enviado antes de o consumidor subir, para cair no mesmo lote.
    for (const message of ordered) await send(message, slow.walletId);
    await send(other, fast.walletId);

    const lock = await holdWallet(slow.walletId);
    await startConsumer({ CONSUMER_VISIBILITY_TIMEOUT_S: '60' });
    try {
      // A wallet travada prende só o próprio grupo: a outra é processada enquanto isso.
      await eventually(async () => expect(await lockWaiters()).toBe(1), { timeout: 10_000 });
      await eventually(async () =>
        expect(await transactionByExternalId(other.data.externalTransactionId)).toMatchObject({ status: 'PROCESSED' }),
      );
      expect(await transactionByExternalId(ordered[0]!.data.externalTransactionId)).toBeUndefined();
    } finally {
      await lock.release();
    }

    await waitDrained();
    const balances = [];
    for (const message of ordered) balances.push((await transactionByExternalId(message.data.externalTransactionId)).balance);
    // Saldos resultantes na sequência de envio: 100 → 90 → 70 → 40.
    expect(balances).toEqual(['90.00', '70.00', '40.00']);
    expect(await balanceOf(fast.walletId)).toBe('90.00');
    await assertWalletMatchesLedger(db.sql, slow.walletId);
    await assertWalletMatchesLedger(db.sql, fast.walletId);
  });

  test('shutdown com vários grupos: conclui a mensagem em andamento de cada grupo e devolve as demais', async () => {
    await setup();
    const walletA = await seedWallet(db.sql, { balance: '100.00' });
    const walletB = await seedWallet(db.sql, { balance: '100.00' });
    const groupA = [transactionMessage(walletA), transactionMessage(walletA)];
    const groupB = [transactionMessage(walletB), transactionMessage(walletB)];
    for (const message of groupA) await send(message, walletA.walletId);
    for (const message of groupB) await send(message, walletB.walletId);

    const lockA = await holdWallet(walletA.walletId);
    const lockB = await holdWallet(walletB.walletId);
    const app = await startConsumer({ CONSUMER_VISIBILITY_TIMEOUT_S: '60' });
    // As primeiras mensagens dos dois grupos estão em andamento ao mesmo tempo.
    await eventually(async () => expect(await lockWaiters()).toBe(2), { timeout: 10_000 });

    const closing = app.close();
    apps.splice(apps.indexOf(app), 1);
    await lockA.release();
    await lockB.release();
    await closing;

    for (const first of [groupA[0]!, groupB[0]!]) {
      expect(await transactionByExternalId(first.data.externalTransactionId)).toMatchObject({ status: 'PROCESSED' });
    }
    for (const rest of [groupA[1]!, groupB[1]!]) {
      expect(await transactionByExternalId(rest.data.externalTransactionId)).toBeUndefined();
    }
    const returned = await receiveMessages(queues.client, queues.urls.transactions, { expected: 2, timeoutMs: 5_000 });
    expect(returned.map((m) => bodyOf(m).messageId).sort()).toEqual([groupA[1]!.messageId, groupB[1]!.messageId].sort());
    expect(returned.every((m) => m.Attributes?.ApproximateReceiveCount === '2')).toBe(true);
  });
});
