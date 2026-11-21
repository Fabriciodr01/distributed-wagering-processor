/** Endereços da infraestrutura de teste (docker-compose.test.yml). */
export const testInfra = {
  adminDatabaseUrl:
    process.env.TEST_DATABASE_URL ?? 'postgres://wager:wager@localhost:5433/wager',
  sqsEndpoint: process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4567',
} as const;

export function uniqueSuffix(): string {
  return Bun.randomUUIDv7().replaceAll('-', '').slice(-12);
}
