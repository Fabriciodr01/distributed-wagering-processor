import type { MigrationObject } from '@mikro-orm/core';

// Lista explícita (em ordem) em vez de descoberta por glob: funciona igual no Bun,
// no container e nos testes, sem depender de caminho de arquivo em runtime.
export const MIGRATIONS: MigrationObject[] = [];
