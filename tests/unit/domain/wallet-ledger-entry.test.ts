import { describe, expect, test } from 'bun:test';
import { InvalidLedgerEntryError } from '../../../src/domain/errors';
import {
  type CreateLedgerEntryProps,
  LedgerDirection,
  oppositeDirection,
  WalletLedgerEntry,
} from '../../../src/domain/wallet-ledger-entry';
import { brl, T0, usd } from '../../support/domain-fixtures';

const props = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: 'entry-1',
  walletId: 'w1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('75.00'),
  createdAt: T0,
  ...overrides,
});

describe('WalletLedgerEntry', () => {
  test('create aceita aritmética consistente de débito e crédito', () => {
    expect(WalletLedgerEntry.create(props()).isBalanced()).toBe(true);
    const credit = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceAfter: brl('125.00') }),
    );
    expect(credit.isBalanced()).toBe(true);
    expect(credit.signedAmount().toJSON().amount).toBe('25.00');
    expect(WalletLedgerEntry.create(props()).signedAmount().toJSON().amount).toBe('-25.00');
  });

  test.each([
    ['débito com saldo final errado', props({ balanceAfter: brl('76.00') })],
    ['crédito com saldo final de débito', props({ direction: LedgerDirection.Credit })],
    ['valor zero', props({ money: brl('0.00'), balanceAfter: brl('100.00') })],
    ['saldo final negativo', props({ balanceBefore: brl('10.00'), balanceAfter: brl('15.00').negate() })],
    ['moedas diferentes', props({ money: usd('25.00') })],
    ['sem transação', props({ transactionId: '' })],
    ['direção inválida', props({ direction: 'SIDEWAYS' as LedgerDirection })],
  ])('create rejeita %s', (_, input) => {
    expect(() => WalletLedgerEntry.create(input)).toThrow(InvalidLedgerEntryError);
  });

  test('imutabilidade estrutural: objeto congelado, sem setters', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = LedgerDirection.Credit;
    }).toThrow();
  });

  test('rehydrate não revalida (o banco já garante a aritmética)', () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('1.00') }));
    expect(entry.isBalanced()).toBe(false);
  });

  test('oppositeDirection', () => {
    expect(oppositeDirection(LedgerDirection.Debit)).toBe(LedgerDirection.Credit);
    expect(oppositeDirection(LedgerDirection.Credit)).toBe(LedgerDirection.Debit);
  });
});
