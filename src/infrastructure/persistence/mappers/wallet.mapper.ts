import { Money } from '../../../domain/money';
import { Wallet } from '../../../domain/wallet';
import { WalletRow } from '../rows/wallet.row';

export const WalletMapper = {
  toDomain(row: WalletRow): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency: row.currency,
      balance: Money.from({ amount: row.balance, currency: row.currency }),
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  },

  fromDomain(wallet: Wallet): WalletRow {
    return Object.assign(new WalletRow(), {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
  },
};
