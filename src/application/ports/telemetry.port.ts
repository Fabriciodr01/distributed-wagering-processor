import type { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';

export const TELEMETRY = Symbol('TELEMETRY');

export type IngressSource = 'http' | 'sqs';
export type RetryType = 'consumer' | 'pending_reference' | 'outbox';
export type LockConflictType = 'lock_timeout' | 'deadlock';

/**
 * Sinais operacionais emitidos pela aplicação e pelas bordas. Nunca carregam valores
 * financeiros: só ids, tipos e contagens.
 */
export interface Telemetry {
  /** Uma transação foi decidida e commitada (não conta replays). */
  transactionDecided(status: WagerTransactionStatus, kind: WagerTransactionKind): void;
  /** Pedido repetido reconhecido: replay de idempotência ou redelivery do inbox. */
  duplicateDetected(source: IngressSource): void;
  retryScheduled(type: RetryType): void;
  deadLettered(reason: string): void;
  lockConflict(type: LockConflictType): void;
  processingDuration(source: IngressSource, seconds: number): void;
  /** Saldo materializado diferente do ledger: precisa de alguém olhando, nunca é corrigido sozinho. */
  walletDivergence(report: { walletId: string; checkedEntries: number }): void;
}
