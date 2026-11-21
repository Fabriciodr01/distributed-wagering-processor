export interface EventuallyOptions {
  readonly timeout?: number;
  readonly interval?: number;
}

/**
 * Repete `fn` até ela parar de lançar (ou o tempo acabar) e devolve o último resultado.
 * Substitui `sleep` nos testes: espera por uma condição, não por um tempo fixo.
 */
export async function eventually<T>(
  fn: () => T | Promise<T>,
  { timeout = 10_000, interval = 50 }: EventuallyOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`eventually: condição não satisfeita em ${timeout} ms. Último erro: ${reason}`, {
        cause: lastError,
      });
    }
    await Bun.sleep(interval);
  }
}
