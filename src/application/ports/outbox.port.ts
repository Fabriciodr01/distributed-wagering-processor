import type { OutboxMessage } from '../../domain/outbox-message';

export const OUTBOX_STORE = Symbol('OUTBOX_STORE');
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

export interface ClaimedOutboxBatch {
  readonly messages: readonly OutboxMessage[];
  /** Relógio do banco no momento da reserva; base dos agendamentos de retry. */
  readonly now: Date;
}

/** Acesso da publicação à outbox, fora das transações financeiras. */
export interface OutboxStore {
  /** Reserva até `limit` eventos vencidos para esta instância por `leaseMs`, em ordem de gravação. */
  claimDue(limit: number, leaseMs: number): Promise<ClaimedOutboxBatch>;
  markPublished(message: OutboxMessage): Promise<void>;
  /** Grava o novo agendamento (attempts, nextAttemptAt) e libera o lease. */
  scheduleRetry(message: OutboxMessage, lastError: string): Promise<void>;
  /** Idade, em segundos, do evento não publicado mais antigo (0 sem pendências). */
  lagSeconds(): Promise<number>;
}

/** Envia um evento ao broker. Pode lançar: quem chama agenda a nova tentativa. */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}
