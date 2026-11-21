import { WalletAlreadyExistsError } from '../../src/application/errors';
import type { Clock } from '../../src/application/ports/clock.port';
import type { IdGenerator } from '../../src/application/ports/id-generator.port';
import type { Telemetry } from '../../src/application/ports/telemetry.port';
import type {
  InboxRepository,
  LedgerPage,
  LedgerPageQuery,
  LedgerRepository,
  OutboxRepository,
  PendingReferenceTicket,
  TransactionUpdateOptions,
  WagerTransactionRepository,
  WalletRepository,
} from '../../src/application/ports/repositories.port';
import type { TransactionScope, UnitOfWork, UnitOfWorkOptions } from '../../src/application/ports/unit-of-work.port';
import { InboxMessage, type InboxMessageState } from '../../src/domain/inbox-message';
import type { OutboxMessage } from '../../src/domain/outbox-message';
import {
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionState,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { Wallet, type WalletState } from '../../src/domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { Money } from '../../src/domain/money';

/**
 * Portas em memória para testes de UNIDADE do caso de uso: isolam a orquestração e a
 * ordem das regras. Não substituem o banco nos testes de integração e concorrência, que
 * continuam com Postgres real (é lá que lock, unicidade e triggers são provados).
 */

export interface StoredTransaction {
  readonly state: WagerTransactionState;
  readonly attempts: number;
  readonly nextAttemptInMs?: number;
}

interface Data {
  inbox: Map<string, InboxMessageState>;
  wallets: Map<string, WalletState>;
  transactions: Map<string, StoredTransaction>;
  ledger: WalletLedgerEntry[];
  outbox: OutboxMessage[];
}

const walletState = (wallet: Wallet): WalletState => ({
  id: wallet.id,
  playerId: wallet.playerId,
  currency: wallet.currency,
  balance: wallet.balance,
  version: wallet.version,
  createdAt: wallet.createdAt,
  updatedAt: wallet.updatedAt,
});

const transactionState = (tx: WagerTransaction): WagerTransactionState => ({
  id: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  idempotencyKey: tx.idempotencyKey,
  payloadHash: tx.payloadHash,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money,
  referenceExternalTransactionId: tx.referenceExternalTransactionId,
  createdAt: tx.createdAt,
  status: tx.status,
  referenceTransactionId: tx.referenceTransactionId,
  failureCode: tx.failureCode,
  processedAt: tx.processedAt,
  resultingBalance: tx.resultingBalance,
});

/** Banco em memória com UnitOfWork transacional: uma falha desfaz tudo o que a execução gravou. */
export class InMemoryDatabase implements UnitOfWork {
  private data: Data = { inbox: new Map(), wallets: new Map(), transactions: new Map(), ledger: [], outbox: [] };
  /** Falhas a lançar no início das próximas execuções (ex.: simular deadlock). */
  readonly failures: Error[] = [];
  runs = 0;

  async run<T>(work: (scope: TransactionScope) => Promise<T>, _options?: UnitOfWorkOptions): Promise<T> {
    this.runs += 1;
    const failure = this.failures.shift();
    if (failure) throw failure;
    const snapshot: Data = {
      inbox: new Map(this.data.inbox),
      wallets: new Map(this.data.wallets),
      transactions: new Map(this.data.transactions),
      ledger: [...this.data.ledger],
      outbox: [...this.data.outbox],
    };
    try {
      return await work(this.scope());
    } catch (error) {
      this.data = snapshot;
      throw error;
    }
  }

  // ---- leitura para as asserções

  wallet(walletId: string): Wallet {
    const state = this.data.wallets.get(walletId);
    if (!state) throw new Error(`wallet ${walletId} não existe`);
    return Wallet.rehydrate(state);
  }

  transaction(transactionId: string): StoredTransaction {
    const stored = this.data.transactions.get(transactionId);
    if (!stored) throw new Error(`transação ${transactionId} não existe`);
    return stored;
  }

  get transactions(): StoredTransaction[] {
    return [...this.data.transactions.values()];
  }

  get ledger(): readonly WalletLedgerEntry[] {
    return this.data.ledger;
  }

  get outbox(): readonly OutboxMessage[] {
    return this.data.outbox;
  }

  get inbox(): InboxMessage[] {
    return [...this.data.inbox.values()].map((state) => InboxMessage.rehydrate(state));
  }

  eventTypesFor(transactionId: string): string[] {
    return this.data.outbox
      .filter((message) => (message.payload as { causationId?: string }).causationId === transactionId)
      .map((message) => message.eventType);
  }

  /** Grava uma wallet já aberta (e seu lançamento de abertura) sem passar por caso de uso. */
  seedWallet(wallet: Wallet, openingEntry?: WalletLedgerEntry): void {
    this.data.wallets.set(wallet.id, walletState(wallet));
    if (openingEntry) this.data.ledger.push(openingEntry);
  }

  /** Força o vencimento de uma pendência, como se o tempo de backoff tivesse passado. */
  makeDue(transactionId: string): void {
    const stored = this.transaction(transactionId);
    this.data.transactions.set(transactionId, { ...stored, nextAttemptInMs: 0 });
  }

  private scope(): TransactionScope {
    const data = this.data;

    const wallets: WalletRepository = {
      async insert(wallet) {
        for (const existing of data.wallets.values()) {
          if (existing.playerId === wallet.playerId && existing.currency === wallet.currency) {
            throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
          }
        }
        data.wallets.set(wallet.id, walletState(wallet));
      },
      async findById(walletId) {
        const state = data.wallets.get(walletId);
        return state ? Wallet.rehydrate(state) : null;
      },
      async findByIdForUpdate(walletId) {
        return wallets.findById(walletId);
      },
      async update(wallet) {
        data.wallets.set(wallet.id, walletState(wallet));
      },
    };

    const find = (predicate: (state: WagerTransactionState) => boolean) => {
      for (const { state } of data.transactions.values()) {
        if (predicate(state)) return WagerTransaction.rehydrate(state);
      }
      return null;
    };

    const transactions: WagerTransactionRepository = {
      async insert(transaction) {
        data.transactions.set(transaction.id, { state: transactionState(transaction), attempts: 0 });
      },
      async insertIfAbsent(transaction) {
        const conflict = find(
          (s) =>
            s.providerId === transaction.providerId &&
            (s.idempotencyKey === transaction.idempotencyKey ||
              s.externalTransactionId === transaction.externalTransactionId),
        );
        if (conflict) return false;
        await transactions.insert(transaction);
        return true;
      },
      async update(transaction, options: TransactionUpdateOptions = {}) {
        const stored = data.transactions.get(transaction.id);
        if (!stored) throw new Error(`transação ${transaction.id} não existe`);
        data.transactions.set(transaction.id, {
          state: transactionState(transaction),
          attempts: options.schedule?.attempts ?? stored.attempts,
          nextAttemptInMs: options.schedule?.nextAttemptInMs ?? stored.nextAttemptInMs,
        });
      },
      async findById(transactionId) {
        return find((s) => s.id === transactionId);
      },
      async findByIdempotencyKey(providerId, idempotencyKey) {
        return find((s) => s.providerId === providerId && s.idempotencyKey === idempotencyKey);
      },
      async findByExternalId(providerId, externalTransactionId) {
        return find((s) => s.providerId === providerId && s.externalTransactionId === externalTransactionId);
      },
      async isReversed(referenceTransactionId) {
        return (
          find(
            (s) =>
              s.referenceTransactionId === referenceTransactionId &&
              (s.kind === WagerTransactionKind.Refund || s.kind === WagerTransactionKind.Rollback) &&
              s.status === WagerTransactionStatus.Processed,
          ) !== null
        );
      },
      async findPendingForUpdate(transactionId): Promise<PendingReferenceTicket | null> {
        const stored = data.transactions.get(transactionId);
        if (stored?.state.status !== WagerTransactionStatus.PendingReference) return null;
        return { transaction: WagerTransaction.rehydrate(stored.state), attempts: stored.attempts };
      },
    };

    const ledger: LedgerRepository = {
      async append(entry) {
        data.ledger.push(entry);
      },
      async summarize(walletId, currency) {
        const entries = data.ledger.filter((entry) => entry.walletId === walletId);
        const sum = (direction: LedgerDirection) =>
          entries.filter((e) => e.direction === direction).reduce((total, e) => total.add(e.money), Money.zero(currency));
        return { credits: sum(LedgerDirection.Credit), debits: sum(LedgerDirection.Debit), entries: entries.length };
      },
      async page(walletId: string, _currency: string, query: LedgerPageQuery): Promise<LedgerPage> {
        const entries = data.ledger
          .map((entry, index) => ({ entry, position: BigInt(index + 1) }))
          .filter(({ entry, position }) => entry.walletId === walletId && (!query.before || position < query.before))
          .reverse();
        return { entries: entries.slice(0, query.limit), hasMore: entries.length > query.limit };
      },
    };

    const outbox: OutboxRepository = {
      async enqueue(messages) {
        data.outbox.push(...messages);
      },
    };

    const inboxKey = (consumerName: string, messageId: string) => `${consumerName}\u0000${messageId}`;
    const inboxState = (message: InboxMessage): InboxMessageState => ({
      messageId: message.messageId,
      consumerName: message.consumerName,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt,
    });
    const inbox: InboxRepository = {
      async insertIfAbsent(message) {
        const key = inboxKey(message.consumerName, message.messageId);
        if (data.inbox.has(key)) return false;
        data.inbox.set(key, inboxState(message));
        return true;
      },
      async find(consumerName, messageId) {
        const state = data.inbox.get(inboxKey(consumerName, messageId));
        return state ? InboxMessage.rehydrate(state) : null;
      },
      async markProcessed(message) {
        data.inbox.set(inboxKey(message.consumerName, message.messageId), inboxState(message));
      },
    };

    return { wallets, transactions, ledger, outbox, inbox };
  }
}

export class FixedClock implements Clock {
  constructor(private current = new Date('2026-11-21T12:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIds implements IdGenerator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `id-${String(this.counter).padStart(6, '0')}`;
  }
}

/** Telemetria que só registra as chamadas, para os testes conferirem os sinais emitidos. */
export class RecordingTelemetry implements Telemetry {
  readonly calls: Array<[string, ...unknown[]]> = [];

  transactionDecided(status: string, kind: string): void {
    this.calls.push(['transactionDecided', status, kind]);
  }
  duplicateDetected(source: string): void {
    this.calls.push(['duplicateDetected', source]);
  }
  retryScheduled(type: string): void {
    this.calls.push(['retryScheduled', type]);
  }
  deadLettered(reason: string): void {
    this.calls.push(['deadLettered', reason]);
  }
  lockConflict(type: string): void {
    this.calls.push(['lockConflict', type]);
  }
  processingDuration(source: string): void {
    this.calls.push(['processingDuration', source]);
  }
  walletDivergence(report: { walletId: string; checkedEntries: number }): void {
    this.calls.push(['walletDivergence', report.walletId, report.checkedEntries]);
  }

  /** Chamadas sem as de duração (o valor varia a cada execução). */
  signals(): Array<[string, ...unknown[]]> {
    return this.calls.filter(([name]) => name !== 'processingDuration');
  }
}
