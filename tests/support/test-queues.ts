import type { SQSClient } from '@aws-sdk/client-sqs';
import { type QueueNames, SQS_MAX_RECEIVE_COUNT } from '../../src/config/app-config';
import { createSqsClient } from '../../src/infrastructure/sqs/sqs-client';
import { deleteQueues, ensureQueues, type QueueUrls } from '../../src/infrastructure/sqs/queue-setup';
import { testInfra, uniqueSuffix } from './test-env';

export interface TestQueues {
  readonly names: QueueNames;
  readonly urls: QueueUrls;
  readonly client: SQSClient;
  destroy(): Promise<void>;
}

export function testSqsConnection() {
  return {
    endpoint: testInfra.sqsEndpoint,
    region: 'us-east-1',
    accessKeyId: 'test',
    secretAccessKey: 'test',
  };
}

/** Cria as três filas FIFO com sufixo exclusivo da suíte, usando o mesmo código do script de init. */
export async function createTestQueues(
  options: { visibilityTimeoutS?: number } = {},
): Promise<TestQueues> {
  const suffix = uniqueSuffix();
  const names: QueueNames = {
    transactions: `wager-transactions-${suffix}.fifo`,
    dlq: `wager-transactions-dlq-${suffix}.fifo`,
    events: `wager-events-${suffix}.fifo`,
  };
  const client = createSqsClient(testSqsConnection());
  const urls = await ensureQueues(client, names, {
    maxReceiveCount: SQS_MAX_RECEIVE_COUNT,
    visibilityTimeoutS: options.visibilityTimeoutS ?? 30,
  });

  return {
    names,
    urls,
    client,
    async destroy() {
      try {
        await deleteQueues(client, names);
      } finally {
        client.destroy();
      }
    },
  };
}
