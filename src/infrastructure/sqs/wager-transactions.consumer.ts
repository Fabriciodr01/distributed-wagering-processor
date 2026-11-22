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
/** Piso do intervalo do heartbeat (visibilidade/3), para não martelar o SQS com visibilidade curta. */
const HEARTBEAT_MIN_MS = 300;

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
  /** Mensagens recebidas e ainda não decididas, com a visibilidade sendo renovada. */
  private readonly leases = new Map<Message, VisibilityLease>();

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
   * Para de buscar, conclui as mensagens em andamento (uma por grupo) e devolve à fila
   * (visibilidade 0) as que já tinham sido recebidas mas não começaram.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.running;
    this.running = undefined;
  }

  /**
   * Um ciclo de long polling; devolve quantas mensagens recebeu. Grupos (`MessageGroupId`)
   * diferentes do lote rodam em paralelo; dentro do grupo, em série e na ordem de chegada.
   * Enquanto uma mensagem não é decidida, a visibilidade dela é renovada (heartbeat).
   */
  async pollOnce(): Promise<number> {
    const { transactions } = await this.urls();
    const { visibilityTimeoutS } = this.config.consumer;
    const { Messages: messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: transactions,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.config.consumer.waitTimeS,
        VisibilityTimeout: visibilityTimeoutS,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    if (messages.length === 0) return 0;

    const leases = messages.map((message) => new VisibilityLease(message, (m) => this.extendVisibility(m)));
    for (const lease of leases) this.leases.set(lease.message, lease);
    const heartbeat = setInterval(
      () => {
        for (const lease of leases) lease.renew();
      },
      Math.max(HEARTBEAT_MIN_MS, (visibilityTimeoutS * 1000) / 3),
    );
    try {
      // allSettled: um grupo que falha não deixa os outros rodando soltos depois do ciclo.
      const results = await Promise.allSettled(groupByMessageGroup(messages).map((group) => this.handleGroup(group)));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
    } finally {
      clearInterval(heartbeat);
      // O que não foi decidido (grupo interrompido por erro) para de ser renovado e volta à
      // fila quando a visibilidade expirar, como antes.
      for (const lease of leases) await this.settle(lease.message);
    }
    return messages.length;
  }

  /** Em série: no FIFO, mensagens do mesmo grupo (wallet) chegam na sequência de envio. */
  private async handleGroup(group: readonly Message[]): Promise<void> {
    for (const [index, message] of group.entries()) {
      if (this.stopping) {
        await this.release(group.slice(index));
        return;
      }
      // O messageId é o correlationId de tudo o que a mensagem gerar.
      await runWithLogContext({ messageId: message.MessageId, correlationId: message.MessageId }, () =>
        this.handle(message),
      );
    }
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
    if (this.config.faults.processingDelayMs > 0) {
      // Gancho de teste: processamento mais longo que a visibilidade, para provar o heartbeat.
      await sleep(this.config.faults.processingDelayMs);
    }
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
    await this.settle(message);
    await this.changeVisibility(message, delay);
    this.telemetry.retryScheduled('consumer');
  }

  private async release(messages: readonly Message[]): Promise<void> {
    for (const message of messages) {
      await this.settle(message);
      await this.changeVisibility(message, 0);
    }
  }

  /**
   * Toda decisão final (ack, retry, DLQ, devolução) passa por aqui antes de falar com o SQS:
   * para o heartbeat e espera a renovação em voo, que assim nunca sobrescreve a decisão.
   */
  private async settle(message: Message): Promise<void> {
    const lease = this.leases.get(message);
    if (!lease) return;
    this.leases.delete(message);
    await lease.settle();
  }

  private async extendVisibility(message: Message): Promise<void> {
    try {
      await this.changeVisibility(message, this.config.consumer.visibilityTimeoutS);
    } catch (error) {
      // Sem a renovação a mensagem pode voltar antes da hora; o inbox cobre a duplicata.
      this.logger.warn({ messageId: message.MessageId, error: describe(error) }, 'Falha ao renovar a visibilidade');
    }
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
    await this.settle(message);
    const { transactions } = await this.urls();
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: transactions, ReceiptHandle: message.ReceiptHandle }));
  }

  /**
   * DLQ explícita: não vale a pena esperar o redrive (vários ciclos de visibilidade) por uma
   * mensagem que nunca vai funcionar. Envia antes de apagar: se o envio falhar, a mensagem
   * continua na fila e é tentada de novo.
   */
  private async deadLetter(message: Message, reason: DeadLetterReason, detail: string): Promise<void> {
    await this.settle(message);
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

/**
 * Renovação da visibilidade de uma mensagem recebida. As renovações são encadeadas, e
 * `settle()` encerra a cadeia e espera a que está em voo: a decisão final sobre a mensagem
 * (ack, backoff, devolução) é sempre a última chamada ao SQS.
 */
class VisibilityLease {
  private chain: Promise<void> = Promise.resolve();
  private settled = false;

  constructor(
    readonly message: Message,
    private readonly extend: (message: Message) => Promise<void>,
  ) {}

  renew(): void {
    if (this.settled) return;
    this.chain = this.chain.then(() => (this.settled ? undefined : this.extend(this.message)));
  }

  async settle(): Promise<void> {
    this.settled = true;
    await this.chain;
  }
}

/** Agrupa por `MessageGroupId` mantendo a ordem de chegada dentro de cada grupo. */
function groupByMessageGroup(messages: readonly Message[]): Message[][] {
  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    const key = message.Attributes?.MessageGroupId ?? message.MessageId ?? '';
    const group = groups.get(key);
    if (group) group.push(message);
    else groups.set(key, [message]);
  }
  return [...groups.values()];
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
