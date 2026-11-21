/**
 * Teste de carga (bônus do enunciado): `bun run test:load`.
 *
 * Autocontido: usa a infraestrutura de teste (`bun run infra:test:up`), cria um banco e filas
 * próprios, sobe 3 instâncias da aplicação em processos separados e dispara três cenários:
 *   (a) hot wallet  — muitas apostas concorrentes numa única wallet;
 *   (b) espalhado   — M wallets × K apostas;
 *   (c) duplicatas  — 10% das requisições são reenvios idênticos (mesma Idempotency-Key).
 * No fim confere saldo = ledger em todas as wallets e a reconciliação de cada uma, imprime uma
 * tabela Markdown e grava `load-test-report.md`. Sai com código 1 se alguma invariante falhar.
 *
 * Parâmetros por env: LOAD_INSTANCES (3), LOAD_CONCURRENCY (48), LOAD_HOT_REQUESTS (600),
 * LOAD_SPREAD_WALLETS (40), LOAD_SPREAD_BETS (25), LOAD_DUP_REQUESTS (1000), LOAD_DB_POOL_MAX (10).
 */
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { SQL } from 'bun';
import { SQS_MAX_RECEIVE_COUNT } from '../src/config/app-config';
import { runMigrations } from '../src/infrastructure/persistence/migrate';
import { deleteQueues, ensureQueues } from '../src/infrastructure/sqs/queue-setup';
import { createSqsClient } from '../src/infrastructure/sqs/sqs-client';
import { type SpawnedInstance, spawnInstance } from '../tests/support/spawn-instance';
import { testEnvVars } from '../tests/support/test-config';
import { testInfra, uniqueSuffix } from '../tests/support/test-env';
import { testSqsConnection } from '../tests/support/test-queues';

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const INSTANCES = env('LOAD_INSTANCES', 3);
const CONCURRENCY = env('LOAD_CONCURRENCY', 48);
const HOT_REQUESTS = env('LOAD_HOT_REQUESTS', 600);
const SPREAD_WALLETS = env('LOAD_SPREAD_WALLETS', 40);
const SPREAD_BETS = env('LOAD_SPREAD_BETS', 25);
const DUP_REQUESTS = env('LOAD_DUP_REQUESTS', 1000);
const DB_POOL_MAX = env('LOAD_DB_POOL_MAX', 10);
const REPORT_PATH = resolve(import.meta.dir, '..', 'load-test-report.md');

interface Wallet {
  readonly id: string;
  readonly playerId: string;
}

interface Request {
  readonly instance: number;
  readonly body: Record<string, unknown>;
  readonly key: string;
}

interface Sample {
  readonly status: number;
  readonly ms: number;
  readonly replay: boolean;
  readonly outcome: string;
}

interface MetricsSnapshot {
  readonly lockTimeouts: number;
  readonly deadlocks: number;
  readonly lockWaitCount: number;
  readonly lockWaitSum: number;
  readonly lockWaitBuckets: ReadonlyMap<number, number>;
}

interface ScenarioResult {
  readonly name: string;
  readonly description: string;
  readonly requests: number;
  readonly durationS: number;
  readonly samples: readonly Sample[];
  readonly metrics: MetricsSnapshot;
  readonly lagPeakS: number;
  readonly drainS: number;
}

// ------------------------------------------------------------------ infraestrutura

