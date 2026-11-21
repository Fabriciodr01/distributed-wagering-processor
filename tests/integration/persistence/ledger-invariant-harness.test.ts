import { describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { seedWallet } from '../../support/sql-fixtures';
import { createTestDatabase } from '../../support/test-database';
import { testInfra } from '../../support/test-env';

describe('harness: invariante saldo == ledger no fim de toda suíte', () => {
  test('drop() falha se alguma wallet divergir do ledger, e ainda assim apaga o banco', async () => {
    const db = await createTestDatabase();
    const wallet = await seedWallet(db.sql, { balance: '100.00' });

    // Divergência forçada: só é possível desligando os triggers (o usuário de teste é superuser).
    await db.sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE wallets SET balance = 90, version = 2 WHERE id = ${wallet.walletId}`;
    });

    await expect(db.drop()).rejects.toThrow();

    const admin = new SQL(testInfra.adminDatabaseUrl, { max: 1 });
    try {
      const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${db.name}`;
      expect(rows).toHaveLength(0);
    } finally {
      await admin.close();
    }
  });

  test('drop() passa quando todas as wallets batem com o ledger', async () => {
    const db = await createTestDatabase();
    await seedWallet(db.sql, { balance: '100.00' });
    await seedWallet(db.sql, { balance: '0.00' });
    await db.drop();
  });
});
