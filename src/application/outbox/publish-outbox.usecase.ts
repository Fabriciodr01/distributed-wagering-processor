import type { OutboxRetryPolicy } from '../../domain/outbox-message';
import type { EventPublisher, OutboxStore } from '../ports/outbox.port';
import type { Telemetry } from '../ports/telemetry.port';

export interface PublishOutboxResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

/**
 * Publica eventos já confirmados na outbox. Entrega at-least-once: se a instância morrer
 * depois de enviar e antes de marcar, o lease expira e o evento sai de novo, com o mesmo
 * eventId (o consumidor deduplica por ele).
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly retryPolicy: OutboxRetryPolicy,
    private readonly telemetry: Telemetry,
  ) {}

  async publishDue(limit: number, leaseMs: number): Promise<PublishOutboxResult> {
    const { messages, now } = await this.store.claimDue(limit, leaseMs);
    let published = 0;
    for (const message of messages) {
      try {
        await this.publisher.publish(message);
      } catch (error) {
        message.scheduleRetry(now, this.retryPolicy);
        await this.store.scheduleRetry(message, error instanceof Error ? error.message : String(error));
        this.telemetry.retryScheduled('outbox');
        continue;
      }
      message.markPublished(now);
      await this.store.markPublished(message);
      published += 1;
    }
    return { claimed: messages.length, published, failed: messages.length - published };
  }
}