const suffix = uniqueSuffix();
const dbName = `load_${suffix}`;
const dbUrl = (() => {
  const url = new URL(testInfra.adminDatabaseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
})();
const queueNames = {
  transactions: `wager-transactions-load-${suffix}.fifo`,
  dlq: `wager-transactions-dlq-load-${suffix}.fifo`,
  events: `wager-events-load-${suffix}.fifo`,
};
const sqs = createSqsClient(testSqsConnection());
let sql: SQL | undefined;
let instances: SpawnedInstance[] = [];

async function setUp(): Promise<void> {
  const admin = new SQL(testInfra.adminDatabaseUrl, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.close();
  }
  await runMigrations({ url: dbUrl, poolMax: 2 }, 'up');
  sql = new SQL(dbUrl, { max: 4 });
  await ensureQueues(sqs, queueNames, { maxReceiveCount: SQS_MAX_RECEIVE_COUNT, visibilityTimeoutS: 30 });

  const vars = testEnvVars({
    databaseUrl: dbUrl,
    queues: queueNames,
    overrides: {
      NODE_ENV: 'production',
      DB_POOL_MAX: String(DB_POOL_MAX),
      RUN_CONSUMER: 'false',
      RUN_OUTBOX_PUBLISHER: 'true',
      RUN_PENDING_REFERENCE_WORKER: 'true',
      OUTBOX_POLL_INTERVAL_MS: '200',
      OUTBOX_BATCH_SIZE: '100',
      LOG_LEVEL: 'warn',
    },
  });
  instances = await Promise.all(
    Array.from({ length: INSTANCES }, () => spawnInstance(vars, { waitForReady: true, timeout: 30_000 })),
  );
}

async function tearDown(): Promise<void> {
  await Promise.all(instances.map((instance) => instance.stop('SIGTERM')));
  await sql?.close();
  const admin = new SQL(testInfra.adminDatabaseUrl, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await admin.close();
  }
  await deleteQueues(sqs, queueNames).catch(() => {});
  sqs.destroy();
}

// ------------------------------------------------------------------ HTTP

async function createWallet(initial: string): Promise<Wallet> {
  const playerId = Bun.randomUUIDv7();
  const res = await fetch(`${instances[0]!.baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: initial, currency: 'BRL' } }),
  });
  if (res.status !== 201) throw new Error(`POST /wallets → ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return { id: body.id, playerId };
}

function bet(wallet: Wallet, amount: string, instance: number): Request {
  const externalTransactionId = `load-${Bun.randomUUIDv7()}`;
  return {
    instance,
    key: `load-provider:${externalTransactionId}`,
    body: {
      providerId: 'load-provider',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${externalTransactionId.slice(-6)}`,
      gameId: 'load-game',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
  };
}

async function submit(request: Request): Promise<Sample> {
  const startedAt = performance.now();
  try {
    const res = await fetch(`${instances[request.instance % INSTANCES]!.baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': request.key },
      body: JSON.stringify(request.body),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; failureCode?: string; idempotentReplay?: boolean };
    return {
      status: res.status,
      ms: performance.now() - startedAt,
      replay: body.idempotentReplay === true,
      outcome: body.failureCode ?? body.status ?? 'ERROR',
    };
  } catch {
    return { status: 0, ms: performance.now() - startedAt, replay: false, outcome: 'NETWORK_ERROR' };
  }
}

/** Executa as requisições com no máximo `CONCURRENCY` em voo, na ordem dada. */
async function runPool(requests: readonly Request[]): Promise<{ samples: Sample[]; durationS: number }> {
  const samples: Sample[] = new Array(requests.length);
  let next = 0;
  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, requests.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= requests.length) return;
        samples[index] = await submit(requests[index]!);
      }
    }),
  );
  return { samples, durationS: (performance.now() - startedAt) / 1000 };
}

// ------------------------------------------------------------------ métricas

async function scrapeAll(): Promise<string[]> {
  return Promise.all(instances.map(async (instance) => (await fetch(`${instance.baseUrl}/metrics`)).text()));
}

function metricLines(exposition: string, name: string): Array<{ labels: string; value: number }> {
  const lines: Array<{ labels: string; value: number }> = [];
  for (const line of exposition.split('\n')) {
    const match = /^([a-zA-Z_:][\w:]*)(?:\{([^}]*)\})?\s+(\S+)$/.exec(line);
    if (match?.[1] === name) lines.push({ labels: match[2] ?? '', value: Number(match[3]) });
  }
  return lines;
}

