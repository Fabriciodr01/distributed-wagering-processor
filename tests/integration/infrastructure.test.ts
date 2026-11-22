import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ListQueuesCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/config/app-config';
import type { ReadinessReport } from '../../src/infrastructure/observability/readiness.service';
import { runMigrations } from '../../src/infrastructure/persistence/migrate';
import { spawnInstance } from '../support/spawn-instance';
import { startTestApp, type TestApp } from '../support/test-app';
import { buildTestConfig, testEnvVars } from '../support/test-config';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, type TestQueues } from '../support/test-queues';

describe('infraestrutura de teste', () => {
  let db: TestDatabase;
  let queues: TestQueues;

  beforeAll(async () => {
    db = await createTestDatabase();
    queues = await createTestQueues();
  });

  afterAll(async () => {
    await queues?.destroy();
    await db?.drop();
  });

  test('banco por suíte é criado e as migrations rodam (up e down sem pendências)', async () => {
    const [row] = await db.sql`SELECT current_database() AS name`;
    expect(row.name).toBe(db.name);

    const [table] = await db.sql`SELECT to_regclass('public.mikro_orm_migrations')::text AS name`;
    expect(table.name).toBe('mikro_orm_migrations');

    // Rodar de novo é idempotente: nada pendente.
    expect(await runMigrations({ url: db.url, poolMax: 1 }, 'up')).toEqual([]);
  });

  test('as três filas FIFO existem, com redrive para a DLQ', async () => {
    const listed = await queues.client.send(new ListQueuesCommand({}));
    for (const url of Object.values(queues.urls)) {
      expect(listed.QueueUrls ?? []).toContain(url);
    }
  });

  describe('health', () => {
    let app: TestApp;

    beforeAll(async () => {
      app = await startTestApp(buildTestConfig({ databaseUrl: db.url, queues: queues.names }));
    });

    afterAll(async () => {
      await app?.close();
    });

    test('GET /health/live → 200', async () => {
      const res = await fetch(`${app.baseUrl}/health/live`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });

    test('GET /health/ready → 200 com Postgres e SQS de pé', async () => {
      const res = await fetch(`${app.baseUrl}/health/ready`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'ok',
        checks: { postgres: { status: 'up' }, sqs: { status: 'up' } },
      });
    });
  });

  test('GET /health/ready → 503 quando o Postgres está inalcançável', async () => {
    const config = buildTestConfig({
      // Porta 1: conexão recusada de imediato, sem depender de parar o container.
      databaseUrl: 'postgres://wager:wager@127.0.0.1:1/wager',
      queues: queues.names,
    });
    const app = await startTestApp(config);
    try {
      const res = await fetch(`${app.baseUrl}/health/ready`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as ReadinessReport;
      expect(body.status).toBe('unavailable');
      expect(body.checks.postgres.status).toBe('down');
      expect(body.checks.sqs.status).toBe('up');
    } finally {
      await app.close();
    }
  });

  test('GET /health/ready → 503 quando uma fila não existe', async () => {
    const config = buildTestConfig({
      databaseUrl: db.url,
      queues: { ...queues.names, events: 'fila-que-nao-existe.fifo' },
    });
    const app = await startTestApp(config);
    try {
      const res = await fetch(`${app.baseUrl}/health/ready`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as ReadinessReport;
      expect(body.checks.postgres.status).toBe('up');
      expect(body.checks.sqs.status).toBe('down');
    } finally {
      await app.close();
    }
  });

  test('a aplicação sobe como processo separado e fica pronta', async () => {
    const env = testEnvVars({ databaseUrl: db.url, queues: queues.names });
    expect(() => loadConfig(env)).not.toThrow();

    const instance = await spawnInstance(env, { waitForReady: true });
    await instance.stop('SIGKILL');
    expect(instance.process.exitCode !== null || instance.process.signalCode !== null).toBe(true);
  });

  // No Windows não existe SIGTERM entregável: o processo é terminado à força, sem hooks.
  test.skipIf(process.platform === 'win32')('SIGTERM encerra a instância de forma graciosa', async () => {
    const env = testEnvVars({ databaseUrl: db.url, queues: queues.names });
    const instance = await spawnInstance(env, { waitForReady: true });
    const exitCode = await instance.stop('SIGTERM');
    expect(exitCode, instance.output()).toBe(0);
  });

  test('a destruição das filas é idempotente', async () => {
    const extra = await createTestQueues();
    await extra.destroy();
    const listed = await queues.client.send(new ListQueuesCommand({}));
    for (const url of Object.values(extra.urls)) {
      expect(listed.QueueUrls ?? []).not.toContain(url);
    }
  });
});
