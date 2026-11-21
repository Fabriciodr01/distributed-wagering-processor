import { describe, expect, test } from 'bun:test';
import { InvalidMessageStateError } from '../../../src/domain/errors';
import { WagerTransactionProcessed } from '../../../src/domain/events';
import { InboxMessage } from '../../../src/domain/inbox-message';
import { OutboxMessage } from '../../../src/domain/outbox-message';
import { processed, T0 } from '../../support/domain-fixtures';

const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe('InboxMessage', () => {
  const receive = (payloadHash = 'h1') =>
    InboxMessage.receive({ messageId: 'msg-1', consumerName: 'c', payloadHash, receivedAt: T0 });

  test('recebida não está processada; markProcessed marca uma única vez', () => {
    const msg = receive();
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(at(1));
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(at(1));
    expect(() => msg.markProcessed(at(2))).toThrow(InvalidMessageStateError);
  });

  test('matchesPayload distingue redelivery de conflito', () => {
    const msg = receive('h1');
    expect(msg.matchesPayload('h1')).toBe(true);
    expect(msg.matchesPayload('h2')).toBe(false);
  });

  test.each(['messageId', 'consumerName', 'payloadHash'] as const)('%s é obrigatório', (field) => {
    expect(() =>
      InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: T0, [field]: '' }),
    ).toThrow(InvalidMessageStateError);
  });
});

describe('OutboxMessage', () => {
  const event = () =>
    WagerTransactionProcessed.from(processed(), { eventId: 'evt-1', correlationId: 'corr-1', occurredAt: T0 });

  test('enqueue usa o eventId como id e grava o envelope serializado', () => {
    const evt = event();
    const msg = OutboxMessage.enqueue(evt);
    expect(msg.id).toBe('evt-1');
    expect(msg.aggregateId).toBe(evt.aggregateId);
    expect(msg.eventType).toBe('WagerTransactionProcessed');
    expect(msg.payload).toEqual(JSON.parse(JSON.stringify(evt)));
    expect(msg.occurredAt).toEqual(T0);
    expect(msg.attempts).toBe(0);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(T0)).toBe(true);
  });

  test('payload é imutável', () => {
    const msg = OutboxMessage.enqueue(event());
    expect(Object.isFrozen(msg.payload)).toBe(true);
    expect(Object.isFrozen(msg.payload.data)).toBe(true);
  });

  test('scheduleRetry incrementa attempts com backoff exponencial limitado', () => {
    const msg = OutboxMessage.enqueue(event());
    const policy = { baseDelayMs: 1000, maxDelayMs: 5000 };
    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      msg.scheduleRetry(T0, policy);
      delays.push((msg.nextAttemptAt?.getTime() ?? 0) - T0.getTime());
    }
    expect(delays).toEqual([1000, 2000, 4000, 5000, 5000]);
    expect(msg.attempts).toBe(5);
    expect(msg.isDue(at(4))).toBe(false);
    expect(msg.isDue(at(5))).toBe(true);
  });

  test('a política padrão limita o backoff a 60 s', () => {
    const msg = OutboxMessage.enqueue(event());
    for (let i = 0; i < 10; i += 1) msg.scheduleRetry(T0);
    expect(msg.nextAttemptAt).toEqual(at(60));
  });

  test('markPublished encerra a mensagem; publicar de novo ou reagendar é erro', () => {
    const msg = OutboxMessage.enqueue(event());
    msg.markPublished(at(1));
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(at(10))).toBe(false);
    expect(msg.publishedAt).toEqual(at(1));
    expect(() => msg.markPublished(at(2))).toThrow(InvalidMessageStateError);
    expect(() => msg.scheduleRetry(at(2))).toThrow(InvalidMessageStateError);
  });

  test('rehydrate respeita nextAttemptAt', () => {
    const msg = OutboxMessage.rehydrate({
      id: 'evt-9',
      aggregateId: 'w1',
      eventType: 'WalletBalanceChanged',
      payload: { eventId: 'evt-9' },
      occurredAt: T0,
      attempts: 3,
      nextAttemptAt: at(30),
    });
    expect(msg.attempts).toBe(3);
    expect(msg.isDue(at(29))).toBe(false);
    expect(msg.isDue(at(30))).toBe(true);
  });
});
