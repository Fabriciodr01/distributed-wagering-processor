import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletOperationError,
} from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly at: Date;
  /** Obrigatório quando o saldo inicial é positivo: ids da transação OPENING e do lançamento. */
  readonly opening?: {
    readonly transactionId: string;
    readonly ledgerEntryId: string;
  };
}

export interface OpenedWallet {
  readonly wallet: Wallet;
  /** Lançamento CREDIT do saldo inicial; ausente quando o saldo inicial é zero. */
  readonly openingEntry?: WalletLedgerEntry;
}

/** Uma movimentação de saldo e os ids do lançamento que a registra. */
export interface BalanceMovement {
  readonly ledgerEntryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at: Date;
}

const INITIAL_VERSION = 1;

/**
 * Aggregate root. Saldo e ledger andam juntos: a única forma de mudar o saldo
 * é `debit`/`credit`, que devolvem o lançamento correspondente.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Nasce com `version = 1` mesmo com saldo inicial positivo: o crédito de abertura
   * faz parte da criação, não é uma mudança de saldo posterior.
   */
  static open(props: OpenWalletProps): OpenedWallet {
    if (!props.id || !props.playerId) {
      throw new InvalidWalletOperationError('Wallet precisa de id e playerId');
    }
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidWalletOperationError('Saldo inicial não pode ser negativo');
    }
    const currency = initialBalance.currency;
    const zero = Money.zero(currency);
    const at = new Date(props.at.getTime());
    const wallet = new Wallet(props.id, props.playerId, currency, zero, INITIAL_VERSION, at, at);

    if (initialBalance.isZero()) {
      return { wallet };
    }
    if (!props.opening) {
      throw new InvalidWalletOperationError(
        'Saldo inicial positivo exige a transação de abertura e seu lançamento',
      );
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.ledgerEntryId,
      walletId: wallet.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: zero,
      balanceAfter: initialBalance,
      createdAt: at,
    });
    wallet._balance = initialBalance;
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência: não revalida regras. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime()),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  isOwnedBy(playerId: string): boolean {
    return this.playerId === playerId;
  }

  acceptsCurrency(currency: string): boolean {
    return this.currency === currency;
  }

  /** Permite ao caso de uso escolher o código de rejeição antes de tentar o débito. */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertValidMovement(movement);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertValidMovement(movement);
    return this.apply(LedgerDirection.Credit, movement);
  }

  move(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    return direction === LedgerDirection.Debit ? this.debit(movement) : this.credit(movement);
  }

  private apply(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Debit
        ? balanceBefore.subtract(movement.money)
        : balanceBefore.add(movement.money);
    const entry = WalletLedgerEntry.create({
      id: movement.ledgerEntryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(movement.at.getTime());
    return entry;
  }

  private assertValidMovement(movement: BalanceMovement): void {
    this.assertSameCurrency(movement.money);
    if (!movement.money.isPositive()) {
      throw new InvalidWalletOperationError('Movimentação precisa ter valor maior que zero');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (!money.hasCurrency(this.currency)) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
