import type { ApiErrorDetail } from './api-error-code';

/** Payload, header, parâmetro ou query fora do contrato. Vira 400 VALIDATION_ERROR. */
export class RequestValidationError extends Error {
  constructor(readonly details: readonly ApiErrorDetail[]) {
    super('Requisição inválida');
    this.name = 'RequestValidationError';
  }
}
