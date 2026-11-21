import { EntitySchema } from '@mikro-orm/core';

export class OutboxMessageRow {
  id!: string;
  seq!: bigint;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  lockedUntil!: Date | null;
  publishedAt!: Date | null;
  lastError!: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRow>({
  class: OutboxMessageRow,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    seq: { type: 'bigint', persist: false },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'text' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'datetime', columnType: 'timestamptz' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz' },
    lockedUntil: { type: 'datetime', columnType: 'timestamptz', nullable: true },
    publishedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
    lastError: { type: 'text', nullable: true },
  },
});
