import { resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { eventually } from './eventually';

const PROJECT_ROOT = resolve(import.meta.dir, '../..');

export interface SpawnedInstance {
  readonly port: number;
  readonly baseUrl: string;
  readonly process: Subprocess;
  /** Saída combinada do processo, para diagnosticar falhas no teste. */
  output(): string;
  /** SIGTERM por padrão; aguarda o processo terminar e devolve o exit code. */
  stop(signal?: NodeJS.Signals): Promise<number | null>;
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error('Não foi possível reservar uma porta livre');
  return port;
}

/** Sobe uma instância real da aplicação (processo separado) e espera o /health/live. */
export async function spawnInstance(
  env: Record<string, string>,
  options: { waitForReady?: boolean; timeout?: number } = {},
): Promise<SpawnedInstance> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';

  const child = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: PROJECT_ROOT,
    // Env explícito e completo: nada do .env local vaza para a instância de teste.
    env: { PATH: process.env.PATH ?? '', ...env, PORT: String(port) },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  };
  void collect(child.stdout);
  void collect(child.stderr);

  const path = options.waitForReady ? '/health/ready' : '/health/live';
  try {
    await eventually(
      async () => {
        if (child.exitCode !== null) {
          throw new Error(`instância saiu com código ${child.exitCode}`);
        }
        const res = await fetch(`${baseUrl}${path}`);
        if (res.status !== 200) throw new Error(`${path} respondeu ${res.status}`);
      },
      { timeout: options.timeout ?? 20_000, interval: 100 },
    );
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`Instância não subiu: ${(error as Error).message}\n${output}`);
  }

  return {
    port,
    baseUrl,
    process: child,
    output: () => output,
    async stop(signal = 'SIGTERM') {
      if (child.exitCode === null) child.kill(signal);
      return child.exited;
    },
  };
}
