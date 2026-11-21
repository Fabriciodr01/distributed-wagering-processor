import { InvalidWagerTransactionError } from '../../domain/errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events';
import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import { FailureCode } from '../../domain/failure-code';
import { InboxMessage } from '../../domain/inbox-message';
import { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  InboxMessageConflictError,
  InvalidWagerRequestError,
  TransientFailureError,
  WalletNotFoundError,
} from '../errors';
import type { Clock } from '../ports/clock.port';
import type { IdGenerator } from '../ports/id-generator.port';
import type { IngressSource, Telemetry } from '../ports/telemetry.port';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.port';
import { type ReferenceRetryPolicy, referenceRetryDelayMs } from './reference-retry-policy';
import {
  type InboxContext,
  inboxPayloadHash,
  type ProcessWagerTransactionCommand,
  wagerPayloadHash,
} from './wager-transaction-command';
import { resultOf, type WagerTransactionResult } from './wager-transaction-result';

export interface ProcessWagerTransactionSettings {
  readonly referenceRetry: ReferenceRetryPolicy;
}

/** Resultado de uma mensagem da fila: aplicada agora, ou já vista antes (redelivery). */
export type QueueProcessingResult =
  | { readonly kind: 'applied'; readonly result: WagerTransactionResult }
  | { readonly kind: 'duplicate' };

/** O que aconteceu com uma transação PENDING_REFERENCE reavaliada pelo worker. */
export type ReprocessOutcome = 'processed' | 'rejected' | 'still_pending' | 'expired' | 'skipped';

const MAX_DEADLOCK_RETRIES = 3;

type Evaluation =
  | { readonly kind: 'processed'; readonly entry?: WalletLedgerEntry; readonly referenceTransactionId?: string }
  | { readonly kind: 'rejected'; readonly code: FailureCode }
  | { readonly kind: 'pending_reference' };

interface Decision {
  readonly scope: TransactionScope;
  readonly wallet: Wallet;
  readonly transaction: WagerTransaction;
  readonly evaluation: Evaluation;
  /** Número desta avaliação: 1 na submissão, +1 a cada reavaliação do worker. */
  readonly attempt: number;
  readonly correlationId: string;
  readonly at: Date;
}

