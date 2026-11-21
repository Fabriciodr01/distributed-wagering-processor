import { Body, Controller, Get, Headers, Inject, Logger, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import { ID_GENERATOR, type IdGenerator } from '../../../application/ports/id-generator.port';
import type { ProviderIdentity } from '../../../application/ports/provider-identity.port';
import { GetWagerTransactionUseCase } from '../../../application/wagering/get-wager-transaction.usecase';
import { ProcessWagerTransactionUseCase } from '../../../application/wagering/process-wager-transaction.usecase';
import { assertCanActAs, CurrentProvider, ProviderAuthGuard } from '../auth/provider-auth.guard';
import { RequestValidationError } from '../errors/request-validation.error';
import { uuidSchema } from '../../contracts/common.schemas';
import { addLogContext, currentLogContext } from '../../observability/log-context';
import { ZodValidationPipe } from '../validation/zod-validation.pipe';
import {
  presentSubmission,
  presentTransaction,
  type SubmissionResponse,
  submissionStatus,
  type TransactionResponse,
} from './wager-transaction.presenter';
import {
  idempotencyKeySchema,
  type WagerTransactionPayload,
  wagerTransactionPayloadSchema,
} from '../../contracts/wager-transaction.contract';

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  private readonly logger = new Logger(WageringController.name);

  constructor(
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    private readonly getTransaction: GetWagerTransactionUseCase,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body(new ZodValidationPipe(wagerTransactionPayloadSchema)) body: WagerTransactionPayload,
    @CurrentProvider() identity: ProviderIdentity,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmissionResponse> {
    assertCanActAs(identity, body.providerId);
    addLogContext({ walletId: body.walletId, providerId: body.providerId });
    const result = await this.processTransaction.execute({
      ...body,
      idempotencyKey: header('Idempotency-Key', idempotencyKeySchema, idempotencyKey),
      // Definido pelo middleware de correlação (X-Correlation-Id recebido ou gerado).
      correlationId: currentLogContext().correlationId ?? this.ids.next(),
    });
    addLogContext({ transactionId: result.transactionId });
    this.logger.log(
      { kind: body.kind, status: result.status, failureCode: result.failureCode, idempotentReplay: result.idempotentReplay },
      'Transação recebida pela API',
    );
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
