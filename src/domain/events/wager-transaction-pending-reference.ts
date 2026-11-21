import { type WagerTransaction, WagerTransactionStatus } from '../wager-transaction';
import { type EventContext, IntegrationEvent, type IntegrationEventProps } from './integration-event';
import { assertStatus, snapshotOf, type WagerTransactionSnapshot } from './wager-transaction-snapshot';

export interface WagerTransactionPendingReferenceData extends WagerTransactionSnapshot {
  readonly status: WagerTransactionStatus.PendingReference;
  readonly referenceExternalTransactionId: string;
}

/** Emitido uma vez, quando a transação passa a aguardar a referência. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, WagerTransactionStatus.PendingReference, 'WagerTransactionPendingReference');
    // markPendingReference() só aceita transações com referência.
    const referenceExternalTransactionId = transaction.referenceExternalTransactionId as string;
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.walletId,
      causationId: transaction.id,
      data: {
        ...snapshotOf(transaction),
        status: WagerTransactionStatus.PendingReference,
        referenceExternalTransactionId,
      },
    });
  }
}
