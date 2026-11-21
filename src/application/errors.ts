/**
 * Erros da camada de aplicação. Cada um corresponde a um código estável da API;
 * o mapeamento para HTTP fica na borda.
 */
export abstract class ApplicationError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} não encontrada`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(`O player ${playerId} já tem uma wallet em ${currency}`);
  }
}

export class InvalidCursorError extends ApplicationError {
  constructor() {
    super('Cursor de paginação inválido');
  }
}

export type TransientFailureKind = 'unavailable' | 'lock_timeout' | 'deadlock';

/** Falha de infraestrutura que pode dar certo se repetida (Postgres fora, lock, deadlock). */
export class TransientFailureError extends ApplicationError {
  constructor(
    readonly kind: TransientFailureKind,
    options?: { cause?: unknown },
  ) {
    super(`Falha transitória de infraestrutura (${kind})`);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export class TransactionNotFoundError extends ApplicationError {
  constructor() {
    super('Transação não encontrada');
  }
}

/** Requisição de transação fora do contrato (ex.: REFUND sem referência). Nada é persistido. */
export class InvalidWagerRequestError extends ApplicationError {
  constructor(message: string) {
    super(message);
  }
}

/** A mesma chave de idempotência já foi usada com outro payload: é conflito, não replay. */
export class IdempotencyKeyConflictError extends ApplicationError {
  constructor(
    readonly providerId: string,
    readonly existingTransactionId: string,
  ) {
    super(`Idempotency-Key já usada pelo provider ${providerId} com outro payload`);
  }
}

/** O mesmo externalTransactionId já existe no provider com outro payload. */
export class ExternalTransactionConflictError extends ApplicationError {
  constructor(
    readonly providerId: string,
    readonly existingTransactionId: string,
  ) {
    super(`externalTransactionId já usado pelo provider ${providerId} com outro payload`);
  }
}

/** A identidade autenticada não pode agir em nome do provider do payload. */
export class ProviderNotAllowedError extends ApplicationError {
  constructor(readonly providerId: string) {
    super(`Credencial não autorizada para o provider ${providerId}`);
  }
}
