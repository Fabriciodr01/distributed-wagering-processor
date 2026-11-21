import type { MoneyProps } from '../money';
import { type WagerTransaction, WagerTransactionStatus } from '../wager-transaction';
import { compact, type EventContext, IntegrationEvent, type IntegrationEventProps } from './integration-event';
import {
  assertStatus,
  requireBalance,
  snapshotOf,
  type WagerTransactionSnapshot,
} from './wager-transaction-snapshot';

export interface WagerTransactionProcessedData extends WagerTransactionSnapshot {
  readonly status: WagerTransactionStatus.Processed;
  readonly referenceTransactionId?: string;
  readonly balance: MoneyProps;
  readonly processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed, 'WagerTransactionProcessed');
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.walletId,
      causationId: transaction.id,
      data: compact({
        ...snapshotOf(transaction),
        status: WagerTransactionStatus.Processed as const,
        referenceTransactionId: transaction.referenceTransactionId,
        balance: requireBalance(transaction),
        processedAt: (transaction.processedAt ?? ctx.occurredAt).toISOString(),
      }),
    });
  }
}
