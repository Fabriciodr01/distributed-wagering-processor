import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { TransientFailureError } from '../../application/errors';
import { ProcessWagerTransactionUseCase } from '../../application/wagering/process-wager-transaction.usecase';
import type { AppConfig } from '../../config/app-config';
import { APP_CONFIG } from '../../config/config.module';
import { runWithLogContext } from '../observability/log-context';
import { PendingReferenceClaims } from '../persistence/pending-reference-claims';
import { PollingLoop } from './polling-loop';

/**
 * Reavalia transações PENDING_REFERENCE vencidas com o mesmo caso de uso da submissão.
 * O backoff e o limite de tentativas são do caso de uso; aqui só se reserva e despacha.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private readonly loop: PollingLoop;

  constructor(
    private readonly claims: PendingReferenceClaims,
    private readonly useCase: ProcessWagerTransactionUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.loop = new PollingLoop(
      config.pendingReference.pollIntervalMs,
      async () => (await this.runOnce()) === config.pendingReference.batchSize,
      (error) => this.logger.warn(`Rodada do worker falhou: ${describe(error)}`),
    );
  }

  onApplicationBootstrap(): void {
    if (this.config.roles.pendingReferenceWorker) this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  /** Uma rodada: reserva um lote e reavalia cada item. Devolve quantos foram reservados. */
  async runOnce(): Promise<number> {
    const { batchSize, leaseMs } = this.config.pendingReference;
    const ids = await this.claims.claimDue(batchSize, leaseMs);
    for (const id of ids) {
      await runWithLogContext({ transactionId: id, correlationId: id }, () => this.reprocess(id));
    }
    return ids.length;
  }

  private async reprocess(transactionId: string): Promise<void> {
    try {
      await this.useCase.reprocessPendingReference(transactionId);
    } catch (error) {
      if (error instanceof TransientFailureError) {
        // Sem contar tentativa: o lease expira e a transação volta a ser elegível.
        this.logger.warn(`Reavaliação de ${transactionId} adiada: ${error.kind}`);
        return;
      }
      this.logger.error(`Reavaliação de ${transactionId} falhou: ${describe(error)}`);
      await this.useCase.recordReprocessFailure(transactionId).catch((recordError: unknown) => {
        this.logger.error(`Não foi possível registrar a falha de ${transactionId}: ${describe(recordError)}`);
      });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
