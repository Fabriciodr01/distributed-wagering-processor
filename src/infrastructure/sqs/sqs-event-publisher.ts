import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import type { EventPublisher } from '../../application/ports/outbox.port';
import type { AppConfig } from '../../config/app-config';
import { APP_CONFIG } from '../../config/config.module';
import type { OutboxMessage } from '../../domain/outbox-message';
import { resolveQueueUrl } from './queue-setup';
import { SQS_CLIENT } from './sqs.tokens';

/**
 * Publica na fila FIFO de eventos. O grupo é a wallet (ordem por wallet dentro do broker)
 * e a deduplicação é o eventId: republicar o mesmo evento dentro da janela do FIFO não
 * gera segunda entrega, e fora dela o consumidor deduplica pelo mesmo id.
 */
@Injectable()
export class SqsEventPublisher implements EventPublisher {
  private queueUrl?: string;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.url(),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
  }

  private async url(): Promise<string> {
    // Só guarda depois de resolver: se a fila ainda não existe, tenta de novo na próxima.
    this.queueUrl ??= await resolveQueueUrl(this.sqs, this.config.sqs.queues.events);
    return this.queueUrl;
  }
}
