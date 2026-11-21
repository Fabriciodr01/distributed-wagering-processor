import { loadConfig } from '../src/config/app-config';
import { type MigrationDirection, runMigrations } from '../src/infrastructure/persistence/migrate';

const direction = process.argv[2] ?? 'up';
if (direction !== 'up' && direction !== 'down') {
  console.error('Uso: bun scripts/migrate.ts [up|down]');
  process.exit(1);
}

const config = loadConfig();
const executed = await runMigrations(config.database, direction satisfies MigrationDirection);
if (executed.length === 0) {
  console.log(direction === 'up' ? 'Nenhuma migration pendente.' : 'Nenhuma migration para reverter.');
} else {
  console.log(`${direction === 'up' ? 'Aplicadas' : 'Revertidas'}: ${executed.join(', ')}`);
}
