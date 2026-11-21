import type { SqlEntityManager } from '@mikro-orm/postgresql';
import type {
  LedgerPage,
  LedgerSummary,
  LedgerPageQuery,
  LedgerRepository,
} from '../../../application/ports/repositories.port';
import { Money } from '../../../domain/money';
import type { WalletLedgerEntry } from '../../../domain/wallet-ledger-entry';
import { WalletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper';
import { WalletLedgerEntryRow } from '../rows/wallet-ledger-entry.row';

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(WalletLedgerEntryRow, WalletLedgerEntryMapper.fromDomain(entry));
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const [row] = await this.em.execute<Array<{ credits: string; debits: string; entries: string | number }>>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::numeric(20, 2)::text AS credits,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::numeric(20, 2)::text AS debits,
              count(*) AS entries
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    return {
      credits: Money.from({ amount: row?.credits ?? '0.00', currency }),
      debits: Money.from({ amount: row?.debits ?? '0.00', currency }),
      entries: Number(row?.entries ?? 0),
    };
  }

  async page(walletId: string, currency: string, query: LedgerPageQuery): Promise<LedgerPage> {
    // Busca um a mais para saber se existe próxima página sem um COUNT.
    const rows = await this.em.find(
      WalletLedgerEntryRow,
      query.before === undefined ? { walletId } : { walletId, seq: { $lt: query.before } },
      { orderBy: { seq: 'desc' }, limit: query.limit + 1 },
    );
    return {
      entries: rows.slice(0, query.limit).map((row) => ({
        entry: WalletLedgerEntryMapper.toDomain(row, currency),
        position: row.seq,
      })),
      hasMore: rows.length > query.limit,
    };
  }
}
