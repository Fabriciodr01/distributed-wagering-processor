import { describe, expect, test } from 'bun:test';
import {
  type ProcessWagerTransactionCommand,
  wagerPayloadHash,
} from '../../../src/application/wagering/wager-transaction-command';
import { Money } from '../../../src/domain/money';
import { WagerTransactionKind } from '../../../src/domain/wager-transaction';

const command = (overrides: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand => ({
  idempotencyKey: 'provider-a:transaction-123',
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
  correlationId: 'corr-1',
  ...overrides,
});

describe('wagerPayloadHash', () => {
  test('chave de idempotência e correlationId não entram no hash', () => {
    expect(wagerPayloadHash(command({ idempotencyKey: 'outra', correlationId: 'outro' }))).toBe(
      wagerPayloadHash(command()),
    );
  });

  test.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'x' }],
    ['playerId', { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2' }],
    ['walletId', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['roundId', { roundId: 'r' }],
    ['gameId', { gameId: 'g' }],
    ['kind', { kind: WagerTransactionKind.Win }],
    ['amount', { money: Money.from({ amount: '25.01', currency: 'BRL' }) }],
    ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ['referência', { referenceExternalTransactionId: 'bet-1' }],
  ])('%s muda o hash', (_, overrides) => {
    expect(wagerPayloadHash(command(overrides))).not.toBe(wagerPayloadHash(command()));
  });
});
