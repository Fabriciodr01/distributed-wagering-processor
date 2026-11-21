import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config/app-config';
import { APP_CONFIG } from '../../config/config.module';
import { resolveQueueUrl } from '../sqs/queue-setup';
import { SQS_CLIENT } from '../sqs/sqs.tokens';

export type DependencyStatus = { status: 'up' } | { status: 'down'; error: string };

export interface ReadinessReport {
  readonly status: 'ok' | 'unavailable';
  readonly checks: {
    readonly postgres: DependencyStatus;
    readonly sqs: DependencyStatus;
  };
}

const CHECK_TIMEOUT_MS = 2000;

@Injectable()
export class ReadinessService {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      probe(() => this.checkPostgres()),
      probe(() => this.checkSqs()),
    ]);
    const ok = postgres.status === 'up' && sqs.status === 'up';
    return { status: ok ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }

  private async checkPostgres(): Promise<void> {
    await this.orm.em.fork().getConnection().execute('select 1');
  }

  private async checkSqs(): Promise<void> {
    // A DLQ fica de fora: o serviço consegue operar sem ela, e só a usa em caso de erro.
    const { transactions, events } = this.config.sqs.queues;
    for (const name of [transactions, events]) {
      const url = await resolveQueueUrl(this.sqs, name);
      await this.sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
      );
    }
  }
}

async function probe(check: () => Promise<void>): Promise<DependencyStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout após ${CHECK_TIMEOUT_MS} ms`)), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return { status: 'up' };
  } catch (error) {
    return { status: 'down', error: describe(error) };
  } finally {
    clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}
