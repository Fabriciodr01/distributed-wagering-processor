import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletOperationError,
} from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';
import { Wallet } from '../../../src/domain/wallet';
import { LedgerDirection } from '../../../src/domain/wallet-ledger-entry';
import { brl, nextId, openWallet, PLAYER_ID, T0, usd } from '../../support/domain-fixtures';

const T1 = new Date('2026-11-21T12:00:01.000Z');
const movement = (money: Money) => ({
  ledgerEntryId: nextId('entry'),
  transactionId: nextId('tx'),
  money,
  at: T1,
});

describe('Wallet', () => {
  describe('open', () => {
    test('saldo inicial 0: version 1 e nenhum lançamento', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: 'w1',
        playerId: PLAYER_ID,
        initialBalance: brl('0.00'),
        at: T0,
      });
      expect(wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(wallet.version).toBe(1);
      expect(wallet.currency).toBe('BRL');
      expect(openingEntry).toBeUndefined();
    });

    test('saldo inicial > 0: version continua 1 e há um lançamento CREDIT de abertura', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: 'w1',
        playerId: PLAYER_ID,
        initialBalance: brl('1000.00'),
        at: T0,
        opening: { transactionId: 'tx-open', ledgerEntryId: 'entry-open' },
      });
      expect(wallet.version).toBe(1);
      expect(wallet.balance.equals(brl('1000.00'))).toBe(true);
      expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry?.transactionId).toBe('tx-open');
      expect(openingEntry?.balanceBefore.toJSON().amount).toBe('0.00');
      expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
    });

    test('saldo inicial > 0 sem ids de abertura é erro', () => {
      expect(() =>
        Wallet.open({ id: 'w1', playerId: PLAYER_ID, initialBalance: brl('1.00'), at: T0 }),
      ).toThrow(InvalidWalletOperationError);
    });

    test('saldo inicial negativo é erro', () => {
      expect(() =>
        Wallet.open({ id: 'w1', playerId: PLAYER_ID, initialBalance: brl('1.00').negate(), at: T0 }),
      ).toThrow(InvalidWalletOperationError);
    });
  });

  test('débito diminui saldo, gera lançamento DEBIT e incrementa version', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(movement(brl('80.00')));
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('crédito aumenta saldo, gera lançamento CREDIT e incrementa version', () => {
    const wallet = openWallet('10.00');
    const entry = wallet.credit(movement(brl('5.25')));
    expect(wallet.balance.toJSON().amount).toBe('15.25');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('move aplica a direção pedida', () => {
    const wallet = openWallet('10.00');
    wallet.move(LedgerDirection.Debit, movement(brl('4.00')));
    wallet.move(LedgerDirection.Credit, movement(brl('1.00')));
    expect(wallet.balance.toJSON().amount).toBe('7.00');
    expect(wallet.version).toBe(3);
  });

  test('saldo nunca fica negativo: débito acima do saldo falha sem alterar nada', () => {
    const wallet = openWallet('100.00');
    expect(wallet.canDebit(brl('100.01'))).toBe(false);
    expect(() => wallet.debit(movement(brl('100.01')))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('débito do saldo exato zera a wallet', () => {
    const wallet = openWallet('100.00');
    expect(wallet.canDebit(brl('100.00'))).toBe(true);
    wallet.debit(movement(brl('100.00')));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('cenário obrigatório em domínio: 100.00 e duas apostas de 80.00 → uma passa, outra não', () => {
    const wallet = openWallet('100.00');
    wallet.debit(movement(brl('80.00')));
    expect(wallet.canDebit(brl('80.00'))).toBe(false);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
  });

  test('moeda da operação diferente da wallet é erro, e nada muda', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(movement(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(movement(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('movimentação de valor zero não é permitida (não muda saldo, não pode mudar version)', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.credit(movement(brl('0.00')))).toThrow(InvalidWalletOperationError);
    expect(() => wallet.debit(movement(brl('0.00')))).toThrow(InvalidWalletOperationError);
    expect(wallet.version).toBe(1);
  });

  test('version só incrementa quando o saldo muda', () => {
    const wallet = openWallet('100.00');
    wallet.canDebit(brl('50.00'));
    expect(wallet.version).toBe(1);
    wallet.credit(movement(brl('1.00')));
    wallet.debit(movement(brl('1.00')));
    expect(wallet.version).toBe(3);
  });

  test('saldo da wallet bate com a soma dos lançamentos que ela gerou', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w1',
      playerId: PLAYER_ID,
      initialBalance: brl('50.00'),
      at: T0,
      opening: { transactionId: 'tx-open', ledgerEntryId: 'entry-open' },
    });
    const entries = [
      openingEntry!,
      wallet.debit(movement(brl('20.00'))),
      wallet.credit(movement(brl('7.50'))),
      wallet.debit(movement(brl('37.50'))),
    ];
    const reconstructed = entries.reduce((sum, e) => sum.add(e.signedAmount()), Money.zero('BRL'));
    expect(reconstructed.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('rehydrate reconstrói o estado sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: 'w1',
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toJSON().amount).toBe('42.00');
    expect(wallet.isOwnedBy(PLAYER_ID)).toBe(true);
    expect(wallet.isOwnedBy('outro')).toBe(false);
    expect(wallet.acceptsCurrency('BRL')).toBe(true);
    expect(wallet.acceptsCurrency('USD')).toBe(false);
  });
});
