import { expect } from 'bun:test';
import type { SQL } from 'bun';
import { Money } from '../../src/domain/money';

/**
 * Escrita direta no banco para os testes de schema: monta estados válidos e
 * viola cada garantia de propósito, sem passar pela aplicação.
 */

export const HASH = 'a'.repeat(64);

const uuid = () => Bun.randomUUIDv7();

export interface SeededWallet {
  readonly walletId: string;
  readonly playerId: string;
  readonly currency: string;
}

type Row = Record<string, unknown>;

export function transactionRow(wallet: SeededWallet, overrides: Row = {}): Row {
  const externalId = uuid();
  return {
    id: uuid(),
    provider_id: 'provider-a',
    external_transaction_id: externalId,
    idempotency_key: `provider-a:${externalId}`,
    payload_hash: HASH,
    wallet_id: wallet.walletId,
    player_id: wallet.playerId,
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: wallet.currency,
    status: 'PENDING',
    created_at: new Date(),
    ...overrides,
  };
}

/** Wallet com saldo inicial; com saldo positivo grava também a OPENING e o CREDIT. */
export async function seedWallet(
  sql: SQL,
  { balance = '100.00', currency = 'BRL' }: { balance?: string; currency?: string } = {},
): Promise<SeededWallet> {
  const wallet = { walletId: uuid(), playerId: uuid(), currency };
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
      VALUES (${wallet.walletId}, ${wallet.playerId}, ${currency}, ${balance}, 1, now(), now())`;
    if (balance !== '0.00') {
      const opening = transactionRow(wallet, {
        provider_id: 'internal',
        external_transaction_id: `opening:${wallet.walletId}`,
        idempotency_key: `opening:${wallet.walletId}`,
        kind: 'OPENING',
        amount: balance,
        status: 'PROCESSED',
        resulting_balance: balance,
        processed_at: new Date(),
      });
      await tx`INSERT INTO wager_transactions ${tx(opening)}`;
      await tx`
        INSERT INTO wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, created_at)
        VALUES (${uuid()}, ${wallet.walletId}, ${opening.id}, 'CREDIT', ${balance}, 0, ${balance}, now())`;
    }
  });
  return wallet;
}

/**
 * Aplica uma transação que move saldo do jeito que a aplicação fará: transação,
 * lançamento encadeado e wallet com version + 1, tudo no mesmo commit.
 */
export async function applyTransaction(
  sql: SQL,
  wallet: SeededWallet,
  { direction, amount, ...overrides }: { direction: 'DEBIT' | 'CREDIT'; amount: string } & Row,
): Promise<Row> {
  const row = transactionRow(wallet, { amount, ...overrides });
  await sql.begin(async (tx) => {
    const [current] = await tx`SELECT balance FROM wallets WHERE id = ${wallet.walletId} FOR UPDATE`;
    const before = Money.from({ amount: current.balance, currency: wallet.currency });
    const delta = Money.from({ amount, currency: wallet.currency });
    const after = (direction === 'CREDIT' ? before.add(delta) : before.subtract(delta)).toJSON().amount;
    await tx`INSERT INTO wager_transactions ${tx({ ...row, status: 'PENDING' })}`;
    await tx`
      INSERT INTO wallet_ledger_entries
        (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, created_at)
      VALUES (${uuid()}, ${wallet.walletId}, ${row.id}, ${direction}, ${amount}, ${current.balance}, ${after}, now())`;
    await tx`
      UPDATE wallets SET balance = ${after}, version = version + 1, updated_at = now()
       WHERE id = ${wallet.walletId}`;
    await tx`
      UPDATE wager_transactions
         SET status = 'PROCESSED', resulting_balance = ${after}, processed_at = now()
       WHERE id = ${row.id}`;
  });
  return row;
}

export interface ExpectedDbError {
  /** SQLSTATE, ex.: 23505 (unique), 23514 (check/invariante), 23503 (FK). */
  readonly sqlState: string;
  readonly constraint?: string;
  readonly message?: RegExp;
}

export async function expectDbError(action: () => Promise<unknown>, expected: ExpectedDbError): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'o banco deveria ter recusado a operação').toBeInstanceOf(Error);
  const error = caught as Error & { errno?: string; constraint?: string };
  expect(error.errno, error.message).toBe(expected.sqlState);
  if (expected.constraint) expect(error.constraint).toBe(expected.constraint);
  if (expected.message) expect(error.message).toMatch(expected.message);
}