function sum(expositions: readonly string[], name: string, filter = ''): number {
  return expositions
    .flatMap((exposition) => metricLines(exposition, name))
    .filter((line) => line.labels.includes(filter))
    .reduce((total, line) => total + line.value, 0);
}

async function snapshot(): Promise<MetricsSnapshot> {
  const all = await scrapeAll();
  const buckets = new Map<number, number>();
  for (const line of all.flatMap((exposition) => metricLines(exposition, 'wager_wallet_lock_wait_seconds_bucket'))) {
    if (!line.labels.includes('operation="submission"')) continue;
    const le = /le="([^"]+)"/.exec(line.labels)?.[1];
    const bound = le === '+Inf' ? Number.POSITIVE_INFINITY : Number(le);
    buckets.set(bound, (buckets.get(bound) ?? 0) + line.value);
  }
  return {
    lockTimeouts: sum(all, 'wager_lock_conflicts_total', 'type="lock_timeout"'),
    deadlocks: sum(all, 'wager_lock_conflicts_total', 'type="deadlock"'),
    lockWaitCount: sum(all, 'wager_wallet_lock_wait_seconds_count', 'operation="submission"'),
    lockWaitSum: sum(all, 'wager_wallet_lock_wait_seconds_sum', 'operation="submission"'),
    lockWaitBuckets: buckets,
  };
}

function diff(after: MetricsSnapshot, before: MetricsSnapshot): MetricsSnapshot {
  const buckets = new Map<number, number>();
  for (const [bound, value] of after.lockWaitBuckets) buckets.set(bound, value - (before.lockWaitBuckets.get(bound) ?? 0));
  return {
    lockTimeouts: after.lockTimeouts - before.lockTimeouts,
    deadlocks: after.deadlocks - before.deadlocks,
    lockWaitCount: after.lockWaitCount - before.lockWaitCount,
    lockWaitSum: after.lockWaitSum - before.lockWaitSum,
    lockWaitBuckets: buckets,
  };
}

/** Limite superior do bucket que contém o quantil (estimativa conservadora, como o Prometheus). */
function bucketQuantile(metrics: MetricsSnapshot, q: number): string {
  if (metrics.lockWaitCount === 0) return '—';
  const rank = q * metrics.lockWaitCount;
  for (const [bound, cumulative] of [...metrics.lockWaitBuckets].sort(([a], [b]) => a - b)) {
    if (cumulative >= rank) return bound === Number.POSITIVE_INFINITY ? '> 5 s' : `≤ ${formatMs(bound * 1000)}`;
  }
  return '—';
}

async function outboxLag(): Promise<number> {
  const exposition = await (await fetch(`${instances[0]!.baseUrl}/metrics`)).text();
  return metricLines(exposition, 'outbox_lag_seconds')[0]?.value ?? 0;
}

/** Amostra o lag da outbox enquanto `work` roda e mede quanto tempo leva para drenar depois. */
async function withLagSampling<T>(work: () => Promise<T>): Promise<{ result: T; lagPeakS: number; drainS: number }> {
  let peak = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      peak = Math.max(peak, await outboxLag().catch(() => 0));
      await Bun.sleep(250);
    }
  })();
  const result = await work();
  const finishedAt = performance.now();
  for (;;) {
    const [{ pending }] = await sql!`SELECT count(*)::int AS pending FROM outbox_messages WHERE published_at IS NULL`;
    peak = Math.max(peak, await outboxLag().catch(() => 0));
    if (pending === 0) break;
    if (performance.now() - finishedAt > 120_000) throw new Error('A outbox não drenou em 120 s');
    await Bun.sleep(100);
  }
  sampling = false;
  await sampler;
  return { result, lagPeakS: peak, drainS: (performance.now() - finishedAt) / 1000 };
}

// ------------------------------------------------------------------ cenários

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

