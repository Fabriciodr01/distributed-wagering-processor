import { Money } from '../../../domain/money';
import { type LedgerDirection, WalletLedgerEntry } from '../../../domain/wallet-ledger-entry';
import { WalletLedgerEntryRow } from '../rows/wallet-ledger-entry.row';

export const WalletLedgerEntryMapper = {
  /** O ledger não guarda moeda: ela é sempre a da wallet dona do lançamento. */
  toDomain(row: WalletLedgerEntryRow, currency: string): WalletLedgerEntry {
    const money = (amount: string) => Money.from({ amount, currency });
    return WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.walletId,
      transactionId: row.transactionId,
      direction: row.direction as LedgerDirection,
      money: money(row.amount),
      balanceBefore: money(row.balanceBefore),
      balanceAfter: money(row.balanceAfter),
      createdAt: row.createdAt,
    });
  },

  fromDomain(entry: WalletLedgerEntry): WalletLedgerEntryRow {
    return Object.assign(new WalletLedgerEntryRow(), {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    });
  },
};
