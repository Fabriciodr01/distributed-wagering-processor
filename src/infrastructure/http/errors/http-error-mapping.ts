import { HttpException, HttpStatus } from '@nestjs/common';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  InvalidCursorError,
  InvalidWagerRequestError,
  ProviderNotAllowedError,
  TransactionNotFoundError,
  TransientFailureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../application/errors';
import { type ApiErrorBody, ApiErrorCode, type ApiErrorDetail } from './api-error-code';
import { RequestValidationError } from './request-validation.error';

export interface HttpError {
  readonly status: number;
  readonly body: ApiErrorBody;
  readonly headers?: Readonly<Record<string, string>>;
  /** true quando o erro não era esperado e precisa ser investigado. */
  readonly unexpected: boolean;
}

type ErrorClass = abstract new (...args: never[]) => Error;

interface Mapping {
  readonly type: ErrorClass;
  readonly status: HttpStatus;
  readonly code: ApiErrorCode;
  readonly details?: (error: Error) => readonly ApiErrorDetail[];
}

/**
 * Mapeamento único de erro para HTTP, igual em todos os endpoints. O status já diz
 * ao provedor o que fazer: 400/409 corrigir, 404 conferir o id, 503 reenviar igual.
 */
const MAPPINGS: readonly Mapping[] = [
  {
    type: RequestValidationError,
    status: HttpStatus.BAD_REQUEST,
    code: ApiErrorCode.ValidationError,
    details: (error) => (error as RequestValidationError).details,
  },
  {
    type: InvalidWagerRequestError,
    status: HttpStatus.BAD_REQUEST,
    code: ApiErrorCode.ValidationError,
    details: (error) => [{ field: '(corpo)', message: error.message }],
  },
  {
    type: InvalidCursorError,
    status: HttpStatus.BAD_REQUEST,
    code: ApiErrorCode.ValidationError,
    details: (error) => [{ field: 'cursor', message: error.message }],
  },
  { type: WalletNotFoundError, status: HttpStatus.NOT_FOUND, code: ApiErrorCode.WalletNotFound },
  { type: TransactionNotFoundError, status: HttpStatus.NOT_FOUND, code: ApiErrorCode.TransactionNotFound },
  { type: WalletAlreadyExistsError, status: HttpStatus.CONFLICT, code: ApiErrorCode.WalletAlreadyExists },
  { type: IdempotencyKeyConflictError, status: HttpStatus.CONFLICT, code: ApiErrorCode.IdempotencyKeyConflict },
  {
    type: ExternalTransactionConflictError,
    status: HttpStatus.CONFLICT,
    code: ApiErrorCode.ExternalTransactionConflict,
  },
  { type: ProviderNotAllowedError, status: HttpStatus.FORBIDDEN, code: ApiErrorCode.ProviderNotAllowed },
];

// Erros do próprio Nest/Express antes de chegar ao controller (rota inexistente, JSON malformado).
const FRAMEWORK_ERRORS: Readonly<Partial<Record<number, { code: ApiErrorCode; message: string }>>> = {
  [HttpStatus.BAD_REQUEST]: { code: ApiErrorCode.ValidationError, message: 'Corpo da requisição inválido' },
  [HttpStatus.UNAUTHORIZED]: { code: ApiErrorCode.Unauthorized, message: 'Credenciais ausentes ou inválidas' },
  [HttpStatus.NOT_FOUND]: { code: ApiErrorCode.NotFound, message: 'Recurso não encontrado' },
};

function body(code: ApiErrorCode, message: string, details?: readonly ApiErrorDetail[]): ApiErrorBody {
  return { error: details ? { code, message, details } : { code, message } };
}

export function toHttpError(exception: unknown): HttpError {
  if (exception instanceof Error) {
    const mapping = MAPPINGS.find(({ type }) => exception instanceof type);
    if (mapping) {
      return {
        status: mapping.status,
        body: body(mapping.code, exception.message, mapping.details?.(exception)),
        unexpected: false,
      };
    }
  }
  if (exception instanceof TransientFailureError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: body(
        ApiErrorCode.ServiceUnavailable,
        'Serviço temporariamente indisponível; reenvie com a mesma Idempotency-Key',
      ),
      headers: { 'Retry-After': '1' },
      unexpected: false,
    };
  }
  if (exception instanceof HttpException) {
    const known = FRAMEWORK_ERRORS[exception.getStatus()];
    if (known) return { status: exception.getStatus(), body: body(known.code, known.message), unexpected: false };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: body(ApiErrorCode.InternalError, 'Erro interno inesperado'),
    unexpected: true,
  };
}
