import { InboxMessage } from '../../../domain/inbox-message';
import { InboxMessageRow } from '../rows/inbox-message.row';

export const InboxMessageMapper = {
  toDomain(row: InboxMessageRow): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: row.messageId,
      consumerName: row.consumerName,
      payloadHash: row.payloadHash,
      receivedAt: row.receivedAt,
      processedAt: row.processedAt ?? undefined,
    });
  },

  fromDomain(message: InboxMessage): InboxMessageRow {
    return Object.assign(new InboxMessageRow(), {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    });
  },
};
