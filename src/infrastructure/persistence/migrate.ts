import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmOptions, type DatabaseOptions } from './mikro-orm.config';

export type MigrationDirection = 'up' | 'down';

/** Aplica todas as migrations pendentes (`up`) ou reverte a última (`down`). */
export async function runMigrations(
  database: DatabaseOptions,
  direction: MigrationDirection,
): Promise<string[]> {
  const orm = await MikroORM.init(buildOrmOptions(database));
  try {
    const executed =
      direction === 'up' ? await orm.migrator.up() : await orm.migrator.down();
    return executed.map((migration) => migration.name);
  } finally {
    await orm.close(true);
  }
}
