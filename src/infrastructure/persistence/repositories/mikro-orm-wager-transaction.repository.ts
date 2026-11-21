import { LockMode, type SqlEntityManager } from '@mikro-orm/postgresql';
import type {
  PendingReferenceTicket,
  TransactionUpdateOptions,
  WagerTransactionRepository,
} from '../../../application/ports/repositories.port';
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wager-transaction';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper';
import { WagerTransactionRow } from '../rows/wager-transaction.row';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRow, WagerTransactionMapper.fromDomain(transaction));
  }

  async insertIfAbsent(transaction: WagerTransaction): Promise<boolean> {
    // Sem alvo no ON CONFLICT: cobre as duas unicidades (chave de idempotência e
    // externalTransactionId). Se outra transação concorrente estiver inserindo a mesma
    // chave, o Postgres espera ela terminar antes de decidir.
    const result = await this.em
      .createQueryBuilder(WagerTransactionRow)
      .insert(WagerTransactionMapper.fromDomain(transaction))
      .onConflict()
      .ignore()
      .execute('run');
    return result.affectedRows === 1;
  }

  /**
   * Resultado e agendamento num único UPDATE: a linha passa de um estado coerente para
   * outro, sem depender da ordem de comandos (depois de terminal, o trigger não deixa mudar).
   * `next_attempt_at` usa o relógio do banco, que é o que os workers de todas as instâncias
   * comparam, e o lease é liberado porque a avaliação que o reservou terminou.
   */
  async update(transaction: WagerTransaction, options: TransactionUpdateOptions = {}): Promise<void> {
    const row = WagerTransactionMapper.fromDomain(transaction);
    const attempts = options.schedule?.attempts ?? null;
    const nextAttemptInMs = options.schedule?.nextAttemptInMs ?? null;
    await this.em.execute(
      `UPDATE wager_transactions
          SET status = ?,
              failure_code = ?,
              resulting_balance = ?::numeric(20, 2),
              reference_transaction_id = ?::uuid,
              processed_at = ?::timestamptz,
              attempts = COALESCE(?::int, attempts),
              next_attempt_at = CASE WHEN ?::int IS NULL THEN next_attempt_at
                                     ELSE now() + (?::int * interval '1 millisecond') END,
              lease_until = NULL
        WHERE id = ?`,
      [
        row.status,
        row.failureCode,
        row.resultingBalance,
        row.referenceTransactionId,
        row.processedAt,
        attempts,
        nextAttemptInMs,
        nextAttemptInMs,
        transaction.id,
      ],
    );
  }

  async findById(transactionId: string): Promise<WagerTransaction | null> {
    return this.findOne({ id: transactionId });
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null> {
    return this.findOne({ providerId, idempotencyKey });
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async isReversed(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRow, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async findPendingForUpdate(transactionId: string): Promise<PendingReferenceTicket | null> {
    const row = await this.em.findOne(
      WagerTransactionRow,
      { id: transactionId, status: WagerTransactionStatus.PendingReference },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return row ? { transaction: WagerTransactionMapper.toDomain(row), attempts: row.attempts } : null;
  }

  /**
   * Só antecipa (nunca adia) e não mexe em `attempts` nem no lease: uma dependente já
   * reservada por outro worker continua com ele. Usa o índice parcial
   * `wager_transactions_pending_by_reference`.
   */
  async wakeDependents(providerId: string, externalTransactionId: string): Promise<number> {
    const result = await this.em.execute(
      `UPDATE wager_transactions
          SET next_attempt_at = now()
        WHERE status = 'PENDING_REFERENCE'
          AND provider_id = ?
          AND reference_external_transaction_id = ?
          AND next_attempt_at > now()`,
      [providerId, externalTransactionId],
      'run',
    );
    return Number((result as { affectedRows?: number }).affectedRows ?? 0);
  }

  private async findOne(where: Partial<WagerTransactionRow>): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRow, where, { refresh: true });
    return row ? WagerTransactionMapper.toDomain(row) : null;
  }
}
