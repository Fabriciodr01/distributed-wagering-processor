import { Inject, Injectable, Logger } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { OUTBOX_STORE, type OutboxStore } from '../../application/ports/outbox.port';
import type {
  IngressSource,
  LockConflictType,
  LockOperation,
  RetryType,
  Telemetry,
} from '../../application/ports/telemetry.port';
import type { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';

/**
 * Métricas no formato Prometheus, num registro próprio por aplicação (várias instâncias
 * no mesmo processo de teste não disputam o registro global).
 */
@Injectable()
export class PrometheusTelemetry implements Telemetry {
  private readonly logger = new Logger('Telemetry');
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações decididas, por status e tipo',
    labelNames: ['status', 'kind'] as const,
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Pedidos repetidos reconhecidos (replay de idempotência ou redelivery do inbox)',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Novas tentativas agendadas',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  private readonly deadLetters = new Counter({
    name: 'wager_dlq_messages_total',
    help: 'Mensagens enviadas à DLQ, por motivo',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'Conflitos de lock (timeout ou deadlock)',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  private readonly duration = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Latência de processamento de uma transação, por origem',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly lockWait = new Histogram({
    name: 'wager_wallet_lock_wait_seconds',
    help: 'Espera pelo lock da wallet (SELECT … FOR UPDATE), por operação',
    labelNames: ['operation'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly divergences = new Counter({
    name: 'wallet_reconciliation_divergences_total',
    help: 'Reconciliações em que o saldo da wallet divergiu do ledger',
    registers: [this.registry],
  });

  constructor(@Inject(OUTBOX_STORE) outbox: OutboxStore) {
    const logger = this.logger;
    new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Idade do evento não publicado mais antigo da outbox',
      registers: [this.registry],
      // Calculado na hora da coleta, direto no banco: vale para todas as instâncias.
      async collect() {
        try {
          this.set(await outbox.lagSeconds());
        } catch (error) {
          logger.warn(`Não foi possível medir o lag da outbox: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
  }

  transactionDecided(status: WagerTransactionStatus, kind: WagerTransactionKind): void {
    this.transactions.inc({ status, kind });
  }

  duplicateDetected(source: IngressSource): void {
    this.duplicates.inc({ source });
  }

  retryScheduled(type: RetryType): void {
    this.retries.inc({ type });
  }

  deadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }

  lockConflict(type: LockConflictType): void {
    this.lockConflicts.inc({ type });
  }

  processingDuration(source: IngressSource, seconds: number): void {
    this.duration.observe({ source }, seconds);
  }

  walletLockWait(operation: LockOperation, seconds: number): void {
    this.lockWait.observe({ operation }, seconds);
  }

  walletDivergence(report: { walletId: string; checkedEntries: number }): void {
    this.divergences.inc();
    this.logger.error(
      { walletId: report.walletId, checkedEntries: report.checkedEntries },
      'Saldo da wallet diverge do ledger; nada foi corrigido',
    );
  }
}
