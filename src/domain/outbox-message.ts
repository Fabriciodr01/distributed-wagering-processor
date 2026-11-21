import { InvalidMessageStateError } from './errors';
import type { IntegrationEvent } from './events/integration-event';
import { deepFreeze } from './events/deep-freeze';

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date;
  readonly publishedAt?: Date;
}

export interface OutboxRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** 1 s, 2 s, 4 s... limitado a 60 s. */
export const DEFAULT_OUTBOX_RETRY_POLICY: OutboxRetryPolicy = {
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
};

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O id da mensagem é o eventId: publicar duas vezes gera o mesmo id para o consumidor. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = event.toJSON() as unknown as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      deepFreeze(structuredClone(payload)),
      new Date(event.occurredAt.getTime()),
      0,
      new Date(event.occurredAt.getTime()),
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      deepFreeze(structuredClone(state.payload)),
      new Date(state.occurredAt.getTime()),
      state.attempts,
      state.nextAttemptAt ? new Date(state.nextAttemptAt.getTime()) : undefined,
      state.publishedAt ? new Date(state.publishedAt.getTime()) : undefined,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt ? new Date(this._nextAttemptAt.getTime()) : undefined;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt ? new Date(this._publishedAt.getTime()) : undefined;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`Evento ${this.id} já foi publicado`);
    }
    this._publishedAt = new Date(at.getTime());
  }

  /** Incrementa attempts e agenda a próxima tentativa com backoff exponencial limitado. */
  scheduleRetry(now: Date, policy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY_POLICY): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`Evento ${this.id} já foi publicado`);
    }
    this._attempts += 1;
    const delay = Math.min(policy.baseDelayMs * 2 ** (this._attempts - 1), policy.maxDelayMs);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
