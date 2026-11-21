/**
 * Erros de domínio. Indicam uso inválido do modelo (entrada fora do contrato ou
 * transição proibida); regras de negócio que viram REJECTED são decididas pelo
 * caso de uso com `FailureCode`, não com exceção.
 */
export abstract class DomainError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(
    readonly expected: string,
    readonly received: string,
  ) {
    super(`Moeda incompatível: esperado ${expected}, recebido ${received}`);
  }
}

export class MoneyOverflowError extends DomainError {
  constructor() {
    super('Valor monetário excede a precisão suportada (18 dígitos inteiros)');
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(readonly walletId: string) {
    super(`Saldo insuficiente na wallet ${walletId}`);
  }
}

export class InvalidWalletOperationError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

export class InvalidWagerTransactionError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(
    readonly transactionId: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Transição inválida da transação ${transactionId}: ${from} → ${to}`);
  }
}

export class InvalidMessageStateError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}
