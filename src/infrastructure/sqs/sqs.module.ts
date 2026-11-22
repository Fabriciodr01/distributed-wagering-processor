import type { SQSClient } from '@aws-sdk/client-sqs';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { EVENT_PUBLISHER } from '../../application/ports/outbox.port';
import type { AppConfig } from '../../config/app-config';
import { APP_CONFIG } from '../../config/config.module';
import { SQS_CLIENT } from './sqs.tokens';
import { createSqsClient } from './sqs-client';
import { SqsEventPublisher } from './sqs-event-publisher';

@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createSqsClient(config.sqs),
    },
    { provide: EVENT_PUBLISHER, useClass: SqsEventPublisher },
  ],
  exports: [SQS_CLIENT, EVENT_PUBLISHER],
})
export class SqsModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
