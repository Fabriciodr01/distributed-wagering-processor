import { AsyncLocalStorage } from 'node:async_hooks';

/** Ids de rastreio anexados a toda linha de log emitida dentro do mesmo fluxo assíncrono. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Executa `work` com um contexto de log novo (uma requisição, uma mensagem, um item de worker). */
export function runWithLogContext<T>(context: LogContext, work: () => T): T {
  return storage.run({ ...context }, work);
}

/** Acrescenta ids ao contexto corrente (ex.: o transactionId só existe depois do caso de uso). */
export function addLogContext(fields: LogContext): void {
  const current = storage.getStore();
  if (current) Object.assign(current, fields);
}

export function currentLogContext(): Readonly<LogContext> {
  return storage.getStore() ?? {};
}
