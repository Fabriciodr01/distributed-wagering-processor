import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config/app-config';
import { APP_CONFIG } from '../../config/config.module';
import { createSqsClient } from './sqs-client';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createSqsClient(config.sqs),
    },
  ],
  exports: [SQS_CLIENT],
})
export class SqsModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
