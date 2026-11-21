import { z } from 'zod';
import { OPENING_PROVIDER_ID, WagerTransactionKind } from '../../domain/wager-transaction';
import { moneySchema, uuidSchema } from './common.schemas';

const identifier = z.string().trim().min(1).max(255);

/** OPENING não entra: é interno e nunca é submetido por provedores. */
export const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

/**
 * Contrato de entrada de uma transação de provedor, comum à API e à fila.
 * As regras que dependem do tipo (referência obrigatória, valor > 0) ficam no domínio.
 */
export const wagerTransactionPayloadSchema = z.object({
  providerId: identifier.refine((value) => value !== OPENING_PROVIDER_ID, {
    message: `"${OPENING_PROVIDER_ID}" é reservado para transações internas`,
  }),
  externalTransactionId: identifier,
  playerId: uuidSchema,
  walletId: uuidSchema,
  roundId: identifier,
  gameId: identifier,
  kind: z.enum(SUBMITTABLE_KINDS),
  money: moneySchema,
  referenceExternalTransactionId: identifier.optional(),
});

export type WagerTransactionPayload = z.output<typeof wagerTransactionPayloadSchema>;

export const idempotencyKeySchema = z.string().min(1).max(255);

export const WAGER_TRANSACTION_MESSAGE_TYPE = 'WagerTransactionRequested';

/** Mensagem da fila `wager-transactions.fifo`: o mesmo contrato da API, mais a chave de idempotência. */
export const wagerTransactionMessageSchema = z.object({
  messageId: z.string().trim().min(1).max(255),
  type: z.literal(WAGER_TRANSACTION_MESSAGE_TYPE),
  occurredAt: z.iso.datetime(),
  data: wagerTransactionPayloadSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});

export type WagerTransactionMessage = z.output<typeof wagerTransactionMessageSchema>;
