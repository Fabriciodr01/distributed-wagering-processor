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
