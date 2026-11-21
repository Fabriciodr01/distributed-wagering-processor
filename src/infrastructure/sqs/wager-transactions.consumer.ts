import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  InboxMessageConflictError,
  InvalidWagerRequestError,
  TransientFailureError,
  WalletNotFoundError,
} from '../../application/errors';
import { TELEMETRY, type Telemetry } from '../../application/ports/telemetry.port';
import { ProcessWagerTransactionUseCase } from '../../application/wagering/process-wager-transaction.usecase';
import type { ProcessWagerTransactionCommand } from '../../application/wagering/wager-transaction-command';
import type { AppConfig } from '../../config/app-config';
import { APP_CONFIG } from '../../config/config.module';
import { FailureCode } from '../../domain/failure-code';
import { type WagerTransactionMessage, wagerTransactionMessageSchema } from '../contracts/wager-transaction.contract';
import { addLogContext, runWithLogContext } from '../observability/log-context';
import { resolveQueueUrl } from './queue-setup';
import { SQS_CLIENT } from './sqs.tokens';

const MAX_RETRY_DELAY_S = 60;
const ERROR_PAUSE_MS = 1000;

/** Erros que nunca vão dar certo com a mesma mensagem: vão direto para a DLQ. */
const PERMANENT_ERRORS = [
  InvalidWagerRequestError,
  WalletNotFoundError,
  IdempotencyKeyConflictError,
  ExternalTransactionConflictError,
  InboxMessageConflictError,
];

export type DeadLetterReason = 'invalid_message' | 'rejected_request' | 'retries_exhausted';

type ParsedMessage = { ok: true; message: WagerTransactionMessage } | { ok: false; reason: string };

/**
 * Consumidor de `wager-transactions.fifo`. Usa o mesmo caso de uso da API e só apaga a
 * mensagem (ack) depois do commit. Classificação:
 * - negócio (REJECTED) e PENDING_REFERENCE: resultado válido commitado → ack;
 * - permanente (mensagem inválida, wallet inexistente, conflito): DLQ explícita;
 * - transitório: volta para a fila com backoff; no limite do app, FAILED auditável + DLQ.
 */
