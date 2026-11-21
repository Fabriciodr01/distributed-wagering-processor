import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WalletNotFoundError } from '../errors';
import { LedgerCursor } from '../ledger-cursor';
import type { UnitOfWork } from '../ports/unit-of-work.port';

export interface ListWalletLedgerQuery {
  readonly walletId: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface WalletLedgerPage {
  readonly items: readonly WalletLedgerEntry[];
  /** null quando não há mais lançamentos. */
  readonly nextCursor: string | null;
}

/** Ledger da wallet, mais recente primeiro, paginado por keyset (estável sob inserções). */
export class ListWalletLedgerUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(query: ListWalletLedgerQuery): Promise<WalletLedgerPage> {
    const before = query.cursor === undefined ? undefined : LedgerCursor.decode(query.cursor);

    const page = await this.unitOfWork.run(
      async ({ wallets, ledger }) => {
        const wallet = await wallets.findById(query.walletId);
        if (!wallet) throw new WalletNotFoundError(query.walletId);
        return ledger.page(wallet.id, wallet.currency, { limit: query.limit, before });
      },
      { isolation: 'repeatable read', readOnly: true },
    );

    const last = page.entries.at(-1);
    return {
      items: page.entries.map(({ entry }) => entry),
      nextCursor: page.hasMore && last ? LedgerCursor.encode(last.position) : null,
    };
  }
}