async function scenario(
  name: string,
  description: string,
  build: () => Promise<Request[]>,
): Promise<ScenarioResult> {
  const requests = await build();
  const before = await snapshot();
  const { result, lagPeakS, drainS } = await withLagSampling(() => runPool(requests));
  const metrics = diff(await snapshot(), before);
  console.log(`  ${name}: ${requests.length} requisições em ${result.durationS.toFixed(2)} s`);
  return { name, description, requests: requests.length, durationS: result.durationS, samples: result.samples, metrics, lagPeakS, drainS };
}

const scenarios: Array<() => Promise<ScenarioResult>> = [
  () =>
    scenario('(a) hot wallet', `${HOT_REQUESTS} apostas de 0.01 numa única wallet, ${INSTANCES} instâncias`, async () => {
      const wallet = await createWallet('1000.00');
      return Array.from({ length: HOT_REQUESTS }, (_, i) => bet(wallet, '0.01', i));
    }),
  () =>
    scenario(
      '(b) espalhado',
      `${SPREAD_WALLETS} wallets × ${SPREAD_BETS} apostas de 1.00, ordem aleatória`,
      async () => {
        const wallets = await Promise.all(Array.from({ length: SPREAD_WALLETS }, () => createWallet('1000.00')));
        return shuffle(wallets.flatMap((wallet) => Array.from({ length: SPREAD_BETS }, (_, i) => bet(wallet, '1.00', i))));
      },
    ),
  () =>
    scenario('(c) 10% duplicatas', `${DUP_REQUESTS} requisições em 20 wallets; 10% reenviam uma anterior`, async () => {
      const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet('1000.00')));
      const unique = Array.from({ length: Math.round(DUP_REQUESTS * 0.9) }, (_, i) =>
        bet(wallets[i % wallets.length]!, '1.00', i),
      );
      // Cada duplicata vai para outra instância que não a do original, depois dele na fila.
      const requests = [...unique];
      for (let i = 0; i < DUP_REQUESTS - unique.length; i += 1) {
        const at = Math.floor(Math.random() * requests.length) + 1;
        const original = unique[Math.floor(Math.random() * Math.min(at, unique.length))]!;
        requests.splice(at, 0, { ...original, instance: original.instance + 1 });
      }
      return requests;
    }),
];

// ------------------------------------------------------------------ invariantes

async function checkInvariants(): Promise<{ wallets: number; divergent: number; inconsistent: number; negative: number }> {
  const divergent = await sql!`
    SELECT w.id FROM wallets w
      LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
     GROUP BY w.id, w.balance
    HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)`;
  const [{ negative }] = await sql!`SELECT count(*)::int AS negative FROM wallets WHERE balance < 0`;
  const wallets: Array<{ id: string }> = await sql!`SELECT id::text AS id FROM wallets`;
  let inconsistent = 0;
  for (const { id } of wallets) {
    const res = await fetch(`${instances[1 % INSTANCES]!.baseUrl}/wallets/${id}/reconciliation`, { method: 'POST' });
    const body = (await res.json()) as { consistent?: boolean };
    if (body.consistent !== true) inconsistent += 1;
  }
  return { wallets: wallets.length, divergent: divergent.length, inconsistent, negative };
}

