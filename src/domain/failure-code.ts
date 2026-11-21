/**
 * Códigos estáveis e legíveis por máquina. São contrato público: nunca renomear.
 * Cada código diz ao provedor se ele deve reenviar, corrigir o payload ou desistir.
 */
export enum FailureCode {
  // Rejeições por regra de negócio (status REJECTED).
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFoundExpired = 'REFERENCE_NOT_FOUND_EXPIRED',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',

  // Falhas permanentes de processamento (status FAILED).
  ProcessingRetriesExhausted = 'PROCESSING_RETRIES_EXHAUSTED',
  PermanentProcessingError = 'PERMANENT_PROCESSING_ERROR',
}

const PROCESSING_FAILURES: ReadonlySet<FailureCode> = new Set([
  FailureCode.ProcessingRetriesExhausted,
  FailureCode.PermanentProcessingError,
]);

/** Código aceito por `reject()`: violação de regra de negócio. */
export function isRejectionCode(code: FailureCode): boolean {
  return !PROCESSING_FAILURES.has(code);
}

/** Código aceito por `fail()`: erro permanente de processamento. */
export function isProcessingFailureCode(code: FailureCode): boolean {
  return PROCESSING_FAILURES.has(code);
}
