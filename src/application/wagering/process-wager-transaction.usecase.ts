import { InvalidWagerTransactionError } from '../../domain/errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events';
import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import { FailureCode } from '../../domain/failure-code';
import { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  InvalidWagerRequestError,
  TransientFailureError,
  WalletNotFoundError,
} from '../errors';
import type { Clock } from '../ports/clock.port';
import type { IdGenerator } from '../ports/id-generator.port';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.port';
import { type ProcessWagerTransactionCommand, wagerPayloadHash } from './wager-transaction-command';
import { resultOf, type WagerTransactionResult } from './wager-transaction-result';

export interface ProcessWagerTransactionSettings {
  /** Atraso da primeira reavaliação de uma transação que ficou PENDING_REFERENCE. */
  readonly referenceRetryBaseDelayMs: number;
}

const MAX_DEADLOCK_RETRIES = 3;

type Outcome =
  | { readonly kind: 'processed'; readonly entry?: WalletLedgerEntry; readonly referenceTransactionId?: string }
  | { readonly kind: 'rejected'; readonly code: FailureCode }
  | { readonly kind: 'pending_reference' };

/**
 * Caso de uso único de submissão de transação, usado pela API e pelo consumidor da fila.
 * Tudo acontece numa transação SQL, com a wallet travada desde o início:
 * trava wallet → reserva a idempotência → aplica as regras → ledger → outbox → commit.
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly settings: ProcessWagerTransactionSettings,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    for (let attempt = 0; ; attempt += 1) {
      // Recriada a cada tentativa: uma tentativa abortada pode ter deixado o objeto já decidido.
      const transaction = this.buildTransaction(command);
      try {
        return await this.unitOfWork.run((scope) => this.process(scope, command, transaction));
      } catch (error) {
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

  private async process(
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

    // 3. Regras de negócio, com a wallet travada.
    const at = this.clock.now();
    const outcome = await this.evaluate(scope, wallet, transaction, at);

    // 4. Resultado na transação, eventos na outbox, tudo no mesmo commit.
    const events: IntegrationEvent<unknown>[] = [];
    const ctx = (): EventContext => ({ eventId: this.ids.next(), correlationId: command.correlationId, occurredAt: at });
    switch (outcome.kind) {
      case 'processed':
        transaction.markProcessed({
          referenceTransactionId: outcome.referenceTransactionId,
          resultingBalance: wallet.balance,
          at,
        });
        await scope.transactions.update(transaction);
        events.push(WagerTransactionProcessed.from(transaction, ctx()));
        if (outcome.entry) events.push(WalletBalanceChanged.from(wallet, outcome.entry, ctx()));
        break;
      case 'rejected':
        transaction.reject({ code: outcome.code, resultingBalance: wallet.balance, at });
        await scope.transactions.update(transaction);
        events.push(WagerTransactionRejected.from(transaction, ctx()));
        break;
      case 'pending_reference':
        transaction.markPendingReference({ resultingBalance: wallet.balance });
        await scope.transactions.update(transaction, {
          nextAttemptInMs: this.settings.referenceRetryBaseDelayMs,
        });
        events.push(WagerTransactionPendingReference.from(transaction, ctx()));
        break;
    }
    await scope.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));

    return resultOf(transaction, false);
  }

  /** Regras D-07 na ordem documentada. Só move saldo no caminho "processed". */
  private async evaluate(
    scope: TransactionScope,
    wallet: Wallet,
    transaction: WagerTransaction,
    at: Date,
  ): Promise<Outcome> {
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
