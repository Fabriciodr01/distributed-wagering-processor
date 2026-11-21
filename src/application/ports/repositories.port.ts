import type { OutboxMessage } from '../../domain/outbox-message';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface WalletRepository {
  /** Lança `WalletAlreadyExistsError` se o player já tem wallet nessa moeda. */
  insert(wallet: Wallet): Promise<void>;
  findById(walletId: string): Promise<Wallet | null>;
  /**
   * Lê a wallet travando a linha (`SELECT ... FOR UPDATE`) até o fim da transação.
   * É o ponto de serialização de tudo que mexe na wallet.
   */
  findByIdForUpdate(walletId: string): Promise<Wallet | null>;
  /** Persiste saldo, version e updatedAt depois de uma movimentação. */
  update(wallet: Wallet): Promise<void>;
}

export interface TransactionUpdateOptions {
  /** Agenda a próxima reavaliação de PENDING_REFERENCE a partir do relógio do banco. */
  readonly nextAttemptInMs?: number;
}

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
  /**
   * Insere se não existir outra com a mesma chave de idempotência ou o mesmo
   * externalTransactionId no provider. Devolve false quando havia conflito.
   */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;
  /** Persiste o resultado (status, código, saldo observado, referência resolvida). */
  update(transaction: WagerTransaction, options?: TransactionUpdateOptions): Promise<void>;
  findById(transactionId: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** true se a transação já foi revertida por um REFUND ou ROLLBACK aplicado. */
  isReversed(referenceTransactionId: string): Promise<boolean>;
}

export interface LedgerPageQuery {
  readonly limit: number;
  /** Devolve só lançamentos anteriores a esta posição (keyset, mais recentes primeiro). */
  readonly before?: bigint;
}

export interface LedgerPage {
  readonly entries: readonly PositionedLedgerEntry[];
  readonly hasMore: boolean;
}

export interface PositionedLedgerEntry {
  readonly entry: WalletLedgerEntry;
  /** Ordem total de inserção no ledger; base do cursor de paginação. */
  readonly position: bigint;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  page(walletId: string, currency: string, query: LedgerPageQuery): Promise<LedgerPage>;
}

export interface OutboxRepository {
  /** Grava os eventos na mesma transação da alteração financeira; quem publica é o worker. */
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
}
