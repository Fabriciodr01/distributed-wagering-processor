import { beforeEach, describe, expect, test } from 'bun:test';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  InboxMessageConflictError,
  InvalidWagerRequestError,
  TransientFailureError,
  WalletNotFoundError,
} from '../../../src/application/errors';
import { ProcessWagerTransactionUseCase } from '../../../src/application/wagering/process-wager-transaction.usecase';
import type { ProcessWagerTransactionCommand } from '../../../src/application/wagering/wager-transaction-command';
import { FailureCode } from '../../../src/domain/failure-code';
import { Money } from '../../../src/domain/money';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../../src/domain/wager-transaction';
import { Wallet } from '../../../src/domain/wallet';
import { LedgerDirection } from '../../../src/domain/wallet-ledger-entry';
import { FixedClock, InMemoryDatabase, RecordingTelemetry, SequentialIds } from '../../support/in-memory-ports';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const PLAYER = 'player-1';
const WALLET = 'wallet-1';
const POLICY = { baseDelayMs: 1000, maxDelayMs: 4000, maxAttempts: 4 };

let db: InMemoryDatabase;
let telemetry: RecordingTelemetry;
let useCase: ProcessWagerTransactionUseCase;
let sequence: number;

function openWallet(initial: string, id = WALLET, playerId = PLAYER): void {
  const { wallet, openingEntry } = Wallet.open({
    id,
    playerId,
    initialBalance: brl(initial),
    at: new Date('2026-11-21T00:00:00.000Z'),
    opening: brl(initial).isPositive() ? { transactionId: `opening-${id}`, ledgerEntryId: `entry-${id}` } : undefined,
  });
  db.seedWallet(wallet, openingEntry);
}

function command(overrides: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand {
  sequence += 1;
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${sequence}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: PLAYER,
    walletId: WALLET,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    correlationId: 'corr-1',
    ...overrides,
  };
}

const reversal = (kind: Kind.Refund | Kind.Rollback, reference: ProcessWagerTransactionCommand, overrides = {}) =>
  command({ kind, referenceExternalTransactionId: reference.externalTransactionId, money: reference.money, ...overrides });

const balance = () => db.wallet(WALLET).balance.toJSON().amount;

beforeEach(() => {
  db = new InMemoryDatabase();
  telemetry = new RecordingTelemetry();
  useCase = new ProcessWagerTransactionUseCase(
    db,
    new FixedClock(),
    new SequentialIds(),
    { referenceRetry: POLICY },
    telemetry,
  );
  sequence = 0;
  openWallet('100.00');
});

