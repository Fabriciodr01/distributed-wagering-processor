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

  async update(transaction: WagerTransaction, options: TransactionUpdateOptions = {}): Promise<void> {
    const row = WagerTransactionMapper.fromDomain(transaction);
    const { schedule } = options;
    if (schedule) {
      // Antes do status: depois de terminal, o trigger não deixa a linha mudar mais.
      // Relógio do banco, que é o que os workers de todas as instâncias comparam. O lease é
      // liberado porque a avaliação que o reservou terminou.
      await this.em.execute(
        `UPDATE wager_transactions
            SET attempts = ?,
                next_attempt_at = CASE WHEN ?::int IS NULL THEN next_attempt_at
                                       ELSE now() + (?::int * interval '1 millisecond') END,
                lease_until = NULL
          WHERE id = ?`,
        [schedule.attempts, schedule.nextAttemptInMs ?? null, schedule.nextAttemptInMs ?? null, transaction.id],
      );
    }
    await this.em.nativeUpdate(
      WagerTransactionRow,
      { id: transaction.id },
      {
        status: row.status,
        failureCode: row.failureCode,
        resultingBalance: row.resultingBalance,
        referenceTransactionId: row.referenceTransactionId,
        processedAt: row.processedAt,
        // Qualquer decisão encerra a avaliação que reservou a linha.
        leaseUntil: null,
      },
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

  private async findOne(where: Partial<WagerTransactionRow>): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRow, where, { refresh: true });
    return row ? WagerTransactionMapper.toDomain(row) : null;
  }
}
