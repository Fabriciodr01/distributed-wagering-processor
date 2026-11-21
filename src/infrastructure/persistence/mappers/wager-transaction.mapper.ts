import type { FailureCode } from '../../../domain/failure-code';
import { Money } from '../../../domain/money';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../../domain/wager-transaction';
import { WagerTransactionRow } from '../rows/wager-transaction.row';

/** Campos de agendamento do worker de PENDING_REFERENCE; não fazem parte do estado de domínio. */
export interface ReferenceRetrySchedule {
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly leaseUntil: Date | null;
}

const NO_SCHEDULE: ReferenceRetrySchedule = { attempts: 0, nextAttemptAt: null, leaseUntil: null };

export const WagerTransactionMapper = {
  toDomain(row: WagerTransactionRow): WagerTransaction {
    const money = (amount: string) => Money.from({ amount, currency: row.currency });
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind as WagerTransactionKind,
      money: money(row.amount),
      referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
      createdAt: row.createdAt,
      status: row.status as WagerTransactionStatus,
      referenceTransactionId: row.referenceTransactionId ?? undefined,
      failureCode: (row.failureCode ?? undefined) as FailureCode | undefined,
      processedAt: row.processedAt ?? undefined,
      resultingBalance: row.resultingBalance === null ? undefined : money(row.resultingBalance),
    });
  },

  fromDomain(transaction: WagerTransaction, schedule: ReferenceRetrySchedule = NO_SCHEDULE): WagerTransactionRow {
    return Object.assign(new WagerTransactionRow(), {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: transaction.money.toJSON().amount,
      currency: transaction.money.currency,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      status: transaction.status,
      failureCode: transaction.failureCode ?? null,
      resultingBalance: transaction.resultingBalance?.toJSON().amount ?? null,
      attempts: schedule.attempts,
      nextAttemptAt: schedule.nextAttemptAt,
      leaseUntil: schedule.leaseUntil,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt ?? null,
    });
  },
};
