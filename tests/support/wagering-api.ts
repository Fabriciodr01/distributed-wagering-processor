import { expect } from 'bun:test';
import type { HttpClient } from './http';

export interface CreatedWallet {
  readonly id: string;
  readonly playerId: string;
  readonly balance: { amount: string; currency: string };
  readonly version: number;
}

export interface TransactionBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** Atalhos de teste sobre a API real: cria wallets e submete transações com defaults sensatos. */
export function wageringApi(api: HttpClient) {
  return {
    async createWallet(initial = '100.00', currency = 'BRL'): Promise<CreatedWallet> {
      const res = await api.post('/wallets', {
        playerId: Bun.randomUUIDv7(),
        initialBalance: { amount: initial, currency },
      });
      expect(res.status).toBe(201);
      return res.body as CreatedWallet;
    },

    transaction(wallet: CreatedWallet, overrides: Partial<TransactionBody> = {}): TransactionBody {
      return {
        providerId: 'provider-a',
        externalTransactionId: `tx-${Bun.randomUUIDv7()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: wallet.balance.currency },
        ...overrides,
      };
    },

    /** Idempotency-Key no formato recomendado: "{providerId}:{externalTransactionId}". */
    submit(body: TransactionBody, idempotencyKey = `${body.providerId}:${body.externalTransactionId}`) {
      return api.post('/wagering/transactions', body, { 'idempotency-key': idempotencyKey });
    },
  };
}
