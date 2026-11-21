import { OutboxMessage } from '../../../domain/outbox-message';
import { OutboxMessageRow } from '../rows/outbox-message.row';

export const OutboxMessageMapper = {
  toDomain(row: OutboxMessageRow): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: row.id,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: row.payload,
      occurredAt: row.occurredAt,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      publishedAt: row.publishedAt ?? undefined,
    });
  },

  /** Nova linha da outbox; lease e erro são controlados pelo publisher em SQL. */
  fromDomain(message: OutboxMessage): OutboxMessageRow {
    return Object.assign(new OutboxMessageRow(), {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: structuredClone(message.payload) as Record<string, unknown>,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
      lockedUntil: null,
      publishedAt: message.publishedAt ?? null,
      lastError: null,
    });
  },
};
