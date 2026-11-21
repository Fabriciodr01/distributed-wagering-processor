import type { FailureCode } from '../../domain/failure-code';
import type { Money } from '../../domain/money';
import type { WagerTransaction, WagerTransactionStatus } from '../../domain/wager-transaction';

export interface WagerTransactionResult {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly failureCode?: FailureCode;
  /** Saldo observado quando a transação foi decidida; um replay devolve o mesmo. */
  readonly balance?: Money;
  readonly idempotentReplay: boolean;
}

export function resultOf(transaction: WagerTransaction, idempotentReplay: boolean): WagerTransactionResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    failureCode: transaction.failureCode,
    balance: transaction.resultingBalance,
    idempotentReplay,
  };
}
