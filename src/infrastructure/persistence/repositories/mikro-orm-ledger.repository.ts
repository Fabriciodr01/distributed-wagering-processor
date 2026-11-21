import type { SqlEntityManager } from '@mikro-orm/postgresql';
import type {
  LedgerPage,
  LedgerPageQuery,
  LedgerRepository,
} from '../../../application/ports/repositories.port';
import type { WalletLedgerEntry } from '../../../domain/wallet-ledger-entry';
import { WalletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper';
import { WalletLedgerEntryRow } from '../rows/wallet-ledger-entry.row';

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(WalletLedgerEntryRow, WalletLedgerEntryMapper.fromDomain(entry));
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
