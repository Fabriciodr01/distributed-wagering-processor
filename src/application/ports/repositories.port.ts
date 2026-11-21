import type { InboxMessage } from '../../domain/inbox-message';
import type { Money } from '../../domain/money';
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

/** Agendamento de uma transação PENDING_REFERENCE; o lease do worker é liberado junto. */
export interface ReferenceRetrySchedule {
  /** Avaliações já feitas, contando a da submissão. */
  readonly attempts: number;
  /** Próxima reavaliação, a partir do relógio do banco (comum a todas as instâncias). */
  readonly nextAttemptInMs?: number;
}

export interface TransactionUpdateOptions {
  readonly schedule?: ReferenceRetrySchedule;
}

/** Transação aguardando referência, travada para reavaliação. */
export interface PendingReferenceTicket {
  readonly transaction: WagerTransaction;
  readonly attempts: number;
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
  /** Trava a linha se ela ainda estiver PENDING_REFERENCE; null se já foi decidida. */
  findPendingForUpdate(transactionId: string): Promise<PendingReferenceTicket | null>;
  /**
   * Antecipa para agora a próxima reavaliação das transações PENDING_REFERENCE que
   * referenciam `(providerId, externalTransactionId)`. Chamado na mesma transação que
   * decide a referência: o worker as pega na próxima rodada, sem esperar o backoff.
   * Devolve quantas foram antecipadas.
   */
  wakeDependents(providerId: string, externalTransactionId: string): Promise<number>;
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

/** Totais do ledger de uma wallet, somados em numeric no banco (créditos e débitos separados). */
export interface LedgerSummary {
  readonly credits: Money;
  readonly debits: Money;
  readonly entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
  page(walletId: string, currency: string, query: LedgerPageQuery): Promise<LedgerPage>;
}

export interface InboxRepository {
  /**
   * Reserva (consumerName, messageId) na transação corrente. false = a mensagem já foi
   * vista; se outra transação estiver gravando a mesma chave, espera ela terminar.
   */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  /** Grava os eventos na mesma transação da alteração financeira; quem publica é o worker. */
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
}