/**
 * Caso de uso único de transação de aposta, usado pela API, pelo consumidor da fila e
 * pelo worker de PENDING_REFERENCE. Cada execução é uma transação SQL com a wallet
 * travada desde o início: trava wallet → (reserva idempotência) → regras → ledger → outbox.
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly settings: ProcessWagerTransactionSettings,
    private readonly telemetry: Telemetry,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    const startedAt = performance.now();
    const result = await this.withDeadlockRetry(() => {
      // Recriada a cada tentativa: uma tentativa abortada pode ter deixado o objeto já decidido.
      const transaction = this.buildTransaction(command);
      return this.unitOfWork.run((scope) => this.submit(scope, command, transaction));
    });
    this.observeSubmission('http', command.kind, result, startedAt);
    return result;
  }

  /**
   * Mesmo fluxo da API, com o inbox reservado no início da mesma transação SQL: uma
   * redelivery do mesmo messageId não tem efeito, e o registro só existe se tudo commitar.
   */
  async executeFromQueue(command: ProcessWagerTransactionCommand, inbox: InboxContext): Promise<QueueProcessingResult> {
    const startedAt = performance.now();
    const outcome = await this.withDeadlockRetry(() => {
      const transaction = this.buildTransaction(command);
      return this.unitOfWork.run(async (scope) => {
        const message = InboxMessage.receive({
          consumerName: inbox.consumerName,
          messageId: inbox.messageId,
          payloadHash: inboxPayloadHash(command),
          receivedAt: this.clock.now(),
        });
        if (!(await scope.inbox.insertIfAbsent(message))) {
          const existing = await scope.inbox.find(inbox.consumerName, inbox.messageId);
          if (!existing?.matchesPayload(message.payloadHash)) throw new InboxMessageConflictError(inbox.messageId);
          return { kind: 'duplicate' } as const;
        }
        const result = await this.submit(scope, command, transaction);
        message.markProcessed(this.clock.now());
        await scope.inbox.markProcessed(message);
        return { kind: 'applied', result } as const;
      });
    });
    if (outcome.kind === 'duplicate') this.telemetry.duplicateDetected('sqs');
    else this.observeSubmission('sqs', command.kind, outcome.result, startedAt);
    return outcome;
  }

  /**
   * Deixa auditável um pedido que nunca pôde ser processado (ex.: retries da fila esgotados):
   * grava a transação já como FAILED, sem mexer no saldo. Melhor esforço: só quando a wallet
   * existe e a transação ainda não foi gravada por outra tentativa.
   */
  async recordFailedSubmission(
    command: ProcessWagerTransactionCommand,
    code: FailureCode,
  ): Promise<'recorded' | 'skipped'> {
    const transaction = this.buildTransaction(command);
    transaction.fail({ code, at: this.clock.now() });
    const outcome = await this.unitOfWork.run(async (scope) => {
      if (!(await scope.wallets.findById(command.walletId))) return 'skipped';
      return (await scope.transactions.insertIfAbsent(transaction)) ? 'recorded' : 'skipped';
    });
    if (outcome === 'recorded') this.telemetry.transactionDecided(WagerTransactionStatus.Failed, command.kind);
    return outcome;
  }

  /** Reavalia uma transação que aguarda a referência; chamada pelo worker. */
  async reprocessPendingReference(transactionId: string): Promise<ReprocessOutcome> {
    const { outcome, transaction } = await this.withDeadlockRetry(() =>
      this.unitOfWork.run((scope) => this.reprocess(scope, transactionId)),
    );
    if (outcome === 'still_pending') this.telemetry.retryScheduled('pending_reference');
    else if (transaction && outcome !== 'skipped') this.telemetry.transactionDecided(transaction.status, transaction.kind);
    return outcome;
  }

  /**
   * Registra uma reavaliação que falhou por erro inesperado: conta como tentativa e,
   * no limite, a transação vira FAILED (PERMANENT_PROCESSING_ERROR) em vez de ficar presa.
   */
  async recordReprocessFailure(transactionId: string): Promise<'rescheduled' | 'failed' | 'skipped'> {
    const { outcome, kind } = await this.unitOfWork.run(async (scope) => {
      const locked = await this.lockPending(scope, transactionId);
      if (!locked) return { outcome: 'skipped' as const };
      const { ticket } = locked;
      const attempt = ticket.attempts + 1;
      if (attempt >= this.settings.referenceRetry.maxAttempts) {
        ticket.transaction.fail({ code: FailureCode.PermanentProcessingError, at: this.clock.now() });
        await scope.transactions.update(ticket.transaction, { schedule: { attempts: attempt } });
        return { outcome: 'failed' as const, kind: ticket.transaction.kind };
      }
      await scope.transactions.update(ticket.transaction, {
        schedule: { attempts: attempt, nextAttemptInMs: referenceRetryDelayMs(attempt, this.settings.referenceRetry) },
      });
      return { outcome: 'rescheduled' as const, kind: ticket.transaction.kind };
    });
    if (outcome === 'rescheduled') this.telemetry.retryScheduled('pending_reference');
    if (outcome === 'failed' && kind) this.telemetry.transactionDecided(WagerTransactionStatus.Failed, kind);
    return outcome;
  }

  /** Sinais emitidos só depois do commit: uma tentativa desfeita não conta. */
  private observeSubmission(
    source: IngressSource,
    kind: WagerTransactionKind,
    result: WagerTransactionResult,
    startedAt: number,
  ): void {
    if (result.idempotentReplay) this.telemetry.duplicateDetected(source);
    else this.telemetry.transactionDecided(result.status, kind);
    this.telemetry.processingDuration(source, (performance.now() - startedAt) / 1000);
  }

  private async withDeadlockRetry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (error instanceof TransientFailureError && error.kind !== 'unavailable') {
          this.telemetry.lockConflict(error.kind);
        }
        // A wallet é sempre travada primeiro, então deadlock é raro; quando acontece, repetir resolve.
        const retryable = error instanceof TransientFailureError && error.kind === 'deadlock';
        if (!retryable || attempt >= MAX_DEADLOCK_RETRIES) throw error;
        await sleep(10 + Math.floor(Math.random() * 40));
      }
    }
  }

  private buildTransaction(command: ProcessWagerTransactionCommand): WagerTransaction {
    if (command.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerRequestError('OPENING é interno e não pode ser submetido');
    }
    try {
      return WagerTransaction.create({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: wagerPayloadHash(command),
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: command.money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: this.clock.now(),
      });
    } catch (error) {
      if (error instanceof InvalidWagerTransactionError) throw new InvalidWagerRequestError(error.message);
      throw error;
    }
  }

  private async submit(
    scope: TransactionScope,
    command: ProcessWagerTransactionCommand,
    transaction: WagerTransaction,
  ): Promise<WagerTransactionResult> {
    // 1. Trava a wallet antes de qualquer escrita: serializa tudo que mexe nela.
    const wallet = await scope.wallets.findByIdForUpdate(command.walletId);
    if (!wallet) throw new WalletNotFoundError(command.walletId);

    // 2. Reserva a idempotência. Conflito = replay (mesmo payload) ou 409 (payload diferente).
    if (!(await scope.transactions.insertIfAbsent(transaction))) {
      return resultOf(await this.findOriginal(scope, transaction), true);
    }

    // 3. Regras de negócio e resultado, no mesmo commit.
    const at = this.clock.now();
    const evaluation = await this.evaluate(scope, wallet, transaction, at);
    await this.decide({ scope, wallet, transaction, evaluation, attempt: 1, correlationId: command.correlationId, at });
    return resultOf(transaction, false);
  }

  private async reprocess(
    scope: TransactionScope,
    transactionId: string,
  ): Promise<{ outcome: ReprocessOutcome; transaction?: WagerTransaction }> {
    const locked = await this.lockPending(scope, transactionId);
    if (!locked) return { outcome: 'skipped' };
    const { wallet, ticket } = locked;

    const at = this.clock.now();
    const evaluation = await this.evaluate(scope, wallet, ticket.transaction, at);
    // Sem o request original, o correlationId dos eventos é a própria transação.
    const outcome = await this.decide({
      scope,
      wallet,
      transaction: ticket.transaction,
      evaluation,
      attempt: ticket.attempts + 1,
      correlationId: ticket.transaction.id,
      at,
    });
    return { outcome, transaction: ticket.transaction };
  }

  /**
   * Mesma ordem de locks da submissão (wallet, depois transação), e confirma com a linha
   * travada que ela ainda aguarda referência: outra instância pode ter decidido antes.
   */
  private async lockPending(scope: TransactionScope, transactionId: string) {
    const snapshot = await scope.transactions.findById(transactionId);
    if (snapshot?.status !== WagerTransactionStatus.PendingReference) return null;
    const wallet = await scope.wallets.findByIdForUpdate(snapshot.walletId);
    const ticket = await scope.transactions.findPendingForUpdate(transactionId);
    if (!wallet || !ticket) return null;
    return { wallet, ticket };
  }

  /** Grava o resultado e os eventos correspondentes na outbox (D-08). */
  private async decide(decision: Decision): Promise<ReprocessOutcome> {
    const { scope, wallet, transaction, evaluation, attempt, correlationId, at } = decision;
    const ctx = (): EventContext => ({ eventId: this.ids.next(), correlationId, occurredAt: at });
    const events: IntegrationEvent<unknown>[] = [];
    let outcome: ReprocessOutcome;

    if (evaluation.kind === 'processed') {
      transaction.markProcessed({
        referenceTransactionId: evaluation.referenceTransactionId,
        resultingBalance: wallet.balance,
        at,
      });
      await scope.transactions.update(transaction);
      events.push(WagerTransactionProcessed.from(transaction, ctx()));
      if (evaluation.entry) events.push(WalletBalanceChanged.from(wallet, evaluation.entry, ctx()));
      outcome = 'processed';
    } else if (evaluation.kind === 'rejected' || attempt >= this.settings.referenceRetry.maxAttempts) {
      const code = evaluation.kind === 'rejected' ? evaluation.code : FailureCode.ReferenceNotFoundExpired;
      transaction.reject({ code, resultingBalance: wallet.balance, at });
      await scope.transactions.update(transaction, { schedule: { attempts: attempt } });
      events.push(WagerTransactionRejected.from(transaction, ctx()));
      outcome = evaluation.kind === 'rejected' ? 'rejected' : 'expired';
    } else {
      const firstTime = transaction.status === WagerTransactionStatus.Pending;
      if (firstTime) transaction.markPendingReference({ resultingBalance: wallet.balance });
      await scope.transactions.update(transaction, {
        schedule: { attempts: attempt, nextAttemptInMs: referenceRetryDelayMs(attempt, this.settings.referenceRetry) },
      });
      // O evento de pendência sai uma vez só, quando a transação começa a esperar.
      if (firstTime) events.push(WagerTransactionPendingReference.from(transaction, ctx()));
      outcome = 'still_pending';
    }

    await scope.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));
    return outcome;
  }

  /** Regras em ordem: estruturais, depois a referência, por fim o saldo. Só move saldo em "processed". */
  private async evaluate(
    scope: TransactionScope,
    wallet: Wallet,
    transaction: WagerTransaction,
    at: Date,
  ): Promise<Evaluation> {
    if (!wallet.acceptsCurrency(transaction.money.currency)) {
      return { kind: 'rejected', code: FailureCode.CurrencyMismatch };
    }
    if (!wallet.isOwnedBy(transaction.playerId)) {
      return { kind: 'rejected', code: FailureCode.PlayerWalletMismatch };
    }

    let reference: WagerTransaction | undefined;
    if (transaction.referenceExternalTransactionId) {
      reference =
        (await scope.transactions.findByExternalId(transaction.providerId, transaction.referenceExternalTransactionId)) ??
        undefined;
      if (!reference) return { kind: 'pending_reference' };

      const assessment = transaction.assessReference(reference);
      if (assessment.outcome === 'pending') return { kind: 'pending_reference' };
      if (assessment.outcome === 'rejected') return { kind: 'rejected', code: assessment.code };
      if (transaction.isReversal() && (await scope.transactions.isReversed(reference.id))) {
        return { kind: 'rejected', code: FailureCode.ReferenceAlreadyReversed };
      }
    }

    if (!transaction.affectsBalance()) {
      return { kind: 'processed', referenceTransactionId: reference?.id };
    }

    const direction = transaction.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
      // Reversão sem saldo é situação operacional diferente de aposta sem saldo.
      const code = transaction.isReversal() ? FailureCode.ReversalWouldOverdraw : FailureCode.InsufficientFunds;
      return { kind: 'rejected', code };
    }

    const entry = wallet.move(direction, {
      ledgerEntryId: this.ids.next(),
      transactionId: transaction.id,
      money: transaction.money,
      at,
    });
    await scope.wallets.update(wallet);
    await scope.ledger.append(entry);
    return { kind: 'processed', entry, referenceTransactionId: reference?.id };
  }

  /**
   * A transação conflitante já está commitada (o INSERT esperou por ela). Prioridade
   * para a chave de idempotência, que é a fonte da verdade; depois o externalTransactionId.
   */
  private async findOriginal(scope: TransactionScope, transaction: WagerTransaction): Promise<WagerTransaction> {
    const byKey = await scope.transactions.findByIdempotencyKey(transaction.providerId, transaction.idempotencyKey);
    if (byKey) {
      if (!byKey.matchesPayload(transaction.payloadHash)) {
        throw new IdempotencyKeyConflictError(transaction.providerId, byKey.id);
      }
      return byKey;
    }
    const byExternalId = await scope.transactions.findByExternalId(
      transaction.providerId,
      transaction.externalTransactionId,
    );
    if (byExternalId) {
      if (!byExternalId.matchesPayload(transaction.payloadHash)) {
        throw new ExternalTransactionConflictError(transaction.providerId, byExternalId.id);
      }
      return byExternalId;
    }
    // O conflito sumiu entre o INSERT e a leitura: impossível, já que transações nunca são apagadas.
    throw new Error(`Conflito de idempotência sem transação correspondente (${transaction.id})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
