import { z } from 'zod';
import { moneySchema, uuidSchema } from '../validation/common.schemas';

export const createWalletBodySchema = z.object({
  playerId: uuidSchema,
  initialBalance: moneySchema,
});

export type CreateWalletBody = z.output<typeof createWalletBodySchema>;

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;

export const ledgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(LEDGER_MAX_LIMIT).default(LEDGER_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(256).optional(),
});

export type LedgerQuery = z.output<typeof ledgerQuerySchema>;
