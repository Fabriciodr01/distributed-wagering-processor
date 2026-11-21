import { InvalidMessageStateError } from './errors';

export interface InboxMessageState {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
  readonly processedAt?: Date;
}

export type ReceiveInboxProps = Omit<InboxMessageState, 'processedAt'>;

/** Registro de deduplicação do consumidor, por (consumerName, messageId). */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    for (const field of ['messageId', 'consumerName', 'payloadHash'] as const) {
      if (!props[field]) {
        throw new InvalidMessageStateError(`Mensagem de inbox sem ${field}`);
      }
    }
    return InboxMessage.rehydrate(props);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt.getTime()),
      state.processedAt ? new Date(state.processedAt.getTime()) : undefined,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt.getTime()) : undefined;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /** Mesmo messageId com payload diferente não é redelivery: é conflito permanente. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidMessageStateError(`Mensagem ${this.messageId} já foi processada`);
    }
    this._processedAt = new Date(at.getTime());
  }
}
