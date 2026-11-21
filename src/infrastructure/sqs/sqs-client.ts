import { SQSClient } from '@aws-sdk/client-sqs';

export interface SqsConnectionOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export function createSqsClient(options: SqsConnectionOptions): SQSClient {
  return new SQSClient({
    endpoint: options.endpoint,
    region: options.region,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    // Retries do SDK ficam curtos: a política de retry de verdade é do consumidor e da outbox.
    maxAttempts: 2,
  });
}
