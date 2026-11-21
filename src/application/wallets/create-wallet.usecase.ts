import type { Money } from '../../domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { payloadHash } from '../payload-hash';
import type { Clock } from '../ports/clock.port';
import type { IdGenerator } from '../ports/id-generator.port';
import type { UnitOfWork } from '../ports/unit-of-work.port';

export interface CreateWalletCommand {
  readonly playerId: string;
  readonly initialBalance: Money;
}

/**
 * Cria a wallet e, com saldo inicial positivo, a transação interna OPENING e o
 * lançamento CREDIT correspondente, tudo na mesma transação SQL.
 */
export class CreateWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const at = this.clock.now();
    const walletId = this.ids.next();
    const opening = command.initialBalance.isPositive()
      ? { transactionId: this.ids.next(), ledgerEntryId: this.ids.next() }
      : undefined;

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      at,
      opening,
    });

    await this.unitOfWork.run(async ({ wallets, transactions, ledger }) => {
      await wallets.insert(wallet);
      if (opening && openingEntry) {
        await transactions.insert(
          WagerTransaction.opening({
            id: opening.transactionId,
            walletId,
            playerId: command.playerId,
            money: command.initialBalance,
            payloadHash: payloadHash({
              kind: WagerTransactionKind.Opening,
              walletId,
              playerId: command.playerId,
              money: { ...command.initialBalance.toJSON() },
            }),
            at,
          }),
        );
        await ledger.append(openingEntry);
      }
    });

    return wallet;
  }
}
