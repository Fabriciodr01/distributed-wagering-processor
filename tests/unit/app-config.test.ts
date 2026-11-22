import { describe, expect, test } from 'bun:test';
import { InvalidConfigError, loadConfig } from '../../src/config/app-config';

const minimal = { DATABASE_URL: 'postgres://wager:wager@localhost:5432/wager' };

describe('loadConfig', () => {
  test('aplica os defaults documentados no .env.example', () => {
    const config = loadConfig(minimal);
    expect(config.port).toBe(3000);
    expect(config.sqs.queues).toEqual({
      transactions: 'wager-transactions.fifo',
      dlq: 'wager-transactions-dlq.fifo',
      events: 'wager-events.fifo',
    });
    expect(config.roles).toEqual({
      http: true,
      consumer: true,
      outboxPublisher: true,
      pendingReferenceWorker: true,
    });
    expect(config.consumer.maxAttempts).toBe(5);
    expect(config.pendingReference.maxAttempts).toBe(10);
  });

  test('DATABASE_URL é obrigatório', () => {
    expect(() => loadConfig({})).toThrow(InvalidConfigError);
  });

  test('string vazia conta como ausente', () => {
    expect(loadConfig({ ...minimal, PORT: '' }).port).toBe(3000);
  });

  test.each([
    ['PORT', 'abc'],
    ['DATABASE_URL', 'mysql://localhost/x'],
    ['RUN_HTTP', 'sim'],
    ['QUEUE_NAME_TRANSACTIONS', 'sem-sufixo-fifo'],
    ['CONSUMER_MAX_ATTEMPTS', '6'],
    ['LOG_LEVEL', 'verbose'],
  ])('rejeita %s=%s com mensagem que cita a variável', (name, value) => {
    expect(() => loadConfig({ ...minimal, [name]: value })).toThrow(name);
  });

  test('o gancho FAULT_KILL_AFTER_COMMIT só vale com NODE_ENV=test', () => {
    expect(loadConfig({ ...minimal, FAULT_KILL_AFTER_COMMIT: '1' }).faults.killAfterCommit).toBe(false);
    expect(
      loadConfig({ ...minimal, NODE_ENV: 'test', FAULT_KILL_AFTER_COMMIT: '1' }).faults.killAfterCommit,
    ).toBe(true);
  });

  test('o gancho FAULT_PROCESSING_DELAY_MS só vale com NODE_ENV=test', () => {
    expect(loadConfig(minimal).faults.processingDelayMs).toBe(0);
    expect(loadConfig({ ...minimal, FAULT_PROCESSING_DELAY_MS: '5000' }).faults.processingDelayMs).toBe(0);
    expect(
      loadConfig({ ...minimal, NODE_ENV: 'test', FAULT_PROCESSING_DELAY_MS: '5000' }).faults.processingDelayMs,
    ).toBe(5000);
  });
});