describe('BET, WIN e LOSS', () => {
  test('BET debita, gera um lançamento e os eventos Processed + BalanceChanged', async () => {
    const result = await useCase.execute(command({ money: brl('30.00') }));

    expect(result).toMatchObject({ status: Status.Processed, idempotentReplay: false });
    expect(result.balance?.toJSON().amount).toBe('70.00');
    expect(balance()).toBe('70.00');
    expect(db.wallet(WALLET).version).toBe(2);
    expect(db.ledger.at(-1)?.direction).toBe(LedgerDirection.Debit);
    expect(db.eventTypesFor(result.transactionId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('WIN credita', async () => {
    await useCase.execute(command({ kind: Kind.Win, money: brl('5.50') }));
    expect(balance()).toBe('105.50');
    expect(db.ledger.at(-1)?.direction).toBe(LedgerDirection.Credit);
  });

  test('LOSS não mexe no saldo, não gera lançamento e emite só Processed', async () => {
    const entriesBefore = db.ledger.length;
    const result = await useCase.execute(command({ kind: Kind.Loss, money: brl('0.00') }));
    expect(result.status).toBe(Status.Processed);
    expect(balance()).toBe('100.00');
    expect(db.wallet(WALLET).version).toBe(1);
    expect(db.ledger).toHaveLength(entriesBefore);
    expect(db.eventTypesFor(result.transactionId)).toEqual(['WagerTransactionProcessed']);
  });

  test('BET sem saldo → REJECTED INSUFFICIENT_FUNDS, sem lançamento, evento Rejected', async () => {
    const result = await useCase.execute(command({ money: brl('100.01') }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.InsufficientFunds });
    expect(result.balance?.toJSON().amount).toBe('100.00');
    expect(db.ledger).toHaveLength(1);
    expect(db.eventTypesFor(result.transactionId)).toEqual(['WagerTransactionRejected']);
  });
});

describe('ordem das regras', () => {
  test('moeda é conferida antes do dono: as duas erradas → CURRENCY_MISMATCH', async () => {
    const result = await useCase.execute(
      command({ playerId: 'outro', money: Money.from({ amount: '1.00', currency: 'USD' }) }),
    );
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
  });

  test('dono diferente → PLAYER_WALLET_MISMATCH, antes de olhar a referência', async () => {
    const result = await useCase.execute(
      command({ playerId: 'outro', kind: Kind.Refund, referenceExternalTransactionId: 'nao-existe' }),
    );
    expect(result.failureCode).toBe(FailureCode.PlayerWalletMismatch);
  });

  test('referência com tipo errado é recusada antes de conferir o valor', async () => {
    const win = command({ kind: Kind.Win, money: brl('10.00') });
    await useCase.execute(win);
    const result = await useCase.execute(reversal(Kind.Refund, win, { money: brl('9.00') }));
    expect(result.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test('wallet inexistente lança WalletNotFoundError e nada é gravado', async () => {
    await expect(useCase.execute(command({ walletId: 'nao-existe' }))).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(db.transactions).toHaveLength(0);
    expect(db.outbox).toHaveLength(0);
  });

  test.each([
    ['OPENING', { kind: Kind.Opening }],
    ['REFUND sem referência', { kind: Kind.Refund }],
    ['BET com referência', { referenceExternalTransactionId: 'x' }],
    ['BET de valor zero', { money: brl('0.00') }],
  ])('%s → InvalidWagerRequestError, sem abrir transação', async (_, overrides) => {
    await expect(useCase.execute(command(overrides))).rejects.toBeInstanceOf(InvalidWagerRequestError);
    expect(db.runs).toBe(0);
  });
});

describe('idempotência', () => {
  test('mesmo comando duas vezes: replay com o resultado e o saldo originais, um único efeito', async () => {
    const bet = command({ money: brl('10.00') });
    const original = await useCase.execute(bet);
    await useCase.execute(command({ money: brl('10.00') }));
    const replay = await useCase.execute(bet);

    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(replay.balance?.toJSON().amount).toBe('90.00');
    expect(balance()).toBe('80.00');
    expect(db.transactions.filter((t) => t.state.externalTransactionId === bet.externalTransactionId)).toHaveLength(1);
    expect(db.eventTypesFor(original.transactionId)).toHaveLength(2);
  });

  test('mesma chave com payload diferente → IdempotencyKeyConflictError, sem efeito', async () => {
    const bet = command({ money: brl('10.00') });
    await useCase.execute(bet);
    await expect(useCase.execute({ ...bet, money: brl('11.00') })).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    expect(balance()).toBe('90.00');
  });

  test('mesmo externalTransactionId com outra chave: igual é replay, diferente é ExternalTransactionConflictError', async () => {
    const bet = command({ money: brl('10.00') });
    const original = await useCase.execute(bet);
    expect(await useCase.execute({ ...bet, idempotencyKey: 'outra' })).toEqual({ ...original, idempotentReplay: true });
    await expect(useCase.execute({ ...bet, idempotencyKey: 'terceira', money: brl('12.00') })).rejects.toBeInstanceOf(
      ExternalTransactionConflictError,
    );
  });

  test('a chave de idempotência e o correlationId não fazem parte do payload', async () => {
    const bet = command();
    const original = await useCase.execute(bet);
    const replay = await useCase.execute({ ...bet, correlationId: 'outro-request' });
    expect(replay.transactionId).toBe(original.transactionId);
  });
});

describe('REFUND e ROLLBACK', () => {
  test('REFUND de BET credita; a segunda reversão (de qualquer tipo) é REFERENCE_ALREADY_REVERSED', async () => {
    const bet = command({ money: brl('40.00') });
    const applied = await useCase.execute(bet);
    const refund = await useCase.execute(reversal(Kind.Refund, bet));

    expect(refund.status).toBe(Status.Processed);
    expect(db.transaction(refund.transactionId).state.referenceTransactionId).toBe(applied.transactionId);
    expect(balance()).toBe('100.00');
    for (const kind of [Kind.Refund, Kind.Rollback] as const) {
      expect((await useCase.execute(reversal(kind, bet))).failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    }
    expect(balance()).toBe('100.00');
  });

  test('ROLLBACK de WIN debita; sem saldo é REVERSAL_WOULD_OVERDRAW, distinto de INSUFFICIENT_FUNDS', async () => {
    const win = command({ kind: Kind.Win, money: brl('50.00') });
    await useCase.execute(win);
    await useCase.execute(command({ money: brl('140.00') }));
    const rollback = await useCase.execute(reversal(Kind.Rollback, win));
    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(balance()).toBe('10.00');
  });

  test.each([
    ['valor diferente', { money: brl('39.99') }, FailureCode.AmountMismatch],
    ['rodada diferente', { roundId: 'outra' }, FailureCode.ReferenceMismatch],
  ])('%s → %s', async (_, overrides, code) => {
    const bet = command({ money: brl('40.00') });
    await useCase.execute(bet);
    expect((await useCase.execute(reversal(Kind.Refund, bet, overrides))).failureCode).toBe(code);
  });

  test('referência recusada → REFERENCE_NOT_PROCESSED', async () => {
    const bet = command({ money: brl('500.00') });
    await useCase.execute(bet);
    expect((await useCase.execute(reversal(Kind.Refund, bet))).failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });
});

describe('PENDING_REFERENCE', () => {
  test('referência ausente: pendente na 1ª avaliação, com o primeiro atraso do backoff e um único evento', async () => {
    const bet = command({ money: brl('30.00') });
    const refund = await useCase.execute(reversal(Kind.Refund, bet));

    expect(refund.status).toBe(Status.PendingReference);
    expect(db.transaction(refund.transactionId)).toMatchObject({ attempts: 1, nextAttemptInMs: 1000 });
    expect(db.eventTypesFor(refund.transactionId)).toEqual(['WagerTransactionPendingReference']);
  });

  test('reavaliações seguem o backoff sem reemitir o evento; a referência chegando aplica a reversão', async () => {
    const bet = command({ money: brl('30.00') });
    const refund = await useCase.execute(reversal(Kind.Refund, bet));

    expect(await useCase.reprocessPendingReference(refund.transactionId)).toBe('still_pending');
    expect(db.transaction(refund.transactionId)).toMatchObject({ attempts: 2, nextAttemptInMs: 2000 });
    expect(await useCase.reprocessPendingReference(refund.transactionId)).toBe('still_pending');
    expect(db.transaction(refund.transactionId)).toMatchObject({ attempts: 3, nextAttemptInMs: 4000 });

    await useCase.execute(bet);
    expect(await useCase.reprocessPendingReference(refund.transactionId)).toBe('processed');
    expect(db.transaction(refund.transactionId).state.status).toBe(Status.Processed);
    expect(balance()).toBe('100.00');
    expect(db.eventTypesFor(refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('a referência decidida antecipa a reavaliação de quem a referencia (aplicada ou recusada)', async () => {
    const applied = command({ money: brl('30.00') });
    const refund = await useCase.execute(reversal(Kind.Refund, applied));
    const refused = command({ money: brl('999.00') });
    const rollback = await useCase.execute(reversal(Kind.Rollback, refused));
    const unrelated = await useCase.execute(command({ kind: Kind.Refund, referenceExternalTransactionId: 'outra' }));
    for (const id of [refund.transactionId, rollback.transactionId, unrelated.transactionId]) {
      expect(db.transaction(id).nextAttemptInMs).toBe(1000);
    }

    expect((await useCase.execute(applied)).status).toBe(Status.Processed);
    expect((await useCase.execute(refused)).status).toBe(Status.Rejected);

    expect(db.transaction(refund.transactionId).nextAttemptInMs).toBe(0);
    expect(db.transaction(rollback.transactionId).nextAttemptInMs).toBe(0);
    // Só antecipa: tentativas e status ficam como estavam, e quem referencia outra coisa não muda.
    expect(db.transaction(refund.transactionId)).toMatchObject({ attempts: 1 });
    expect(db.transaction(refund.transactionId).state.status).toBe(Status.PendingReference);
    expect(db.transaction(unrelated.transactionId).nextAttemptInMs).toBe(1000);

    expect(await useCase.reprocessPendingReference(refund.transactionId)).toBe('processed');
    expect(await useCase.reprocessPendingReference(rollback.transactionId)).toBe('rejected');
    expect(db.transaction(rollback.transactionId).state.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('dependente de outro provider não é antecipada', async () => {
    const bet = command({ money: brl('30.00') });
    const other = await useCase.execute(reversal(Kind.Refund, bet, { providerId: 'provider-b' }));
    await useCase.execute(bet);
    expect(db.transaction(other.transactionId).nextAttemptInMs).toBe(1000);
  });

  test('esgotadas as tentativas: REJECTED REFERENCE_NOT_FOUND_EXPIRED com evento Rejected', async () => {
    const refund = await useCase.execute(command({ kind: Kind.Refund, referenceExternalTransactionId: 'nunca' }));
    const outcomes = [];
    for (let i = 0; i < POLICY.maxAttempts - 1; i += 1) {
      outcomes.push(await useCase.reprocessPendingReference(refund.transactionId));
    }
    expect(outcomes).toEqual(['still_pending', 'still_pending', 'expired']);
    expect(db.transaction(refund.transactionId)).toMatchObject({ attempts: POLICY.maxAttempts });
    expect(db.transaction(refund.transactionId).state.failureCode).toBe(FailureCode.ReferenceNotFoundExpired);
    expect(db.eventTypesFor(refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await useCase.reprocessPendingReference(refund.transactionId)).toBe('skipped');
  });

  test('erro inesperado conta tentativa; no limite vira FAILED sem evento', async () => {
    const refund = await useCase.execute(command({ kind: Kind.Refund, referenceExternalTransactionId: 'nunca' }));
    expect(await useCase.recordReprocessFailure(refund.transactionId)).toBe('rescheduled');
    expect(await useCase.recordReprocessFailure(refund.transactionId)).toBe('rescheduled');
    expect(await useCase.recordReprocessFailure(refund.transactionId)).toBe('failed');
    expect(db.transaction(refund.transactionId).state).toMatchObject({
      status: Status.Failed,
      failureCode: FailureCode.PermanentProcessingError,
    });
    expect(db.eventTypesFor(refund.transactionId)).toEqual(['WagerTransactionPendingReference']);
  });
});

describe('falhas de infraestrutura', () => {
  test('deadlock é repetido com o pedido inteiro e o efeito acontece uma vez só', async () => {
    db.failures.push(new TransientFailureError('deadlock'), new TransientFailureError('deadlock'));
    const result = await useCase.execute(command({ money: brl('10.00') }));
    expect(result.status).toBe(Status.Processed);
    expect(db.runs).toBe(3);
    expect(balance()).toBe('90.00');
  });

  test('deadlock persistente desiste depois de 3 retentativas', async () => {
    db.failures.push(...Array.from({ length: 5 }, () => new TransientFailureError('deadlock')));
    await expect(useCase.execute(command())).rejects.toBeInstanceOf(TransientFailureError);
    expect(db.runs).toBe(4);
  });

  test('lock timeout não é repetido no caso de uso: vira 503 / retry da fila', async () => {
    db.failures.push(new TransientFailureError('lock_timeout'));
    await expect(useCase.execute(command())).rejects.toMatchObject({ kind: 'lock_timeout' });
    expect(db.runs).toBe(1);
  });

  test('falha no meio da execução desfaz tudo: sem transação, sem lançamento, sem evento', async () => {
    const failing = new ProcessWagerTransactionUseCase(
      {
        run: (work, options) =>
          db.run(async (scope) => {
            await work(scope);
            throw new Error('falha antes do commit');
          }, options),
      },
      new FixedClock(),
      new SequentialIds(),
      { referenceRetry: POLICY },
      telemetry,
    );
    await expect(failing.execute(command({ money: brl('10.00') }))).rejects.toThrow('falha antes do commit');
    expect(balance()).toBe('100.00');
    expect(db.transactions).toHaveLength(0);
    expect(db.outbox).toHaveLength(0);
  });
});

describe('entrada pela fila (inbox)', () => {
  const inbox = (messageId = 'msg-1') => ({ consumerName: 'consumer-a', messageId });

  test('primeira entrega aplica e grava o inbox processado; redelivery é duplicata sem efeito', async () => {
    const bet = command({ money: brl('10.00') });
    const first = await useCase.executeFromQueue(bet, inbox());
    expect(first.kind).toBe('applied');
    expect(db.inbox).toHaveLength(1);
    expect(db.inbox[0]!.isProcessed()).toBe(true);

    expect(await useCase.executeFromQueue(bet, inbox())).toEqual({ kind: 'duplicate' });
    expect(balance()).toBe('90.00');
    expect(db.transactions).toHaveLength(1);
  });

  test('o mesmo pedido em outra mensagem (outro messageId) é replay da transação, não novo débito', async () => {
    const bet = command({ money: brl('10.00') });
    await useCase.executeFromQueue(bet, inbox('msg-1'));
    const second = await useCase.executeFromQueue(bet, inbox('msg-2'));
    expect(second.kind === 'applied' && second.result.idempotentReplay).toBe(true);
    expect(balance()).toBe('90.00');
  });

  test('mesmo messageId com conteúdo diferente → InboxMessageConflictError', async () => {
    await useCase.executeFromQueue(command({ money: brl('10.00') }), inbox());
    await expect(useCase.executeFromQueue(command({ money: brl('11.00') }), inbox())).rejects.toBeInstanceOf(
      InboxMessageConflictError,
    );
  });

  test('a chave de idempotência faz parte do conteúdo da mensagem', async () => {
    const bet = command();
    await useCase.executeFromQueue(bet, inbox());
    await expect(useCase.executeFromQueue({ ...bet, idempotencyKey: 'outra' }, inbox())).rejects.toBeInstanceOf(
      InboxMessageConflictError,
    );
  });

  test('falha no processamento desfaz o inbox: a redelivery será processada de novo', async () => {
    await expect(useCase.executeFromQueue(command({ walletId: 'nao-existe' }), inbox())).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
    expect(db.inbox).toHaveLength(0);
  });
});

describe('registro de pedido que nunca pôde ser processado', () => {
  test('grava a transação já FAILED, sem lançamento nem evento; não grava duas vezes', async () => {
    const bet = command({ money: brl('10.00') });
    expect(await useCase.recordFailedSubmission(bet, FailureCode.ProcessingRetriesExhausted)).toBe('recorded');

    const [stored] = db.transactions;
    expect(stored!.state).toMatchObject({ status: Status.Failed, failureCode: FailureCode.ProcessingRetriesExhausted });
    expect(balance()).toBe('100.00');
    expect(db.ledger).toHaveLength(1);
    expect(db.outbox).toHaveLength(0);
    expect(await useCase.recordFailedSubmission(bet, FailureCode.ProcessingRetriesExhausted)).toBe('skipped');
  });

  test('sem wallet não há onde registrar: skipped', async () => {
    expect(
      await useCase.recordFailedSubmission(command({ walletId: 'nao-existe' }), FailureCode.ProcessingRetriesExhausted),
    ).toBe('skipped');
    expect(db.transactions).toHaveLength(0);
  });

  test('o replay de um pedido FAILED devolve FAILED (operação de suporte, não reprocesso silencioso)', async () => {
    const bet = command({ money: brl('10.00') });
    await useCase.recordFailedSubmission(bet, FailureCode.ProcessingRetriesExhausted);
    const replay = await useCase.execute(bet);
    expect(replay).toMatchObject({ status: Status.Failed, idempotentReplay: true });
    expect(balance()).toBe('100.00');
  });
});

describe('telemetria', () => {
  test('sinais só depois do commit: decisão, duplicata, retry de pendência e conflito de lock', async () => {
    const bet = command({ money: brl('10.00') });
    await useCase.execute(bet);
    await useCase.execute(bet);
    await useCase.execute(command({ money: brl('999.00') }));
    const refund = await useCase.execute(command({ kind: Kind.Refund, referenceExternalTransactionId: 'nunca' }));
    await useCase.reprocessPendingReference(refund.transactionId);
    db.failures.push(new TransientFailureError('lock_timeout'));
    await useCase.execute(command()).catch(() => {});

    expect(telemetry.signals()).toEqual([
      ['transactionDecided', Status.Processed, Kind.Bet],
      ['duplicateDetected', 'http'],
      ['transactionDecided', Status.Rejected, Kind.Bet],
      ['transactionDecided', Status.PendingReference, Kind.Refund],
      ['retryScheduled', 'pending_reference'],
      ['lockConflict', 'lock_timeout'],
    ]);
    expect(telemetry.calls.filter(([name]) => name === 'processingDuration')).toHaveLength(4);
  });

  test('tentativa desfeita não emite decisão', async () => {
    const failing = new ProcessWagerTransactionUseCase(
      { run: (work, options) => db.run(async (scope) => { await work(scope); throw new Error('rollback'); }, options) },
      new FixedClock(),
      new SequentialIds(),
      { referenceRetry: POLICY },
      telemetry,
    );
    await failing.execute(command()).catch(() => {});
    expect(telemetry.signals()).toEqual([]);
  });

  test('pela fila, redelivery conta como duplicata de origem sqs', async () => {
    const bet = command();
    await useCase.executeFromQueue(bet, { consumerName: 'c', messageId: 'm-1' });
    await useCase.executeFromQueue(bet, { consumerName: 'c', messageId: 'm-1' });
    expect(telemetry.signals()).toEqual([
      ['transactionDecided', Status.Processed, Kind.Bet],
      ['duplicateDetected', 'sqs'],
    ]);
  });
});
