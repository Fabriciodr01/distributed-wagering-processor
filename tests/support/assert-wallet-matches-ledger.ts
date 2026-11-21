import { expect } from 'bun:test';
import type { SQL } from 'bun';

interface BalanceRow {
  stored: string;
  calculated: string;
}

/**
 * Invariante final de todo teste financeiro: o saldo materializado da wallet
 * é igual ao saldo reconstruído pelo ledger. A soma é feita em `numeric` no banco
 * e comparada como string, sem passar por ponto flutuante.
 */
export async function assertWalletMatchesLedger(sql: SQL, walletId: string): Promise<void> {
  const rows: BalanceRow[] = await sql`
    SELECT
      w.balance::text AS stored,
      COALESCE(
        SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),
        0
      )::numeric(20, 2)::text AS calculated
    FROM wallets w
    LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
    WHERE w.id = ${walletId}
    GROUP BY w.id, w.balance
  `;
  const row = rows[0];
  if (!row) throw new Error(`Wallet ${walletId} não existe`);
  expect(row.calculated).toBe(row.stored);
}

/**
 * A mesma invariante para todas as wallets do banco. Roda no fim de toda suíte
 * (ver `TestDatabase.drop`), inclusive nas que não mexem em saldo de propósito.
 */
export async function assertAllWalletsMatchLedger(sql: SQL): Promise<void> {
  const divergent = await sql`
    SELECT w.id, w.balance::text AS stored,
           COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20, 2)::text
             AS calculated
      FROM wallets w
      LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
     GROUP BY w.id, w.balance
    HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
  `;
  expect(divergent, 'wallets com saldo diferente do ledger').toEqual([]);
}
