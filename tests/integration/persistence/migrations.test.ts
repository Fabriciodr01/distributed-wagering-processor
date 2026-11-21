import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runMigrations } from '../../../src/infrastructure/persistence/migrate';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const APP_TABLES = ['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'];

describe('migrations', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
  });

  afterAll(async () => {
    await db?.drop();
  });

  const options = () => ({ url: db.url, poolMax: 1 });

  const tables = async (): Promise<string[]> => {
    const rows: Array<{ name: string }> = await db.sql`
      SELECT tablename AS name FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'
       ORDER BY 1`;
    return rows.map((row) => row.name);
  };

  const functions = async (): Promise<number> => {
    const [row] = await db.sql`
      SELECT count(*)::int AS total FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'`;
    return row.total;
  };

  test('up → down → up sem erro, e o down remove tudo que o up criou', async () => {
    expect(await runMigrations(options(), 'up')).toEqual(['Migration20261121000000_esquema_inicial']);
    expect(await tables()).toEqual(APP_TABLES);
    expect(await functions()).toBeGreaterThan(0);

    expect(await runMigrations(options(), 'down')).toEqual(['Migration20261121000000_esquema_inicial']);
    expect(await tables()).toEqual([]);
    expect(await functions()).toBe(0);

    expect(await runMigrations(options(), 'up')).toEqual(['Migration20261121000000_esquema_inicial']);
    expect(await tables()).toEqual(APP_TABLES);
    expect(await runMigrations(options(), 'up')).toEqual([]);
  });
});
