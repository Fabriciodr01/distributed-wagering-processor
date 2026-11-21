import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';
import { brl, usd } from '../../support/domain-fixtures';

describe('Money', () => {
  describe('from: contrato de entrada', () => {
    test.each(['0.00', '0.01', '25.00', '1000.50', '999999999999999999.99'])('aceita %s', (amount) => {
      expect(Money.from({ amount, currency: 'BRL' }).toJSON()).toEqual({ amount, currency: 'BRL' });
    });

    test.each([
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['notação científica', '1e3'],
      ['notação científica com casas', '2.5e1'],
      ['string vazia', ''],
      ['sem casas decimais', '25'],
      ['uma casa decimal', '25.5'],
      ['três casas decimais', '25.001'],
      ['vírgula decimal', '25,00'],
      ['negativo', '-1.00'],
      ['sinal positivo', '+1.00'],
      ['espaço', ' 25.00'],
      ['zero à esquerda', '025.00'],
      ['hexadecimal', '0x10'],
      ['19 dígitos inteiros', '1000000000000000000.00'],
    ])('rejeita %s (%s)', (_, amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    test('rejeita amount que não é string', () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(InvalidMoneyError);
    });

    test.each(['brl', 'BR', 'BRLL', '', 'R$'])('rejeita moeda %p', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });

    test('nunca arredonda: mais de 2 casas é erro, não truncamento', () => {
      expect(() => brl('0.005')).toThrow(InvalidMoneyError);
    });
  });

  describe('aritmética', () => {
    test('soma e subtração exatas, sem erro de ponto flutuante', () => {
      expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
      expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
      expect(brl('999999999999999999.98').add(brl('0.01')).toJSON().amount).toBe('999999999999999999.99');
    });

    test('pode produzir negativo internamente e serializa com sinal', () => {
      const result = brl('10.00').subtract(brl('10.01'));
      expect(result.isNegative()).toBe(true);
      expect(result.toJSON().amount).toBe('-0.01');
      expect(brl('5.50').negate().toString()).toBe('-5.50 BRL');
      expect(brl('5.50').negate().negate().equals(brl('5.50'))).toBe(true);
    });

    test('overflow além de numeric(20,2) é erro', () => {
      expect(() => brl('999999999999999999.99').add(brl('0.01'))).toThrow(MoneyOverflowError);
    });

    test('predicados', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.00').isPositive()).toBe(false);
      expect(brl('0.00').isNegative()).toBe(false);
      expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
      expect(brl('1.01').isLessThan(brl('1.01'))).toBe(false);
      expect(brl('1.00').equals(brl('1.00'))).toBe(true);
      expect(brl('1.00').equals(brl('1.01'))).toBe(false);
    });
  });

  describe('conflito de moeda', () => {
    test.each([
      ['add', (a: Money, b: Money) => a.add(b)],
      ['subtract', (a: Money, b: Money) => a.subtract(b)],
      ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
      ['equals', (a: Money, b: Money) => a.equals(b)],
    ])('%s entre BRL e USD lança erro de domínio', (_, op) => {
      expect(() => op(brl('1.00'), usd('1.00'))).toThrow(CurrencyMismatchError);
    });
  });

  test('imutável: operações devolvem nova instância e o objeto é congelado', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(b).not.toBe(a);
    expect(a.toJSON().amount).toBe('10.00');
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => {
      (a as unknown as { currency: string }).currency = 'USD';
    }).toThrow();
  });

  test('toJSON produz MoneyProps serializável', () => {
    expect(JSON.stringify({ money: brl('25.00') })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    expect(Money.zero('USD').toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
  });
});
