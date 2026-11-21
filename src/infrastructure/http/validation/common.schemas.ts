import { z } from 'zod';
import { InvalidMoneyError } from '../../../domain/errors';
import { Money } from '../../../domain/money';

/** A regra de formato é a do próprio Money: a borda não duplica a validação do domínio. */
export const moneySchema = z
  .object({ amount: z.unknown(), currency: z.unknown() })
  .transform((value, ctx) => {
    try {
      return Money.from(value as { amount: string; currency: string });
    } catch (error) {
      if (!(error instanceof InvalidMoneyError)) throw error;
      ctx.addIssue({ code: 'custom', message: error.message });
      return z.NEVER;
    }
  });

export const uuidSchema = z.uuid({ message: 'precisa ser um UUID' });

export const walletIdParamSchema = uuidSchema;
