import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { type PublishOutboxResult, PublishOutboxUseCase } from '../../application/outbox/publish-outbox.usecase';
import type { AppConfig } from '../../config/app-config';
import { APP_CONFIG } from '../../config/config.module';
import { PollingLoop } from './polling-loop';

/** Único caminho de publicação de eventos: nada sai para o broker antes do commit. */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private readonly loop: PollingLoop;

  constructor(
    private readonly useCase: PublishOutboxUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.loop = new PollingLoop(
      config.outbox.pollIntervalMs,
      async () => (await this.runOnce()).claimed === config.outbox.batchSize,
      (error) => this.logger.warn(`Rodada do publisher falhou: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  onApplicationBootstrap(): void {
    if (this.config.roles.outboxPublisher) this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  async runOnce(): Promise<PublishOutboxResult> {
    const result = await this.useCase.publishDue(this.config.outbox.batchSize, this.config.outbox.leaseMs);
    if (result.failed > 0) this.logger.warn(`${result.failed} evento(s) não publicados; nova tentativa agendada`);
    return result;
  }
}
