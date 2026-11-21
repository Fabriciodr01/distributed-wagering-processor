import type { SqlEntityManager } from '@mikro-orm/postgresql';
import type { InboxRepository } from '../../../application/ports/repositories.port';
import type { InboxMessage } from '../../../domain/inbox-message';
import { InboxMessageMapper } from '../mappers/inbox-message.mapper';
import { InboxMessageRow } from '../rows/inbox-message.row';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async insertIfAbsent(message: InboxMessage): Promise<boolean> {
    const result = await this.em
      .createQueryBuilder(InboxMessageRow)
      .insert(InboxMessageMapper.fromDomain(message))
      .onConflict(['consumerName', 'messageId'])
      .ignore()
      .execute('run');
    return result.affectedRows === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const row = await this.em.findOne(InboxMessageRow, { consumerName, messageId }, { refresh: true });
    return row ? InboxMessageMapper.toDomain(row) : null;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageRow,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
  }
}
