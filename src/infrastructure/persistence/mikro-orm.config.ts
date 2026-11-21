import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { ENTITIES } from './entities';
import { MIGRATIONS } from './migrations';

export interface DatabaseOptions {
  readonly url: string;
  readonly poolMax: number;
}

export function buildOrmOptions(database: DatabaseOptions): Options {
  return defineConfig({
    clientUrl: database.url,
    pool: { min: 0, max: database.poolMax },
    entities: ENTITIES,
    discovery: { warnWhenNoEntities: false },
    // Toda escrita usa um EntityManager próprio (fork) dentro de transactional().
    allowGlobalContext: false,
    forceUtcTimezone: true,
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList: MIGRATIONS,
      transactional: true,
      allOrNothing: true,
      // O schema é escrito à mão em SQL nas migrations; não há snapshot gerado.
      snapshot: false,
      snapshotOnMigrate: false,
      silent: true,
    },
  });
}
