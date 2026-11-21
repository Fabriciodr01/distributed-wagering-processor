import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { withDatabaseErrors } from './database-errors';

/**
 * Reserva transações PENDING_REFERENCE vencidas para esta instância, por um lease.
 * `FOR UPDATE SKIP LOCKED` faz instâncias concorrentes pegarem lotes disjuntos; se a
 * instância morrer, o lease expira e outra assume. A reavaliação em si acontece depois,
 * em transação própria, e confere de novo o estado com a linha travada.
 */
@Injectable()
export class PendingReferenceClaims {
  constructor(private readonly orm: MikroORM) {}

  async claimDue(limit: number, leaseMs: number): Promise<string[]> {
    const rows = await withDatabaseErrors(() =>
      this.orm.em.fork().execute<Array<{ id: string }>>(
        `UPDATE wager_transactions
            SET lease_until = now() + (?::int * interval '1 millisecond')
          WHERE id IN (
            SELECT id FROM wager_transactions
             WHERE status = 'PENDING_REFERENCE'
               AND next_attempt_at <= now()
               AND (lease_until IS NULL OR lease_until < now())
             ORDER BY next_attempt_at
             LIMIT ?::int
             FOR UPDATE SKIP LOCKED
          )
          RETURNING id`,
        [leaseMs, limit],
      ),
    );
    return rows.map((row) => row.id);
  }
}
