import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../../src/domain/errors';
import { FailureCode } from '../../../src/domain/failure-code';
import {
  canTransition,
  OPENING_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wager-transaction';
import { LedgerDirection } from '../../../src/domain/wallet-ledger-entry';
import { brl, newTransaction, nextId, processed, T0, txProps, usd } from '../../support/domain-fixtures';

const balance = brl('75.00');

function reversal(kind: Kind.Refund | Kind.Rollback, referenceExternalTransactionId: string, amount = '25.00') {
  return newTransaction({ kind, referenceExternalTransactionId, money: brl(amount) });
}

describe('WagerTransaction', () => {
  describe('create', () => {
    test('nasce em PENDING, sem resultado', () => {
      const tx = newTransaction();
      expect(tx.status).toBe(Status.Pending);
      expect(tx.isTerminal()).toBe(false);
      expect(tx.failureCode).toBeUndefined();
      expect(tx.processedAt).toBeUndefined();
      expect(tx.resultingBalance).toBeUndefined();
    });

    test('OPENING não pode ser submetido', () => {
      expect(() => newTransaction({ kind: Kind.Opening })).toThrow(InvalidWagerTransactionError);
    });

    test('kind desconhecido é rejeitado', () => {
      expect(() => newTransaction({ kind: 'JACKPOT' as Kind })).toThrow(InvalidWagerTransactionError);
    });

    test.each([Kind.Refund, Kind.Rollback])('%s exige referenceExternalTransactionId', (kind) => {
      expect(() => newTransaction({ kind })).toThrow(InvalidWagerTransactionError);
      expect(newTransaction({ kind, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
    });

    test('BET não aceita referência; WIN e LOSS aceitam opcionalmente', () => {
      expect(() => newTransaction({ kind: Kind.Bet, referenceExternalTransactionId: 'x' })).toThrow(
        InvalidWagerTransactionError,
      );
      expect(newTransaction({ kind: Kind.Win }).referenceExternalTransactionId).toBeUndefined();
      const win = newTransaction({ kind: Kind.Win, referenceExternalTransactionId: 'bet-1' });
      expect(win.referenceExternalTransactionId).toBe('bet-1');
      expect(newTransaction({ kind: Kind.Loss, referenceExternalTransactionId: 'bet-1' }).kind).toBe(Kind.Loss);
    });

    test('não pode referenciar a si mesma', () => {
      expect(() =>
        newTransaction({ kind: Kind.Refund, externalTransactionId: 'same', referenceExternalTransactionId: 'same' }),
      ).toThrow(InvalidWagerTransactionError);
    });

    test.each([
      [Kind.Bet, undefined],
      [Kind.Win, undefined],
      [Kind.Refund, 'ref'],
      [Kind.Rollback, 'ref'],
    ])('%s exige valor maior que zero', (kind, referenceExternalTransactionId) => {
      expect(() => newTransaction({ kind, money: brl('0.00'), referenceExternalTransactionId })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    test('LOSS aceita 0.00 (é informativo)', () => {
      expect(newTransaction({ kind: Kind.Loss, money: brl('0.00') }).affectsBalance()).toBe(false);
    });

    test.each([
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'payloadHash',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ] as const)('%s é obrigatório', (field) => {
      expect(() => WagerTransaction.create({ ...txProps(), [field]: '' })).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('opening', () => {
    test('cria transação interna já PROCESSED, com chaves determinísticas por wallet', () => {
      const tx = WagerTransaction.opening({
        id: 'tx-open',
        walletId: 'w1',
        playerId: 'p1',
        money: brl('1000.00'),
        payloadHash: 'b'.repeat(64),
        at: T0,
      });
      expect(tx.kind).toBe(Kind.Opening);
      expect(tx.status).toBe(Status.Processed);
      expect(tx.providerId).toBe(OPENING_PROVIDER_ID);
      expect(tx.externalTransactionId).toBe('opening:w1');
      expect(tx.idempotencyKey).toBe('opening:w1');
      expect(tx.resultingBalance?.equals(brl('1000.00'))).toBe(true);
      expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });

    test('exige valor positivo', () => {
      expect(() =>
        WagerTransaction.opening({
          id: 'x',
          walletId: 'w',
          playerId: 'p',
          money: brl('0.00'),
          payloadHash: 'h',
          at: T0,
        }),
      ).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('máquina de estados', () => {
    test('tabela de transições', () => {
      const allowed: Record<Status, Status[]> = {
        [Status.Pending]: [Status.PendingReference, Status.Processed, Status.Rejected, Status.Failed],
        [Status.PendingReference]: [Status.Processed, Status.Rejected, Status.Failed],
        [Status.Processed]: [],
        [Status.Rejected]: [],
        [Status.Failed]: [],
      };
      for (const from of Object.values(Status)) {
        for (const to of Object.values(Status)) {
          expect(canTransition(from, to), `${from} → ${to}`).toBe(allowed[from].includes(to));
        }
      }
    });

    test('PENDING → PROCESSED grava saldo resultante e data', () => {
      const tx = newTransaction();
      tx.markProcessed({ resultingBalance: balance, at: T0 });
      expect(tx.status).toBe(Status.Processed);
      expect(tx.isTerminal()).toBe(true);
      expect(tx.resultingBalance?.equals(balance)).toBe(true);
      expect(tx.processedAt).toEqual(T0);
    });

    test('PENDING → REJECTED com código de negócio', () => {
      const tx = newTransaction();
      tx.reject({ code: FailureCode.InsufficientFunds, resultingBalance: balance, at: T0 });
      expect(tx.status).toBe(Status.Rejected);
      expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(tx.isTerminal()).toBe(true);
    });

    test('reject não aceita código de falha de processamento, e fail não aceita código de negócio', () => {
      expect(() =>
        newTransaction().reject({
          code: FailureCode.ProcessingRetriesExhausted,
          resultingBalance: balance,
          at: T0,
        }),
      ).toThrow(InvalidWagerTransactionError);
      expect(() => newTransaction().fail({ code: FailureCode.InsufficientFunds, at: T0 })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    test('PENDING → FAILED com código de processamento', () => {
      const tx = newTransaction();
      tx.fail({ code: FailureCode.ProcessingRetriesExhausted, at: T0 });
      expect(tx.status).toBe(Status.Failed);
      expect(tx.failureCode).toBe(FailureCode.ProcessingRetriesExhausted);
      expect(tx.isTerminal()).toBe(true);
    });

    test('PENDING → PENDING_REFERENCE → PROCESSED', () => {
      const tx = reversal(Kind.Refund, 'bet-1');
      tx.markPendingReference({ resultingBalance: balance });
      expect(tx.status).toBe(Status.PendingReference);
      expect(tx.isTerminal()).toBe(false);
      tx.markProcessed({ referenceTransactionId: 'bet-id', resultingBalance: brl('100.00'), at: T0 });
      expect(tx.status).toBe(Status.Processed);
      expect(tx.referenceTransactionId).toBe('bet-id');
    });

    test('PENDING_REFERENCE → REJECTED quando a referência expira', () => {
      const tx = reversal(Kind.Rollback, 'bet-1');
      tx.markPendingReference({ resultingBalance: balance });
      tx.reject({ code: FailureCode.ReferenceNotFoundExpired, resultingBalance: balance, at: T0 });
      expect(tx.failureCode).toBe(FailureCode.ReferenceNotFoundExpired);
    });

    test('PENDING_REFERENCE não volta para PENDING_REFERENCE', () => {
      const tx = reversal(Kind.Refund, 'bet-1');
      tx.markPendingReference({ resultingBalance: balance });
      expect(() => tx.markPendingReference({ resultingBalance: balance })).toThrow(InvalidTransactionStateError);
    });

    test('só transação com referência pode ficar PENDING_REFERENCE', () => {
      expect(() => newTransaction().markPendingReference({ resultingBalance: balance })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    test('reversão só é processada com a referência resolvida', () => {
      expect(() => reversal(Kind.Refund, 'bet-1').markProcessed({ resultingBalance: balance, at: T0 })).toThrow(
        InvalidWagerTransactionError,
      );
      expect(() =>
        newTransaction().markProcessed({ referenceTransactionId: 'x', resultingBalance: balance, at: T0 }),
      ).toThrow(InvalidWagerTransactionError);
    });

    const terminals: Array<[string, (tx: WagerTransaction) => void]> = [
      ['PROCESSED', (tx) => tx.markProcessed({ resultingBalance: balance, at: T0 })],
      [
        'REJECTED',
        (tx) => tx.reject({ code: FailureCode.InsufficientFunds, resultingBalance: balance, at: T0 }),
      ],
      ['FAILED', (tx) => tx.fail({ code: FailureCode.PermanentProcessingError, at: T0 })],
    ];
    const attempts: Array<[string, (tx: WagerTransaction) => void]> = [
      ['markProcessed', (tx) => tx.markProcessed({ resultingBalance: balance, at: T0 })],
      ['markPendingReference', (tx) => tx.markPendingReference({ resultingBalance: balance })],
      [
        'reject',
        (tx) => tx.reject({ code: FailureCode.AmountMismatch, resultingBalance: balance, at: T0 }),
      ],
      ['fail', (tx) => tx.fail({ code: FailureCode.PermanentProcessingError, at: T0 })],
    ];
    for (const [terminal, reach] of terminals) {
      for (const [name, attempt] of attempts) {
        test(`${terminal} é terminal: ${name} lança InvalidTransactionStateError e não muda nada`, () => {
          const tx = newTransaction({ kind: Kind.Win, referenceExternalTransactionId: 'bet-1' });
          reach(tx);
          const before = { status: tx.status, code: tx.failureCode };
          expect(() => attempt(tx)).toThrow(InvalidTransactionStateError);
          expect({ status: tx.status, code: tx.failureCode }).toEqual(before);
        });
      }
    }
  });

  describe('consultas', () => {
    test.each([
      [Kind.Bet, true, false],
      [Kind.Win, true, false],
      [Kind.Loss, false, false],
      [Kind.Refund, true, true],
      [Kind.Rollback, true, true],
    ])('%s: affectsBalance=%p, requiresReference=%p', (kind, affects, requires) => {
      const tx = newTransaction({ kind, referenceExternalTransactionId: requires ? 'ref' : undefined });
      expect(tx.affectsBalance()).toBe(affects);
      expect(tx.requiresReference()).toBe(requires);
    });

    test('matchesPayload compara o hash', () => {
      const tx = newTransaction({ payloadHash: 'abc' });
      expect(tx.matchesPayload('abc')).toBe(true);
      expect(tx.matchesPayload('abd')).toBe(false);
    });

    test('rehydrate preserva estado terminal sem revalidar', () => {
      const tx = WagerTransaction.rehydrate({
        ...txProps({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' }),
        status: Status.Rejected,
        failureCode: FailureCode.ReferenceAlreadyReversed,
        resultingBalance: balance,
        processedAt: T0,
      });
      expect(tx.status).toBe(Status.Rejected);
      expect(tx.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    });
  });

  describe('ledgerDirectionFor', () => {
    const bet = () => processed({ kind: Kind.Bet, externalTransactionId: nextId('bet') });
    const win = () => processed({ kind: Kind.Win, externalTransactionId: nextId('win') });
    const refundOf = (ref: WagerTransaction) =>
      processed({ kind: Kind.Refund, referenceExternalTransactionId: ref.externalTransactionId });

    test('BET → DEBIT, WIN → CREDIT', () => {
      expect(newTransaction({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(newTransaction({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });

    test('REFUND de BET → CREDIT', () => {
      const ref = bet();
      const refund = reversal(Kind.Refund, ref.externalTransactionId);
      expect(refund.ledgerDirectionFor(ref)).toBe(LedgerDirection.Credit);
    });

    test('ROLLBACK de BET → CREDIT, de WIN → DEBIT, de REFUND → DEBIT', () => {
      const b = bet();
      const w = win();
      const r = refundOf(b);
      expect(reversal(Kind.Rollback, b.externalTransactionId).ledgerDirectionFor(b)).toBe(LedgerDirection.Credit);
      expect(reversal(Kind.Rollback, w.externalTransactionId).ledgerDirectionFor(w)).toBe(LedgerDirection.Debit);
      expect(reversal(Kind.Rollback, r.externalTransactionId).ledgerDirectionFor(r)).toBe(LedgerDirection.Debit);
    });

    test('ROLLBACK sem referência não tem direção', () => {
      expect(() => reversal(Kind.Rollback, 'x').ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    });

    test('LOSS não tem direção', () => {
      expect(() => newTransaction({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    });

    test('referência de tipo não permitido é erro', () => {
      const loss = processed({ kind: Kind.Loss });
      const w = win();
      expect(() => reversal(Kind.Rollback, loss.externalTransactionId).ledgerDirectionFor(loss)).toThrow(
        InvalidWagerTransactionError,
      );
      expect(() => reversal(Kind.Refund, w.externalTransactionId).ledgerDirectionFor(w)).toThrow(
        InvalidWagerTransactionError,
      );
    });
  });

  describe('assessReference', () => {
    test('referência PROCESSED compatível é válida', () => {
      const ref = processed({ externalTransactionId: 'bet-1' });
      expect(reversal(Kind.Refund, 'bet-1').assessReference(ref)).toEqual({ outcome: 'valid' });
      expect(reversal(Kind.Rollback, 'bet-1').assessReference(ref)).toEqual({ outcome: 'valid' });
      const win = newTransaction({ kind: Kind.Win, money: brl('60.00'), referenceExternalTransactionId: 'bet-1' });
      expect(win.assessReference(ref)).toEqual({ outcome: 'valid' });
    });

    test.each([Status.Pending, Status.PendingReference])('referência ainda %s mantém a espera', (status) => {
      const ref = WagerTransaction.rehydrate({ ...txProps({ externalTransactionId: 'bet-1' }), status });
      expect(reversal(Kind.Rollback, 'bet-1').assessReference(ref)).toEqual({ outcome: 'pending' });
    });

    test.each([
      [Status.Rejected, FailureCode.InsufficientFunds],
      [Status.Failed, FailureCode.PermanentProcessingError],
    ])('referência %s → REFERENCE_NOT_PROCESSED', (status, failureCode) => {
      const ref = WagerTransaction.rehydrate({
        ...txProps({ externalTransactionId: 'bet-1' }),
        status,
        failureCode,
      });
      expect(reversal(Kind.Refund, 'bet-1').assessReference(ref)).toEqual({
        outcome: 'rejected',
        code: FailureCode.ReferenceNotProcessed,
      });
    });

    test.each([
      ['player', { playerId: 'outro-player' }],
      ['wallet', { walletId: 'outra-wallet' }],
      ['rodada', { roundId: 'outra-rodada' }],
      ['moeda', { money: usd('25.00') }],
    ])('%s diferente → REFERENCE_MISMATCH', (_, overrides) => {
      const ref = processed({ externalTransactionId: 'bet-1', ...overrides });
      expect(reversal(Kind.Refund, 'bet-1').assessReference(ref)).toEqual({
        outcome: 'rejected',
        code: FailureCode.ReferenceMismatch,
      });
    });

    test.each([
      [Kind.Refund, Kind.Win],
      [Kind.Refund, Kind.Refund],
      [Kind.Refund, Kind.Loss],
      [Kind.Rollback, Kind.Loss],
      [Kind.Rollback, Kind.Rollback],
      [Kind.Win, Kind.Win],
    ])('%s de %s → REFERENCE_KIND_NOT_ALLOWED', (kind, refKind) => {
      const refIsReversal = refKind === Kind.Refund || refKind === Kind.Rollback;
      const ref = processed({
        externalTransactionId: 'ref-1',
        kind: refKind,
        referenceExternalTransactionId: refIsReversal ? 'base' : undefined,
      });
      const tx = newTransaction({ kind, referenceExternalTransactionId: 'ref-1' });
      expect(tx.assessReference(ref)).toEqual({
        outcome: 'rejected',
        code: FailureCode.ReferenceKindNotAllowed,
      });
    });

    test('ROLLBACK de WIN e de REFUND são permitidos', () => {
      const w = processed({ externalTransactionId: 'win-1', kind: Kind.Win });
      const r = processed({ externalTransactionId: 'ref-1', kind: Kind.Refund, referenceExternalTransactionId: 'bet-0' });
      expect(reversal(Kind.Rollback, 'win-1').assessReference(w)).toEqual({ outcome: 'valid' });
      expect(reversal(Kind.Rollback, 'ref-1').assessReference(r)).toEqual({ outcome: 'valid' });
    });

    test('reversão com valor diferente → AMOUNT_MISMATCH', () => {
      const ref = processed({ externalTransactionId: 'bet-1', money: brl('25.00') });
      expect(reversal(Kind.Refund, 'bet-1', '24.99').assessReference(ref)).toEqual({
        outcome: 'rejected',
        code: FailureCode.AmountMismatch,
      });
    });

    test('referência que não corresponde à informada é erro de programação', () => {
      const ref = processed({ externalTransactionId: 'bet-1' });
      expect(() => reversal(Kind.Refund, 'bet-2').assessReference(ref)).toThrow(InvalidWagerTransactionError);
      expect(() => newTransaction().assessReference(ref)).toThrow(InvalidWagerTransactionError);
      const otherProvider = processed({ externalTransactionId: 'bet-1', providerId: 'provider-b' });
      expect(() => reversal(Kind.Refund, 'bet-1').assessReference(otherProvider)).toThrow(
        InvalidWagerTransactionError,
      );
    });
  });
});
