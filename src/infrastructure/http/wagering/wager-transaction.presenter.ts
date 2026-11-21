import type { WagerTransactionResult } from '../../../application/wagering/wager-transaction-result';
import type { FailureCode } from '../../../domain/failure-code';
import type { MoneyProps } from '../../../domain/money';
import {
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wager-transaction';

export interface SubmissionResponse {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly failureCode?: FailureCode;
  readonly balance?: MoneyProps;
  readonly idempotentReplay: boolean;
}

/**
 * O provedor decide pelo status: 200 aplicada, 202 aguardando referência,
 * 422 recusada por regra de negócio. O replay devolve o mesmo status do original.
 */
export function submissionStatus(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
    case WagerTransactionStatus.Pending:
      // Nenhuma linha é commitada em PENDING; chegar aqui é bug.
      throw new Error('Transação em PENDING não pode ser devolvida ao provedor');
  }
}

export function presentSubmission(result: WagerTransactionResult): SubmissionResponse {
  return {
    transactionId: result.transactionId,
    status: result.status,
    ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    ...(result.balance ? { balance: result.balance.toJSON() } : {}),
    idempotentReplay: result.idempotentReplay,
  };
}

export interface TransactionResponse {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly referenceTransactionId?: string;
  readonly status: WagerTransactionStatus;
  readonly failureCode?: FailureCode;
  readonly balance?: MoneyProps;
  readonly createdAt: string;
  readonly processedAt?: string;
}

export function presentTransaction(transaction: WagerTransaction): TransactionResponse {
  const optional = <K extends string, V>(key: K, value: V | undefined) =>
    (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    ...optional('referenceExternalTransactionId', transaction.referenceExternalTransactionId),
    ...optional('referenceTransactionId', transaction.referenceTransactionId),
    status: transaction.status,
    ...optional('failureCode', transaction.failureCode),
    ...optional('balance', transaction.resultingBalance?.toJSON()),
    createdAt: transaction.createdAt.toISOString(),
    ...optional('processedAt', transaction.processedAt?.toISOString()),
  };
}
