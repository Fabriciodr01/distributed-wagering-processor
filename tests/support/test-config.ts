import { type AppConfig, loadConfig, type QueueNames } from '../../src/config/app-config';
import { testInfra } from './test-env';

/**
 * Monta o env de teste e passa pelo mesmo `loadConfig` da aplicação,
 * então os testes também exercitam a validação.
 */
export function testEnvVars(options: {
  databaseUrl: string;
  queues: QueueNames;
  overrides?: Record<string, string>;
}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PORT: '0',
    DATABASE_URL: options.databaseUrl,
    DB_POOL_MAX: '10',
    SQS_ENDPOINT: testInfra.sqsEndpoint,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    QUEUE_NAME_TRANSACTIONS: options.queues.transactions,
    QUEUE_NAME_DLQ: options.queues.dlq,
    QUEUE_NAME_EVENTS: options.queues.events,
    // Consumidor e publisher ficam desligados por padrão: cada teste liga o que exercita.
    RUN_CONSUMER: 'false',
    RUN_OUTBOX_PUBLISHER: 'false',
    CONSUMER_WAIT_TIME_S: '1',
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_REF_POLL_INTERVAL_MS: '100',
    PENDING_REF_BASE_DELAY_MS: '50',
    PENDING_REF_MAX_DELAY_MS: '400',
    LOG_LEVEL: 'silent',
    ...options.overrides,
  };
}

export function buildTestConfig(options: Parameters<typeof testEnvVars>[0]): AppConfig {
  return loadConfig(testEnvVars(options));
}
