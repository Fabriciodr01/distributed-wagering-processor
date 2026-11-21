import type { FailureCode } from '../failure-code';
import type { MoneyProps } from '../money';
import { type WagerTransaction, WagerTransactionStatus } from '../wager-transaction';
import { type EventContext, IntegrationEvent, type IntegrationEventProps } from './integration-event';
import {
  assertStatus,
  requireBalance,
  snapshotOf,
  type WagerTransactionSnapshot,
} from './wager-transaction-snapshot';

export interface WagerTransactionRejectedData extends WagerTransactionSnapshot {
  readonly status: WagerTransactionStatus.Rejected;
  readonly failureCode: FailureCode;
  readonly balance: MoneyProps;
  readonly rejectedAt: string;
}

/** Transação rejeitada por regra de negócio, inclusive referência que expirou. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected, 'WagerTransactionRejected');
    // assertStatus garante REJECTED, e reject() sempre grava o código.
    const failureCode = transaction.failureCode as FailureCode;
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.walletId,
      causationId: transaction.id,
      data: {
        ...snapshotOf(transaction),
        status: WagerTransactionStatus.Rejected,
        failureCode,
        balance: requireBalance(transaction),
        rejectedAt: (transaction.processedAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }
}
