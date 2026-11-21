import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

/**
 * Lê (e apaga) mensagens até juntar `expected` ou o prazo acabar. Apagar é necessário
 * no FIFO: o grupo só entrega a próxima depois que a anterior sai da fila.
 */
export async function receiveMessages(
  client: SQSClient,
  queueUrl: string,
  { expected, timeoutMs = 10_000 }: { expected: number; timeoutMs?: number },
): Promise<Message[]> {
  const received: Message[] = [];
  const deadline = Date.now() + timeoutMs;
  while (received.length < expected && Date.now() < deadline) {
    const batch = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId', 'ApproximateReceiveCount'],
        MessageAttributeNames: ['All'],
      }),
    );
    for (const message of batch.Messages ?? []) {
      received.push(message);
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return received;
}

/** Confere que não há nada a receber agora (uma rodada de long polling curta). */
export async function expectQueueEmpty(client: SQSClient, queueUrl: string): Promise<Message[]> {
  const batch = await client.send(
    new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
  );
  return batch.Messages ?? [];
}

export function bodyOf<T = any>(message: Message): T {
  return JSON.parse(message.Body ?? 'null') as T;
}

export interface SendOptions {
  readonly groupId: string;
  readonly deduplicationId: string;
}

/** Publica na fila de transações como um provedor faria (corpo cru, para testar mensagens inválidas). */
export async function sendRaw(client: SQSClient, queueUrl: string, body: string, options: SendOptions): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: options.groupId,
      MessageDeduplicationId: options.deduplicationId,
    }),
  );
}

/** Mensagens visíveis + em processamento (recebidas e ainda não apagadas). */
export async function queueDepth(client: SQSClient, queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const { Attributes = {} } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number(Attributes.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}
