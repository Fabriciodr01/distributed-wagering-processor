import { LockMode, type SqlEntityManager } from '@mikro-orm/postgresql';
import { WalletAlreadyExistsError } from '../../../application/errors';
import type { WalletRepository } from '../../../application/ports/repositories.port';
import type { Wallet } from '../../../domain/wallet';
import { violatedConstraint } from '../database-errors';
import { WalletMapper } from '../mappers/wallet.mapper';
import { WalletRow } from '../rows/wallet.row';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRow, WalletMapper.fromDomain(wallet));
    } catch (error) {
      if (violatedConstraint(error) === 'wallets_player_currency_key') {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async findById(walletId: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletRow, { id: walletId }, { refresh: true });
    return row ? WalletMapper.toDomain(row) : null;
  }

  async findByIdForUpdate(walletId: string): Promise<Wallet | null> {
    const row = await this.em.findOne(
      WalletRow,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return row ? WalletMapper.toDomain(row) : null;
  }

  async update(wallet: Wallet): Promise<void> {
    const { balance, version, updatedAt } = WalletMapper.fromDomain(wallet);
    await this.em.nativeUpdate(WalletRow, { id: wallet.id }, { balance, version, updatedAt });
  }
}
