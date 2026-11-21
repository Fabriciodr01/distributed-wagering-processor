import { type TransientFailureKind } from '../../application/errors';

interface DatabaseErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly cause?: unknown;
}

// Erros de socket do driver: o Postgres não está acessível.
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

/** SQLSTATE do Postgres (ou código de rede) do erro, procurando também nas causas. */
export function databaseErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const { code, cause } = current as DatabaseErrorShape;
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}

export function violatedConstraint(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const { constraint, cause } = current as DatabaseErrorShape;
    if (typeof constraint === 'string') return constraint;
    current = cause;
  }
  return undefined;
}

/** Falhas que podem dar certo se a operação for repetida. Qualquer outra é permanente. */
export function classifyTransient(error: unknown): TransientFailureKind | undefined {
  const code = databaseErrorCode(error);
  if (code === undefined) {
    return error instanceof Error && /connect|connection terminated|timeout/i.test(error.message)
      ? 'unavailable'
      : undefined;
  }
  if (code === '55P03') return 'lock_timeout';
  if (code === '40P01' || code === '40001') return 'deadlock';
  if (
    NETWORK_CODES.has(code) ||
    code.startsWith('08') || // connection exception
    code === '57P01' || // admin_shutdown
    code === '57P02' || // crash_shutdown
    code === '57P03' || // cannot_connect_now
    code === '53300' // too_many_connections
  ) {
    return 'unavailable';
  }
  return undefined;
}