@Injectable()
export class WagerTransactionsConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WagerTransactionsConsumer.name);
  private running?: Promise<void>;
  private stopping = false;
  private queueUrls?: { transactions: string; dlq: string };

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly useCase: ProcessWagerTransactionUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TELEMETRY) private readonly telemetry: Telemetry,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.roles.consumer) this.start();
  }

  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = this.run();
  }

  /**
   * Para de buscar, conclui a mensagem em andamento e devolve à fila (visibilidade 0) as
   * que já tinham sido recebidas mas não começaram.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.running;
    this.running = undefined;
  }

  /** Um ciclo de long polling; devolve quantas mensagens recebeu. */
  async pollOnce(): Promise<number> {
    const { transactions } = await this.urls();
    const { Messages: messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: transactions,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.config.consumer.waitTimeS,
        VisibilityTimeout: this.config.consumer.visibilityTimeoutS,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    // Em ordem: no FIFO, mensagens do mesmo grupo (wallet) chegam na sequência de envio.
    for (const [index, message] of messages.entries()) {
      if (this.stopping) {
        await this.release(messages.slice(index));
        break;
      }
      // O messageId é o correlationId de tudo o que a mensagem gerar.
      await runWithLogContext({ messageId: message.MessageId, correlationId: message.MessageId }, () =>
        this.handle(message),
      );
    }
    return messages.length;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.logger.warn(`Ciclo do consumidor falhou: ${describe(error)}`);
        if (!this.stopping) await sleep(ERROR_PAUSE_MS);
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    const parsed = parse(message.Body);
    if (!parsed.ok) {
      await this.deadLetter(message, 'invalid_message', parsed.reason);
      return;
    }

    const command = toCommand(parsed.message);
    addLogContext({
      messageId: parsed.message.messageId,
      correlationId: parsed.message.messageId,
      walletId: command.walletId,
      providerId: command.providerId,
    });
    try {
      const outcome = await this.useCase.executeFromQueue(command, {
        consumerName: this.config.consumer.name,
        messageId: parsed.message.messageId,
      });
      if (outcome.kind === 'applied') {
        addLogContext({ transactionId: outcome.result.transactionId });
        this.logger.log(
          { kind: command.kind, status: outcome.result.status, failureCode: outcome.result.failureCode },
          'Mensagem processada',
        );
      } else {
        this.logger.log('Mensagem já processada antes (redelivery); só confirmada');
      }
    } catch (error) {
      await this.handleFailure(message, command, error);
      return;
    }

    if (this.config.faults.killAfterCommit) {
      // Gancho de teste: morre entre o commit e o ack, para provar que a redelivery não duplica.
      process.kill(process.pid, 'SIGKILL');
    }
    await this.ack(message);
  }

  private async handleFailure(message: Message, command: ProcessWagerTransactionCommand, error: unknown) {
    if (PERMANENT_ERRORS.some((type) => error instanceof type)) {
      await this.deadLetter(message, 'rejected_request', describe(error));
      return;
    }

    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    if (receiveCount < this.config.consumer.maxAttempts) {
      this.logger.warn({ receiveCount, error: describe(error) }, 'Mensagem volta para a fila');
      await this.retryLater(message, receiveCount);
      return;
    }

    // Erro inesperado repetido até o limite é tratado como permanente de processamento.
    const code =
      error instanceof TransientFailureError
        ? FailureCode.ProcessingRetriesExhausted
        : FailureCode.PermanentProcessingError;
    await this.useCase.recordFailedSubmission(command, code).catch((recordError: unknown) => {
      this.logger.error(`Não foi possível registrar FAILED da mensagem ${message.MessageId}: ${describe(recordError)}`);
    });
    await this.deadLetter(message, 'retries_exhausted', describe(error));
  }

  private async retryLater(message: Message, receiveCount: number): Promise<void> {
    const delay = Math.min(this.config.consumer.retryBaseS * 2 ** (receiveCount - 1), MAX_RETRY_DELAY_S);
    await this.changeVisibility(message, delay);
    this.telemetry.retryScheduled('consumer');
  }

  private async release(messages: readonly Message[]): Promise<void> {
    for (const message of messages) await this.changeVisibility(message, 0);
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    const { transactions } = await this.urls();
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: transactions,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  private async ack(message: Message): Promise<void> {
    const { transactions } = await this.urls();
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: transactions, ReceiptHandle: message.ReceiptHandle }));
  }

  /**
   * DLQ explícita: não vale a pena esperar o redrive (vários ciclos de visibilidade) por uma
   * mensagem que nunca vai funcionar. Envia antes de apagar: se o envio falhar, a mensagem
   * continua na fila e é tentada de novo.
   */
  private async deadLetter(message: Message, reason: DeadLetterReason, detail: string): Promise<void> {
    const { dlq } = await this.urls();
    this.logger.error({ reason, detail }, 'Mensagem enviada à DLQ');
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlq,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.Attributes?.MessageDeduplicationId ?? message.MessageId,
        MessageAttributes: {
          deadLetterReason: { DataType: 'String', StringValue: reason },
          deadLetterDetail: { DataType: 'String', StringValue: detail.slice(0, 256) || reason },
        },
      }),
    );
    await this.ack(message);
    this.telemetry.deadLettered(reason);
  }

  private async urls(): Promise<{ transactions: string; dlq: string }> {
    // Só guarda depois de resolver as duas: se a fila ainda não existe, tenta de novo depois.
    this.queueUrls ??= {
      transactions: await resolveQueueUrl(this.sqs, this.config.sqs.queues.transactions),
      dlq: await resolveQueueUrl(this.sqs, this.config.sqs.queues.dlq),
    };
    return this.queueUrls;
  }
}

function parse(body: string | undefined): ParsedMessage {
  let json: unknown;
  try {
    json = JSON.parse(body ?? '');
  } catch {
    return { ok: false, reason: 'corpo não é JSON' };
  }
  const result = wagerTransactionMessageSchema.safeParse(json);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.') || '(mensagem)');
    return { ok: false, reason: `fora do contrato: ${[...new Set(fields)].join(', ')}` };
  }
  return { ok: true, message: result.data };
}

function toCommand({ messageId, data }: WagerTransactionMessage): ProcessWagerTransactionCommand {
  // O messageId é o correlationId de tudo que essa mensagem gerar (logs e eventos).
  return { ...data, correlationId: messageId };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
