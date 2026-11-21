import type { SqlEntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '../../../application/ports/repositories.port';
import type { OutboxMessage } from '../../../domain/outbox-message';
import { OutboxMessageMapper } from '../mappers/outbox-message.mapper';
import { OutboxMessageRow } from '../rows/outbox-message.row';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    // Um INSERT por evento, na ordem recebida: o seq reflete a ordem em que foram gerados.
    for (const message of messages) {
      await this.em.insert(OutboxMessageRow, OutboxMessageMapper.fromDomain(message));
    }
  }
}
