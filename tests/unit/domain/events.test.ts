import { describe, expect, test } from 'bun:test';
import { InvalidLedgerEntryError, InvalidWagerTransactionError } from '../../../src/domain/errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../../src/domain/events';
import { FailureCode } from '../../../src/domain/failure-code';
import { WagerTransactionKind as Kind } from '../../../src/domain/wager-transaction';
import { brl, newTransaction, nextId, openWallet, T0 } from '../../support/domain-fixtures';

const ctx = { eventId: 'evt-1', correlationId: 'corr-1', occurredAt: T0 };

/** Nenhum valor do payload pode ser instância de classe (ex.: Money): só JSON puro. */
function assertPlainJson(value: unknown): void {
  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    expect(proto === Object.prototype || proto === Array.prototype).toBe(true);
    Object.values(value).forEach(assertPlainJson);
  }
}

describe('eventos de integração', () => {
  test('WagerTransactionProcessed: envelope versionado com MoneyProps', () => {
    const tx = newTransaction({ kind: Kind.Bet, money: brl('25.00') });
    tx.markProcessed({ resultingBalance: brl('975.00'), at: T0 });
    const evt = WagerTransactionProcessed.from(tx, ctx);
    const json = evt.toJSON();

    expect(evt.eventType).toBe('WagerTransactionProcessed');
    expect(evt.version).toBe(1);
    expect(json).toMatchObject({
      eventId: 'evt-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: tx.walletId,
      correlationId: 'corr-1',
      causationId: tx.id,
      occurredAt: '2026-11-21T12:00:00.000Z',
      version: 1,
    });
    expect(json.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(json.data.balance).toEqual({ amount: '975.00', currency: 'BRL' });
    expect(String(json.data.status)).toBe('PROCESSED');
    expect('referenceTransactionId' in json.data).toBe(false);
    assertPlainJson(json);
  });

  test('LOSS processado também gera WagerTransactionProcessed', () => {
    const tx = newTransaction({ kind: Kind.Loss, money: brl('0.00') });
    tx.markProcessed({ resultingBalance: brl('100.00'), at: T0 });
    expect(WagerTransactionProcessed.from(tx, ctx).data.kind).toBe(Kind.Loss);
  });

  test('WagerTransactionRejected carrega o failureCode', () => {
    const tx = newTransaction();
    tx.reject({ code: FailureCode.InsufficientFunds, resultingBalance: brl('20.00'), at: T0 });
    const json = WagerTransactionRejected.from(tx, ctx).toJSON();
    expect(json.eventType).toBe('WagerTransactionRejected');
    expect(json.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(json.data.balance).toEqual({ amount: '20.00', currency: 'BRL' });
    assertPlainJson(json);
  });

  test('WagerTransactionPendingReference carrega a referência aguardada', () => {
    const tx = newTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference({ resultingBalance: brl('10.00') });
    const json = WagerTransactionPendingReference.from(tx, ctx).toJSON();
    expect(json.eventType).toBe('WagerTransactionPendingReference');
    expect(json.data.referenceExternalTransactionId).toBe('bet-1');
    assertPlainJson(json);
  });

  test.each([
    ['Processed', () => WagerTransactionProcessed.from(newTransaction(), ctx)],
    ['Rejected', () => WagerTransactionRejected.from(newTransaction(), ctx)],
    ['PendingReference', () => WagerTransactionPendingReference.from(newTransaction(), ctx)],
  ])('%s exige a transação no status correspondente', (_, build) => {
    expect(build).toThrow(InvalidWagerTransactionError);
  });

  test('WalletBalanceChanged traz direção, saldos e walletVersion', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit({ ledgerEntryId: nextId('e'), transactionId: 'tx-9', money: brl('80.00'), at: T0 });
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.causationId).toBe('tx-9');
    // Compara o JSON serializado: é ele o contrato com o consumidor.
    expect(JSON.parse(JSON.stringify(json.data))).toEqual({
      walletId: wallet.id,
      transactionId: 'tx-9',
      direction: 'DEBIT',
      money: { amount: '80.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '20.00', currency: 'BRL' },
      walletVersion: 2,
    });
    assertPlainJson(json);
  });

  test('WalletBalanceChanged recusa lançamento que não é o estado atual da wallet', () => {
    const wallet = openWallet('100.00');
    const stale = wallet.debit({ ledgerEntryId: 'e1', transactionId: 't1', money: brl('10.00'), at: T0 });
    wallet.debit({ ledgerEntryId: 'e2', transactionId: 't2', money: brl('10.00'), at: T0 });
    expect(() => WalletBalanceChanged.from(wallet, stale, ctx)).toThrow(InvalidLedgerEntryError);
  });

  test('data do evento é imutável', () => {
    const tx = newTransaction();
    tx.markProcessed({ resultingBalance: brl('1.00'), at: T0 });
    const evt = WagerTransactionProcessed.from(tx, ctx);
    expect(Object.isFrozen(evt.data)).toBe(true);
    expect(Object.isFrozen(evt.data.money)).toBe(true);
  });
});
