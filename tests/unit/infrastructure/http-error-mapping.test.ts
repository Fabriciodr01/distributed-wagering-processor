import { describe, expect, test } from 'bun:test';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
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
} from '../../../src/application/errors';
import { InvalidTransactionStateError } from '../../../src/domain/errors';
import { toHttpError } from '../../../src/infrastructure/http/errors/http-error-mapping';
import { RequestValidationError } from '../../../src/infrastructure/http/errors/request-validation.error';

describe('mapeamento de erros para HTTP', () => {
  test.each([
    ['validação', new RequestValidationError([{ field: 'a', message: 'b' }]), 400, 'VALIDATION_ERROR'],
    ['cursor', new InvalidCursorError(), 400, 'VALIDATION_ERROR'],
    ['wallet inexistente', new WalletNotFoundError('w'), 404, 'WALLET_NOT_FOUND'],
    ['wallet duplicada', new WalletAlreadyExistsError('p', 'BRL'), 409, 'WALLET_ALREADY_EXISTS'],
    ['falha transitória', new TransientFailureError('lock_timeout'), 503, 'SERVICE_UNAVAILABLE'],
    ['rota inexistente', new NotFoundException(), 404, 'NOT_FOUND'],
    ['requisição de transação inválida', new InvalidWagerRequestError('x'), 400, 'VALIDATION_ERROR'],
    ['transação inexistente', new TransactionNotFoundError(), 404, 'TRANSACTION_NOT_FOUND'],
    ['chave com outro payload', new IdempotencyKeyConflictError('p', 't'), 409, 'IDEMPOTENCY_KEY_CONFLICT'],
    ['externalId com outro payload', new ExternalTransactionConflictError('p', 't'), 409, 'EXTERNAL_TRANSACTION_CONFLICT'],
    ['provider não autorizado', new ProviderNotAllowedError('p'), 403, 'PROVIDER_NOT_ALLOWED'],
    ['sem credencial', new UnauthorizedException(), 401, 'UNAUTHORIZED'],
  ])('%s → %p %s', (_, exception, status, code) => {
    const mapped = toHttpError(exception);
    expect(mapped.status).toBe(status);
    expect(mapped.body.error.code).toBe(code);
    expect(mapped.unexpected).toBe(false);
  });

  test('503 indica quando reenviar', () => {
    expect(toHttpError(new TransientFailureError('unavailable')).headers).toEqual({ 'Retry-After': '1' });
  });

  test('erro de validação leva os detalhes por campo', () => {
    const mapped = toHttpError(new RequestValidationError([{ field: 'playerId', message: 'precisa ser um UUID' }]));
    expect(mapped.body.error.details).toEqual([{ field: 'playerId', message: 'precisa ser um UUID' }]);
  });

  test('erro de domínio que escapa é bug: 500 sem vazar a mensagem interna', () => {
    const mapped = toHttpError(new InvalidTransactionStateError('tx', 'PROCESSED', 'REJECTED'));
    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno inesperado' } });
    expect(mapped.unexpected).toBe(true);
  });
});
