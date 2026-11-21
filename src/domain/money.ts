import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from './errors';

/** Representação de contrato: string decimal com exatamente 2 casas. */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

// Escala fixa em 2: guardar centavos inteiros em bigint é exato e dispensa biblioteca decimal.
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const CENTS_PER_UNIT = 100n;
// Limite de numeric(20,2): 18 dígitos inteiros e 2 decimais.
const MAX_ABS_CENTS = 10n ** 20n - 1n;

export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Contrato de entrada: rejeita negativos, mais de 2 casas, notação científica,
   * NaN, Infinity, vírgula, espaços e string vazia. Nunca arredonda.
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Valor monetário ausente');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        'amount deve ser uma string decimal não negativa com exatamente 2 casas (ex.: "25.00")',
      );
    }
    Money.assertCurrencyCode(currency);
    const [units = '0', fraction = '00'] = amount.split('.');
    return new Money(BigInt(units) * CENTS_PER_UNIT + BigInt(fraction), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrencyCode(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofCents(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofCents(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return Money.ofCents(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }

  hasCurrency(currency: string): boolean {
    return this.currency === currency;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    const negative = this.cents < 0n;
    const abs = negative ? -this.cents : this.cents;
    const units = abs / CENTS_PER_UNIT;
    const fraction = (abs % CENTS_PER_UNIT).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${units}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static ofCents(cents: bigint, currency: string): Money {
    const abs = cents < 0n ? -cents : cents;
    if (abs > MAX_ABS_CENTS) {
      throw new MoneyOverflowError();
    }
    return new Money(cents, currency);
  }

  private static assertCurrencyCode(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency deve ser um código de 3 letras maiúsculas (ISO-4217)');
    }
  }
}