// ------------------------------------------------------------------ relatório

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`).join(', ');
}

function row(result: ScenarioResult): Record<string, string> {
  const latencies = result.samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const errors = result.samples.filter((sample) => sample.status === 0 || sample.status >= 500).length;
  const { metrics } = result;
  return {
    Cenário: result.name,
    Requisições: String(result.requests),
    Duração: `${result.durationS.toFixed(2)} s`,
    Throughput: `${(result.requests / result.durationS).toFixed(1)} req/s`,
    p50: formatMs(percentile(latencies, 0.5)),
    p95: formatMs(percentile(latencies, 0.95)),
    p99: formatMs(percentile(latencies, 0.99)),
    'Taxa de erro (5xx/rede)': `${((errors / result.requests) * 100).toFixed(2)}%`,
    'Status HTTP': countBy(result.samples, (sample) => String(sample.status)),
    Resultado: countBy(result.samples, (sample) => sample.outcome),
    'Replays idempotentes': String(result.samples.filter((sample) => sample.replay).length),
    'Conflitos de lock (timeout/deadlock)': `${metrics.lockTimeouts} / ${metrics.deadlocks}`,
    'Espera do lock: média': metrics.lockWaitCount ? formatMs((metrics.lockWaitSum / metrics.lockWaitCount) * 1000) : '—',
    'Espera do lock: p95 (bucket)': bucketQuantile(metrics, 0.95),
    'Lag da outbox (pico)': `${result.lagPeakS.toFixed(2)} s`,
    'Tempo para drenar a outbox': formatMs(result.drainS * 1000),
  };
}

function table(results: readonly ScenarioResult[]): string {
  const rows = results.map(row);
  const keys = Object.keys(rows[0]!).filter((key) => key !== 'Cenário');
  const header = `| Métrica | ${rows.map((r) => r.Cenário).join(' | ')} |`;
  const divider = `|---|${rows.map(() => '---').join('|')}|`;
  const lines = keys.map((key) => `| ${key} | ${rows.map((r) => r[key]).join(' | ')} |`);
  return [header, divider, ...lines].join('\n');
}

async function environment(): Promise<string> {
  const [{ version }] = await sql!`SELECT version() AS version`;
  const ministack = await fetch(`${testInfra.sqsEndpoint}/_ministack/health`)
    .then(async (res) => ((await res.json()) as { version?: string }).version ?? 'desconhecida')
    .catch(() => 'desconhecida');
  const cpu = cpus();
  return [
    `- **Data:** ${new Date().toISOString()}`,
    `- **CPU:** ${cpu[0]?.model ?? 'desconhecida'} × ${cpu.length} núcleos; memória ${(totalmem() / 2 ** 30).toFixed(1)} GiB`,
    `- **Bun:** ${Bun.version}; **PostgreSQL:** ${String(version).split(' on ')[0]}; **MiniStack:** ${ministack}`,
    `- **Instâncias:** ${INSTANCES} processos (HTTP + publisher da outbox + worker), pool de ${DB_POOL_MAX} conexões cada`,
    `- **Concorrência do cliente:** ${CONCURRENCY} requisições em voo, distribuídas em rodízio entre as instâncias`,
    '- Cliente, aplicação, Postgres e MiniStack na mesma máquina (o cliente disputa CPU com o servidor).',
  ].join('\n');
}

function analysis(results: readonly ScenarioResult[]): string {
  const [hot, spread, dups] = results;
  const rate = (result?: ScenarioResult) => (result ? result.requests / result.durationS : 0);
  const hotWait = hot && hot.metrics.lockWaitCount ? (hot.metrics.lockWaitSum / hot.metrics.lockWaitCount) * 1000 : 0;
  const spreadWait =
    spread && spread.metrics.lockWaitCount ? (spread.metrics.lockWaitSum / spread.metrics.lockWaitCount) * 1000 : 0;
  return [
    `A hot wallet fez ${rate(hot).toFixed(1)} req/s, contra ${rate(spread).toFixed(1)} req/s com as apostas espalhadas em ` +
      `${SPREAD_WALLETS} wallets. A diferença é esperada e é escolha de desenho (ARCHITECTURE.md, D-04): toda transação ` +
      'que move saldo começa com `SELECT … FOR UPDATE` na linha da wallet, então as apostas da mesma wallet são ' +
      'serializadas e o throughput dela é limitado pelo tempo de uma transação, não pelo número de instâncias. ' +
      `O histograma de espera mostra isso: média de ${formatMs(hotWait)} de espera pelo lock na hot wallet contra ` +
      `${formatMs(spreadWait)} no cenário espalhado. Os contadores de conflito ficam em zero porque, com lock ` +
      'pessimista, a disputa aparece como espera e não como timeout ou deadlock.',
    '',
    `Com wallets diferentes as transações andam em paralelo, e o limite passa a ser a máquina: aqui cliente, três ` +
      'instâncias, Postgres e MiniStack dividem a mesma CPU, então os números servem para comparar cenários, não ' +
      'como capacidade de produção. ' +
      (dups
        ? `No cenário de duplicatas, ${dups.samples.filter((sample) => sample.replay).length} reenvios voltaram como ` +
          'replay (mesmo resultado, sem segundo débito), atendidos pela mesma transação curta do caminho normal.'
        : ''),
    '',
    'A outbox é publicada por três publishers concorrentes (lease + `SKIP LOCKED`); o lag sobe durante a rajada e ' +
      'volta a zero logo depois dela, no tempo de drenagem da tabela.',
  ].join('\n');
}

// ------------------------------------------------------------------ main

let exitCode = 0;
try {
  console.log(`Subindo ${INSTANCES} instâncias…`);
  await setUp();
  const results: ScenarioResult[] = [];
  for (const run of scenarios) results.push(await run());

  const invariants = await checkInvariants();
  const ok = invariants.divergent === 0 && invariants.inconsistent === 0 && invariants.negative === 0;
  if (!ok) exitCode = 1;

  const report = [
    '# Relatório do teste de carga',
    '',
    'Gerado por `bun run test:load` (`scripts/load-test.ts`).',
    '',
    '## Ambiente',
    '',
    await environment(),
    '',
    '## Metodologia',
    '',
    '- Banco e filas exclusivos, criados na infraestrutura de teste (`bun run infra:test:up`), com todas as migrations.',
    `- ${INSTANCES} instâncias reais em processos separados (\`bun src/main.ts\`), todas sobre o mesmo Postgres e MiniStack.`,
    `- Cada cenário roda com um pool de ${CONCURRENCY} requisições em voo; cada requisição é um \`POST /wagering/transactions\` com \`Idempotency-Key\`.`,
    '- Latência medida no cliente, da requisição à resposta completa. Erro = 5xx ou falha de rede.',
    '- Conflitos de lock e espera do lock vêm de `/metrics` das três instâncias (diferença antes/depois do cenário).',
    '- O lag da outbox é amostrado a cada 250 ms durante o cenário; o tempo de drenagem conta do fim das requisições até não haver evento não publicado.',
    '- No fim: saldo = ledger para todas as wallets (no banco) e `POST /wallets/:id/reconciliation` para cada uma.',
    '',
    ...results.map((result) => `- **${result.name}:** ${result.description}.`),
    '',
    '## Resultados',
    '',
    table(results),
    '',
    '## Invariantes no fim',
    '',
    `- Wallets conferidas: ${invariants.wallets}`,
    `- Saldo ≠ ledger: ${invariants.divergent}`,
    `- Reconciliação inconsistente: ${invariants.inconsistent}`,
    `- Saldo negativo: ${invariants.negative}`,
    `- **${ok ? 'OK' : 'FALHOU'}**`,
    '',
    '## Análise',
    '',
    analysis(results),
    '',
  ].join('\n');

  await Bun.write(REPORT_PATH, report);
  console.log(`\n${table(results)}\n`);
  console.log(`Invariantes: ${ok ? 'OK' : 'FALHOU'} (${JSON.stringify(invariants)})`);
  console.log(`Relatório gravado em ${REPORT_PATH}`);
} catch (error) {
  exitCode = 1;
  console.error('Teste de carga falhou:', error);
  for (const instance of instances) console.error(instance.output().slice(-3000));
} finally {
  await tearDown().catch((error: unknown) => console.error('Falha ao limpar:', error));
}
process.exit(exitCode);
