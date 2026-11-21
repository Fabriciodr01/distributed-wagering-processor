export interface ReferenceRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Avaliações no total, contando a da submissão. Esgotadas, a transação expira. */
  readonly maxAttempts: number;
}

/**
 * Atraso até a próxima avaliação depois da avaliação de número `attempt` (a submissão é a 1ª):
 * `min(base * 2^(attempt - 1), max)`. Com 5 s e 300 s: 5, 10, 20, 40, 80, 160, 300, 300...
 */
export function referenceRetryDelayMs(attempt: number, policy: ReferenceRetryPolicy): number {
  return Math.min(policy.baseDelayMs * 2 ** Math.max(attempt - 1, 0), policy.maxDelayMs);
}
