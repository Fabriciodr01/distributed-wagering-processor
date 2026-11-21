import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from './repositories.port';

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

/** Repositórios ligados a uma única transação SQL. */
export interface TransactionScope {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly outbox: OutboxRepository;
  readonly inbox: InboxRepository;
}

export interface UnitOfWorkOptions {
  /** Snapshot único para leituras que precisam ser consistentes entre si. */
  readonly isolation?: 'read committed' | 'repeatable read';
  readonly readOnly?: boolean;
}

/**
 * Executa `work` numa transação SQL: tudo é confirmado junto ou nada é.
 * Falhas de infraestrutura chegam como `TransientFailureError`.
 */
export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
