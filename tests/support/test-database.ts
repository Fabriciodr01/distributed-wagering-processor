import { SQL } from 'bun';
import { runMigrations } from '../../src/infrastructure/persistence/migrate';
import { testInfra, uniqueSuffix } from './test-env';

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  /** Conexão direta para asserções e para violar constraints de propósito. */
  readonly sql: SQL;
  drop(): Promise<void>;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Cria um banco exclusivo da suíte e aplica todas as migrations. */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const name = `test_${uniqueSuffix()}`;
  const admin = new SQL(testInfra.adminDatabaseUrl, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.close();
  }

  const url = withDatabase(testInfra.adminDatabaseUrl, name);
  if (options.migrate ?? true) {
    await runMigrations({ url, poolMax: 2 }, 'up');
  }
  const sql = new SQL(url, { max: 5 });

  return {
    name,
    url,
    sql,
    async drop() {
      await sql.close();
      const cleanup = new SQL(testInfra.adminDatabaseUrl, { max: 1 });
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.close();
      }
    },
  };
}
