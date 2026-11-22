import type { EntitySchema } from '@mikro-orm/core';
import { InboxMessageSchema } from './rows/inbox-message.row';
import { OutboxMessageSchema } from './rows/outbox-message.row';
import { WagerTransactionSchema } from './rows/wager-transaction.row';
import { WalletSchema } from './rows/wallet.row';
import { WalletLedgerEntrySchema } from './rows/wallet-ledger-entry.row';

export const ENTITIES: EntitySchema[] = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
