import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261121000000EsquemaInicial } from './Migration20261121000000_esquema_inicial';

// Lista explícita (em ordem) em vez de descoberta por glob: funciona igual no Bun,
// no container e nos testes, sem depender de caminho de arquivo em runtime.
export const MIGRATIONS: MigrationObject[] = [
  { name: 'Migration20261121000000_esquema_inicial', class: Migration20261121000000EsquemaInicial },
];
