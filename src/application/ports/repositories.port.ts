import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface WalletRepository {
  /** Lança `WalletAlreadyExistsError` se o player já tem wallet nessa moeda. */
  insert(wallet: Wallet): Promise<void>;
  findById(walletId: string): Promise<Wallet | null>;
}

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
}

export interface LedgerPageQuery {
  readonly limit: number;
  /** Devolve só lançamentos anteriores a esta posição (keyset, mais recentes primeiro). */
  readonly before?: bigint;
}

export interface LedgerPage {
  readonly entries: readonly PositionedLedgerEntry[];
  readonly hasMore: boolean;
}

export interface PositionedLedgerEntry {
  readonly entry: WalletLedgerEntry;
  /** Ordem total de inserção no ledger; base do cursor de paginação. */
  readonly position: bigint;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  page(walletId: string, currency: string, query: LedgerPageQuery): Promise<LedgerPage>;
}
