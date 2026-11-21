import { InvalidLedgerEntryError } from '../errors';
import type { MoneyProps } from '../money';
import type { Wallet } from '../wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet-ledger-entry';
import { type EventContext, IntegrationEvent, type IntegrationEventProps } from './integration-event';

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  /** Permite ao consumidor ordenar eventos da mesma wallet, já que a entrega não garante ordem. */
  readonly walletVersion: number;
}

/** Emitido somente quando o saldo muda, sempre junto de um lançamento. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id || !entry.balanceAfter.equals(wallet.balance)) {
      throw new InvalidLedgerEntryError('O lançamento não corresponde ao estado atual da wallet');
    }
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      causationId: entry.transactionId,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
