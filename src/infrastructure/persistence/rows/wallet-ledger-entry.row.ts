import { EntitySchema } from '@mikro-orm/core';

export class WalletLedgerEntryRow {
  id!: string;
  /** bigserial: ordem total de inserção, também usada como cursor de paginação. */
  seq!: bigint;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRow>({
  class: WalletLedgerEntryRow,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    // Gerado pelo banco; nunca enviado no INSERT.
    seq: { type: 'bigint', persist: false },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'text' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    balanceBefore: { type: 'decimal', precision: 20, scale: 2 },
    balanceAfter: { type: 'decimal', precision: 20, scale: 2 },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
  },
});
