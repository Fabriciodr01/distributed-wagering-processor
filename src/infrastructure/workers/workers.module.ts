import { Module } from '@nestjs/common';
import { PendingReferenceClaims } from '../persistence/pending-reference-claims';
import { WagerTransactionsConsumer } from '../sqs/wager-transactions.consumer';
import { OutboxPublisherWorker } from './outbox-publisher.worker';
import { PendingReferenceWorker } from './pending-reference.worker';

/** Papéis em segundo plano. Cada um decide no boot se roda nesta instância (RUN_*). */
@Module({
  providers: [PendingReferenceClaims, PendingReferenceWorker, OutboxPublisherWorker, WagerTransactionsConsumer],
  exports: [PendingReferenceWorker, OutboxPublisherWorker, WagerTransactionsConsumer],
})
export class WorkersModule {}
