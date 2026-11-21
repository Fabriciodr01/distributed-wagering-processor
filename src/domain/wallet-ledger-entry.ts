import { InvalidLedgerEntryError } from './errors';
import { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export function oppositeDirection(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/** Lançamento imutável: sem campos mutáveis e sem métodos de transição. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Valida moeda, sinais e a aritmética `balanceBefore ± money === balanceAfter`. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    for (const field of ['id', 'walletId', 'transactionId'] as const) {
      if (!props[field]) {
        throw new InvalidLedgerEntryError(`Lançamento sem ${field}`);
      }
    }
    if (props.direction !== LedgerDirection.Debit && props.direction !== LedgerDirection.Credit) {
      throw new InvalidLedgerEntryError('Direção de lançamento inválida');
    }
    const currency = props.money.currency;
    if (!props.balanceBefore.hasCurrency(currency) || !props.balanceAfter.hasCurrency(currency)) {
      throw new InvalidLedgerEntryError('Lançamento com moedas diferentes');
    }
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('Valor do lançamento precisa ser maior que zero');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Lançamento produziria saldo negativo');
    }
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError('Aritmética do lançamento inconsistente');
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt.getTime()),
    );
  }

  /** `balanceBefore ± money === balanceAfter`, conforme a direção. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Efeito com sinal no saldo: positivo para crédito, negativo para débito. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
