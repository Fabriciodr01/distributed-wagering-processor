import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { ClaimedOutboxBatch, OutboxStore } from '../../application/ports/outbox.port';
import { OutboxMessage } from '../../domain/outbox-message';
import { withDatabaseErrors } from './database-errors';

// SQL cru não passa pela hidratação do ORM: datas e jsonb podem chegar como texto.
interface ClaimedRow {
  id: string;
  seq: string | bigint;
  aggregate_id: string;
  event_type: string;
  payload: string | Record<string, unknown>;
  occurred_at: string | Date;
  attempts: number;
  next_attempt_at: string | Date;
  db_now: string | Date;
}

const toDate = (value: string | Date): Date => (value instanceof Date ? value : new Date(value));
const toJson = (value: string | Record<string, unknown>): Record<string, unknown> =>
  typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : value;

/**
 * Cada operação é um comando curto e autônomo: a transação nunca fica aberta enquanto
 * o SQS responde. A exclusão entre publishers vem do lease (`FOR UPDATE SKIP LOCKED` na
 * reserva); as marcações só valem para eventos ainda não publicados.
 */
@Injectable()
export class MikroOrmOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async claimDue(limit: number, leaseMs: number): Promise<ClaimedOutboxBatch> {
    const rows = await this.execute<ClaimedRow[]>(
      `UPDATE outbox_messages
          SET locked_until = now() + (?::int * interval '1 millisecond')
        WHERE id IN (
          SELECT id FROM outbox_messages
           WHERE published_at IS NULL
             AND next_attempt_at <= now()
             AND (locked_until IS NULL OR locked_until < now())
           ORDER BY seq
           LIMIT ?::int
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, seq, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, now() AS db_now`,
      [leaseMs, limit],
    );
    // RETURNING não garante ordem: reordena pela ordem de gravação.
    rows.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
    return {
      now: rows[0] ? toDate(rows[0].db_now) : await this.databaseNow(),
      messages: rows.map((row) =>
        OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: toJson(row.payload),
          occurredAt: toDate(row.occurred_at),
          attempts: Number(row.attempts),
          nextAttemptAt: toDate(row.next_attempt_at),
        }),
      ),
    };
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.execute(
      `UPDATE outbox_messages SET published_at = now(), locked_until = NULL
        WHERE id = ? AND published_at IS NULL`,
      [message.id],
    );
  }

  async scheduleRetry(message: OutboxMessage, lastError: string): Promise<void> {
    await this.execute(
      `UPDATE outbox_messages
          SET attempts = ?, next_attempt_at = ?, locked_until = NULL, last_error = ?
        WHERE id = ? AND published_at IS NULL`,
      [message.attempts, message.nextAttemptAt ?? new Date(), lastError.slice(0, 1000), message.id],
    );
  }

  async lagSeconds(): Promise<number> {
    const [row] = await this.execute<Array<{ lag: number | string | null }>>(
      `SELECT extract(epoch FROM now() - min(occurred_at)) AS lag
         FROM outbox_messages WHERE published_at IS NULL`,
    );
    return row?.lag === null || row?.lag === undefined ? 0 : Math.max(0, Number(row.lag));
  }

  private async databaseNow(): Promise<Date> {
    const [row] = await this.execute<Array<{ now: string | Date }>>('SELECT now() AS now');
    return row ? toDate(row.now) : new Date();
  }

  private execute<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
    return withDatabaseErrors(async () => (await this.orm.em.fork().execute(sql, params)) as T);
  }
}
