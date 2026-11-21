import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();

const queueName = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,75}\.fifo$/, 'nome de fila FIFO inválido (precisa terminar em .fifo)');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DB_POOL_MAX: positiveInt.default(20),
    DB_LOCK_TIMEOUT_MS: positiveInt.default(5000),

    SQS_ENDPOINT: z.url().default('http://localhost:4566'),
    AWS_REGION: z.string().min(1).default('us-east-1'),
    AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
    QUEUE_NAME_TRANSACTIONS: queueName.default('wager-transactions.fifo'),
    QUEUE_NAME_DLQ: queueName.default('wager-transactions-dlq.fifo'),
    QUEUE_NAME_EVENTS: queueName.default('wager-events.fifo'),

    RUN_HTTP: booleanFlag.default(true),
    RUN_CONSUMER: booleanFlag.default(true),
    RUN_OUTBOX_PUBLISHER: booleanFlag.default(true),
    RUN_PENDING_REFERENCE_WORKER: booleanFlag.default(true),

    CONSUMER_NAME: z.string().min(1).max(100).default('wager-transactions-consumer'),
    CONSUMER_MAX_ATTEMPTS: positiveInt.default(5),
    CONSUMER_VISIBILITY_TIMEOUT_S: positiveInt.max(43200).default(30),
    CONSUMER_WAIT_TIME_S: nonNegativeInt.max(20).default(10),
    CONSUMER_RETRY_BASE_S: positiveInt.default(2),
    SHUTDOWN_TIMEOUT_MS: positiveInt.default(25000),

    OUTBOX_POLL_INTERVAL_MS: positiveInt.default(1000),
    OUTBOX_BATCH_SIZE: positiveInt.max(1000).default(50),
    OUTBOX_LEASE_MS: positiveInt.default(30000),
    OUTBOX_MAX_BACKOFF_MS: positiveInt.default(60000),

    PENDING_REF_POLL_INTERVAL_MS: positiveInt.default(2000),
    PENDING_REF_BATCH_SIZE: positiveInt.max(1000).default(20),
    PENDING_REF_LEASE_MS: positiveInt.default(30000),
    PENDING_REF_BASE_DELAY_MS: positiveInt.default(5000),
    PENDING_REF_MAX_DELAY_MS: positiveInt.default(300000),
    PENDING_REF_MAX_ATTEMPTS: positiveInt.default(10),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    FAULT_KILL_AFTER_COMMIT: booleanFlag.default(false),
  })
  .superRefine((env, ctx) => {
    // O redrive da fila é 6; o limite do app precisa vir antes para gravarmos o FAILED auditável.
    if (env.CONSUMER_MAX_ATTEMPTS >= 6) {
      ctx.addIssue({
        code: 'custom',
        path: ['CONSUMER_MAX_ATTEMPTS'],
        message: 'precisa ser menor que o maxReceiveCount da fila (6)',
      });
    }
    if (env.PENDING_REF_BASE_DELAY_MS > env.PENDING_REF_MAX_DELAY_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['PENDING_REF_BASE_DELAY_MS'],
        message: 'não pode ser maior que PENDING_REF_MAX_DELAY_MS',
      });
    }
  });

export const SQS_MAX_RECEIVE_COUNT = 6;

export interface AppConfig {
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly port: number;
  readonly database: {
    readonly url: string;
    readonly poolMax: number;
    readonly lockTimeoutMs: number;
  };
  readonly sqs: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly queues: QueueNames;
  };
  readonly roles: {
    readonly http: boolean;
    readonly consumer: boolean;
    readonly outboxPublisher: boolean;
    readonly pendingReferenceWorker: boolean;
  };
  readonly consumer: {
    readonly name: string;
    readonly maxAttempts: number;
    readonly visibilityTimeoutS: number;
    readonly waitTimeS: number;
    readonly retryBaseS: number;
    readonly shutdownTimeoutMs: number;
  };
  readonly outbox: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly leaseMs: number;
    readonly maxBackoffMs: number;
  };
  readonly pendingReference: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly leaseMs: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly maxAttempts: number;
  };
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly faults: {
    readonly killAfterCommit: boolean;
  };
}

export interface QueueNames {
  readonly transactions: string;
  readonly dlq: string;
  readonly events: string;
}

export class InvalidConfigError extends Error {
  constructor(details: string) {
    super(`Configuração inválida:\n${details}`);
    this.name = 'InvalidConfigError';
  }
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  // Variável definida como string vazia conta como ausente, para o default valer.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new InvalidConfigError(z.prettifyError(parsed.error));
  }
  const env = parsed.data;

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    database: {
      url: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS,
    },
    sqs: {
      endpoint: env.SQS_ENDPOINT,
      region: env.AWS_REGION,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      queues: {
        transactions: env.QUEUE_NAME_TRANSACTIONS,
        dlq: env.QUEUE_NAME_DLQ,
        events: env.QUEUE_NAME_EVENTS,
      },
    },
    roles: {
      http: env.RUN_HTTP,
      consumer: env.RUN_CONSUMER,
      outboxPublisher: env.RUN_OUTBOX_PUBLISHER,
      pendingReferenceWorker: env.RUN_PENDING_REFERENCE_WORKER,
    },
    consumer: {
      name: env.CONSUMER_NAME,
      maxAttempts: env.CONSUMER_MAX_ATTEMPTS,
      visibilityTimeoutS: env.CONSUMER_VISIBILITY_TIMEOUT_S,
      waitTimeS: env.CONSUMER_WAIT_TIME_S,
      retryBaseS: env.CONSUMER_RETRY_BASE_S,
      shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    },
    outbox: {
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      batchSize: env.OUTBOX_BATCH_SIZE,
      leaseMs: env.OUTBOX_LEASE_MS,
      maxBackoffMs: env.OUTBOX_MAX_BACKOFF_MS,
    },
    pendingReference: {
      pollIntervalMs: env.PENDING_REF_POLL_INTERVAL_MS,
      batchSize: env.PENDING_REF_BATCH_SIZE,
      leaseMs: env.PENDING_REF_LEASE_MS,
      baseDelayMs: env.PENDING_REF_BASE_DELAY_MS,
      maxDelayMs: env.PENDING_REF_MAX_DELAY_MS,
      maxAttempts: env.PENDING_REF_MAX_ATTEMPTS,
    },
    logLevel: env.LOG_LEVEL,
    // O gancho de falha só existe em teste, mesmo que a variável vaze para outro ambiente.
    faults: {
      killAfterCommit: env.NODE_ENV === 'test' && env.FAULT_KILL_AFTER_COMMIT,
    },
  };
}
