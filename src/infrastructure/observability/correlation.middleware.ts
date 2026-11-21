import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithLogContext } from './log-context';

export const CORRELATION_HEADER = 'x-correlation-id';
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Usa o X-Correlation-Id recebido (se válido) ou gera um, e devolve no response. */
type WithCorrelation = IncomingMessage & { correlationId?: string };

// Guardado na requisição: o logger HTTP e o middleware chegam ao mesmo id, em qualquer ordem.
export function correlationIdOf(request: IncomingMessage): string {
  const cached = (request as WithCorrelation).correlationId;
  if (cached) return cached;
  const header = request.headers[CORRELATION_HEADER];
  const value = typeof header === 'string' && VALID_CORRELATION_ID.test(header) ? header : randomUUID();
  (request as WithCorrelation).correlationId = value;
  return value;
}

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const correlationId = correlationIdOf(request);
    response.setHeader('X-Correlation-Id', correlationId);
    runWithLogContext({ correlationId }, next);
  }
}
