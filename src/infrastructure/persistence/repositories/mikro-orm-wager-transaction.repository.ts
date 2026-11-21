import type { SqlEntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionRepository } from '../../../application/ports/repositories.port';
import type { WagerTransaction } from '../../../domain/wager-transaction';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper';
import { WagerTransactionRow } from '../rows/wager-transaction.row';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRow, WagerTransactionMapper.fromDomain(transaction));
  }
}
