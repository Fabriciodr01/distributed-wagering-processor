/** Códigos de erro da API. São contrato: estáveis, em inglês, nunca renomeados. */
export enum ApiErrorCode {
  ValidationError = 'VALIDATION_ERROR',
  WalletNotFound = 'WALLET_NOT_FOUND',
  TransactionNotFound = 'TRANSACTION_NOT_FOUND',
  IdempotencyKeyConflict = 'IDEMPOTENCY_KEY_CONFLICT',
  ExternalTransactionConflict = 'EXTERNAL_TRANSACTION_CONFLICT',
  WalletAlreadyExists = 'WALLET_ALREADY_EXISTS',
  NotFound = 'NOT_FOUND',
  ServiceUnavailable = 'SERVICE_UNAVAILABLE',
  InternalError = 'INTERNAL_ERROR',
}

export interface ApiErrorDetail {
  readonly field: string;
  readonly message: string;
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly ApiErrorDetail[];
  };
}
