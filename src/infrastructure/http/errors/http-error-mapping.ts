import { HttpException, HttpStatus } from '@nestjs/common';
import {
  InvalidCursorError,
  TransientFailureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../application/errors';
import { ApiErrorCode, type ApiErrorBody } from './api-error-code';
import { RequestValidationError } from './request-validation.error';

export interface HttpError {
  readonly status: number;
  readonly body: ApiErrorBody;
  readonly headers?: Readonly<Record<string, string>>;
  /** true quando o erro não era esperado e precisa ser investigado. */
  readonly unexpected: boolean;
}

const error = (status: number, code: ApiErrorCode, message: string, details?: ApiErrorBody['error']['details']) => ({
  status,
  body: { error: details ? { code, message, details } : { code, message } },
  unexpected: false,
});

// Erros do próprio Nest/Express antes de chegar ao controller (rota inexistente, JSON malformado).
const FRAMEWORK_CODES: Readonly<Record<number, ApiErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ApiErrorCode.ValidationError,
  [HttpStatus.NOT_FOUND]: ApiErrorCode.NotFound,
};

/** Mapeamento único de erro para HTTP, igual em todos os endpoints. */
export function toHttpError(exception: unknown): HttpError {
  if (exception instanceof RequestValidationError) {
    return error(HttpStatus.BAD_REQUEST, ApiErrorCode.ValidationError, exception.message, exception.details);
  }
  if (exception instanceof InvalidCursorError) {
    return error(HttpStatus.BAD_REQUEST, ApiErrorCode.ValidationError, exception.message, [
      { field: 'cursor', message: exception.message },
    ]);
  }
  if (exception instanceof WalletNotFoundError) {
    return error(HttpStatus.NOT_FOUND, ApiErrorCode.WalletNotFound, exception.message);
  }
  if (exception instanceof WalletAlreadyExistsError) {
    return error(HttpStatus.CONFLICT, ApiErrorCode.WalletAlreadyExists, exception.message);
  }
  if (exception instanceof TransientFailureError) {
    return {
      ...error(HttpStatus.SERVICE_UNAVAILABLE, ApiErrorCode.ServiceUnavailable, 'Serviço temporariamente indisponível; reenvie com a mesma Idempotency-Key'),
      headers: { 'Retry-After': '1' },
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = FRAMEWORK_CODES[status];
    if (code) {
      const message = status === HttpStatus.BAD_REQUEST ? 'Corpo da requisição inválido' : 'Recurso não encontrado';
      return error(status, code, message);
    }
  }
  return {
    ...error(HttpStatus.INTERNAL_SERVER_ERROR, ApiErrorCode.InternalError, 'Erro interno inesperado'),
    unexpected: true,
  };
}
