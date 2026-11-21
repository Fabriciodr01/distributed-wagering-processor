import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import { ID_GENERATOR, type IdGenerator } from '../../../application/ports/id-generator.port';
import type { ProviderIdentity } from '../../../application/ports/provider-identity.port';
import { GetWagerTransactionUseCase } from '../../../application/wagering/get-wager-transaction.usecase';
import { ProcessWagerTransactionUseCase } from '../../../application/wagering/process-wager-transaction.usecase';
import { assertCanActAs, CurrentProvider, ProviderAuthGuard } from '../auth/provider-auth.guard';
import { RequestValidationError } from '../errors/request-validation.error';
import { uuidSchema } from '../validation/common.schemas';
import { ZodValidationPipe } from '../validation/zod-validation.pipe';
import {
  presentSubmission,
  presentTransaction,
  type SubmissionResponse,
  submissionStatus,
  type TransactionResponse,
} from './wager-transaction.presenter';
import {
  correlationIdSchema,
  idempotencyKeySchema,
  type WagerTransactionPayload,
  wagerTransactionPayloadSchema,
} from './wagering.schemas';

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    private readonly getTransaction: GetWagerTransactionUseCase,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Headers('x-correlation-id') correlationId: unknown,
    @Body(new ZodValidationPipe(wagerTransactionPayloadSchema)) body: WagerTransactionPayload,
    @CurrentProvider() identity: ProviderIdentity,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmissionResponse> {
    assertCanActAs(identity, body.providerId);
    const result = await this.processTransaction.execute({
      ...body,
      idempotencyKey: header('Idempotency-Key', idempotencyKeySchema, idempotencyKey),
      correlationId: correlationIdSchema.safeParse(correlationId).data ?? this.ids.next(),
    });
    response.status(submissionStatus(result.status));
    return presentSubmission(result);
  }

  @Get('wagering/transactions/:transactionId')
  async findById(
    @Param('transactionId', new ZodValidationPipe(uuidSchema)) transactionId: string,
  ): Promise<TransactionResponse> {
    return presentTransaction(await this.getTransaction.byId(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @CurrentProvider() identity: ProviderIdentity,
  ): Promise<TransactionResponse> {
    assertCanActAs(identity, providerId);
    return presentTransaction(await this.getTransaction.byExternalId(providerId, externalTransactionId));
  }
}

function header<S extends z.ZodType>(name: string, schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RequestValidationError([{ field: name, message: 'header obrigatório, de 1 a 255 caracteres' }]);
  }
  return parsed.data;
}
