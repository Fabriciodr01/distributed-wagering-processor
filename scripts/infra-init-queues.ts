import { loadConfig, SQS_MAX_RECEIVE_COUNT } from '../src/config/app-config';
import { ensureQueues } from '../src/infrastructure/sqs/queue-setup';
import { createSqsClient } from '../src/infrastructure/sqs/sqs-client';

const config = loadConfig();
const client = createSqsClient(config.sqs);

try {
  const urls = await ensureQueues(client, config.sqs.queues, {
    maxReceiveCount: SQS_MAX_RECEIVE_COUNT,
    visibilityTimeoutS: config.consumer.visibilityTimeoutS,
  });
  console.log('Filas prontas:');
  for (const [role, url] of Object.entries(urls)) {
    console.log(`  ${role.padEnd(12)} ${url}`);
  }
} finally {
  client.destroy();
}
