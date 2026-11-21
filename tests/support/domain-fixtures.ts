import { Money } from '../../src/domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

export const T0 = new Date('2026-11-21T12:00:00.000Z');

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

let sequence = 0;
export const nextId = (prefix = 'id') => `${prefix}-${++sequence}`;

export const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
export const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';

export function openWallet(initial = '100.00', currency = 'BRL'): Wallet {
  return Wallet.open({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance: Money.from({ amount: initial, currency }),
    at: T0,
    opening: { transactionId: nextId('opening'), ledgerEntryId: nextId('entry') },
  }).wallet;
}

export function txProps(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  const externalTransactionId = overrides.externalTransactionId ?? nextId('ext');
  return {
    id: nextId('tx'),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'a'.repeat(64),
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    createdAt: T0,
    ...overrides,
  };
}

export function newTransaction(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create(txProps(overrides));
}

/** Transação já aplicada, para servir de referência. */
export function processed(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const tx = newTransaction(overrides);
  tx.markProcessed({
    resultingBalance: brl('100.00'),
    at: T0,
    ...(tx.requiresReference() ? { referenceTransactionId: nextId('ref') } : {}),
  });
  return tx;
}
