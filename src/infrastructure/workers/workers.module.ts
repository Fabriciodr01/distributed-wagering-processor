import { Module } from '@nestjs/common';
import { PendingReferenceClaims } from '../persistence/pending-reference-claims';
import { OutboxPublisherWorker } from './outbox-publisher.worker';
import { PendingReferenceWorker } from './pending-reference.worker';

/** Cada worker decide no boot se roda nesta instância, pelo papel configurado (RUN_*). */
@Module({
  providers: [PendingReferenceClaims, PendingReferenceWorker, OutboxPublisherWorker],
  exports: [PendingReferenceWorker, OutboxPublisherWorker],
})
export class WorkersModule {}
