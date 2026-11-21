import { InvalidWagerTransactionError } from '../errors';
import type { MoneyProps } from '../money';
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../wager-transaction';
import { compact } from './integration-event';

/** Campos de identificação comuns a todos os eventos de transação. */
export interface WagerTransactionSnapshot {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
}

export function snapshotOf(transaction: WagerTransaction): WagerTransactionSnapshot {
  return compact({
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
  });
}

export function assertStatus(
  transaction: WagerTransaction,
  expected: WagerTransactionStatus,
  eventType: string,
): void {
  if (transaction.status !== expected) {
    throw new InvalidWagerTransactionError(
      `${eventType} exige transação ${expected}, mas está ${transaction.status}`,
    );
  }
}

export function requireBalance(transaction: WagerTransaction): MoneyProps {
  if (!transaction.resultingBalance) {
    throw new InvalidWagerTransactionError(`Transação ${transaction.id} sem saldo resultante`);
  }
  return transaction.resultingBalance.toJSON();
}
