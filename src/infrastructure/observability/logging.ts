import type { Params } from 'nestjs-pino';
import type { AppConfig } from '../../config/app-config';
import { correlationIdOf } from './correlation.middleware';
import { currentLogContext } from './log-context';

/**
 * Campos que nunca podem aparecer nos logs: valores financeiros e payloads completos.
 * O código não loga esses campos; a redação é a rede de proteção se alguém logar por engano.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body',
  'res.body',
  '*.amount',
  '*.money',
  '*.balance',
  '*.balanceBefore',
  '*.balanceAfter',
  '*.initialBalance',
  '*.payload',
  'amount',
  'money',
  'balance',
  'payload',
];

/**
 * O nestjs-pino mantém um único logger por processo; cada instância da aplicação roda no
 * próprio processo, então isso nunca é compartilhado entre instâncias.
 */
export function loggerParams(config: AppConfig): Params {
  const options = {
    level: config.logLevel,
    base: { service: 'distributed-wagering-processor' },
    // Ids do fluxo corrente (requisição, mensagem, item de worker) em toda linha.
    mixin: () => ({ ...currentLogContext() }),
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    genReqId: correlationIdOf,
    serializers: {
      req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
    autoLogging: { ignore: (req: { url?: string }) => req.url === '/metrics' || req.url?.startsWith('/health') === true },
  };
  return { pinoHttp: options };
}
