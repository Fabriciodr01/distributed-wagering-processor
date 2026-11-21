import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { QueueNames } from '../../config/app-config';

export interface QueueSetupOptions {
  readonly maxReceiveCount: number;
  readonly visibilityTimeoutS: number;
}

export interface QueueUrls {
  readonly transactions: string;
  readonly dlq: string;
  readonly events: string;
}

async function createFifoQueue(
  client: SQSClient,
  name: string,
  attributes: Record<string, string> = {},
): Promise<string> {
  const result = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        // A deduplicação é sempre explícita (MessageDeduplicationId), nunca pelo hash do corpo.
        ContentBasedDeduplication: 'false',
        ...attributes,
      },
    }),
  );
  if (!result.QueueUrl) {
    throw new Error(`CreateQueue não retornou a URL da fila ${name}`);
  }
  return result.QueueUrl;
}

/** Cria (de forma idempotente) a fila de transações com redrive para a DLQ e a fila de eventos. */
export async function ensureQueues(
  client: SQSClient,
  names: QueueNames,
  options: QueueSetupOptions,
): Promise<QueueUrls> {
  const dlq = await createFifoQueue(client, names.dlq);
  const dlqAttributes = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }),
  );
  const dlqArn = dlqAttributes.Attributes?.QueueArn;
  if (!dlqArn) {
    throw new Error(`Não foi possível obter o ARN da DLQ ${names.dlq}`);
  }

  const transactions = await createFifoQueue(client, names.transactions, {
    VisibilityTimeout: String(options.visibilityTimeoutS),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: options.maxReceiveCount,
    }),
  });
  const events = await createFifoQueue(client, names.events);

  return { transactions, dlq, events };
}

export async function resolveQueueUrl(client: SQSClient, name: string): Promise<string> {
  const result = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!result.QueueUrl) {
    throw new Error(`Fila ${name} não encontrada`);
  }
  return result.QueueUrl;
}

export async function deleteQueues(client: SQSClient, names: QueueNames): Promise<void> {
  for (const name of [names.transactions, names.events, names.dlq]) {
    try {
      const url = await resolveQueueUrl(client, name);
      await client.send(new DeleteQueueCommand({ QueueUrl: url }));
    } catch (error) {
      if (!isQueueMissing(error)) throw error;
    }
  }
}

export function isQueueMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'QueueDoesNotExist' ||
      error.name === 'AWS.SimpleQueueService.NonExistentQueue' ||
      error.name === 'NonExistentQueue')
  );
}
