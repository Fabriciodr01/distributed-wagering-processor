import type { Money } from '../../domain/money';
import type { WagerTransactionKind } from '../../domain/wager-transaction';
import { payloadHash } from '../payload-hash';

/** Pedido de transação de um provedor, já validado na borda (HTTP ou SQS). */
export interface ProcessWagerTransactionCommand {
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  /** Rastreio: vira o correlationId dos eventos. */
  readonly correlationId: string;
}

/**
 * Hash do subconjunto de negócio. A chave de idempotência e os metadados de
 * transporte ficam de fora: o mesmo pedido chegando por HTTP ou SQS tem o mesmo hash.
 */
export function wagerPayloadHash(command: ProcessWagerTransactionCommand): string {
  const money = command.money.toJSON();
  return payloadHash({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: { amount: money.amount, currency: money.currency },
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  });
}
