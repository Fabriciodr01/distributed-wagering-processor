import { InvalidTransactionStateError, InvalidWagerTransactionError } from './errors';
import { FailureCode, isProcessingFailureCode, isRejectionCode } from './failure-code';
import type { Money } from './money';
import { LedgerDirection, oppositeDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const { Pending, PendingReference, Processed, Rejected, Failed } = WagerTransactionStatus;

/**
 * Transições válidas. Os três estados terminais não têm saída; tentar sair deles é
 * erro de programação. PENDING_REFERENCE → PENDING_REFERENCE não é transição: a
 * transação apenas continua esperando.
 */
const TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [Pending]: [PendingReference, Processed, Rejected, Failed],
  [PendingReference]: [Processed, Rejected, Failed],
  [Processed]: [],
  [Rejected]: [],
  [Failed]: [],
};

export function canTransition(from: WagerTransactionStatus, to: WagerTransactionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Tipos que cada operação pode referenciar. */
const ALLOWED_REFERENCE_KINDS: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export const OPENING_PROVIDER_ID = 'internal';

export type ReferenceAssessment =
  | { readonly outcome: 'valid' }
  | { readonly outcome: 'pending' }
  | { readonly outcome: 'rejected'; readonly code: FailureCode };

export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly processedAt?: Date;
  /** Saldo observado ao decidir a transação; é o que um replay devolve. */
  readonly resultingBalance?: Money;
}

export type CreateWagerTransactionProps = Omit<
  WagerTransactionState,
  'status' | 'referenceTransactionId' | 'failureCode' | 'processedAt' | 'resultingBalance'
>;

export interface OpeningTransactionProps {
  readonly id: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly payloadHash: string;
  readonly at: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor, não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultingBalance?: Money,
  ) {}

  /** Transação submetida por um provedor. Nasce em PENDING. OPENING não pode ser criada aqui. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING é interno e não pode ser submetido');
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError('kind inválido');
    }
    WagerTransaction.assertRequiredFields(props);
    WagerTransaction.assertAmount(props.kind, props.money);
    WagerTransaction.assertReferenceShape(props.kind, props.referenceExternalTransactionId);
    if (props.referenceExternalTransactionId === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('Uma transação não pode referenciar a si mesma');
    }
    return WagerTransaction.rehydrate({ ...props, status: Pending });
  }

  /** Crédito interno de abertura da wallet, já PROCESSED. */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('OPENING exige saldo inicial maior que zero');
    }
    const externalId = `opening:${props.walletId}`;
    return WagerTransaction.rehydrate({
      id: props.id,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: externalId,
      idempotencyKey: externalId,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: externalId,
      gameId: OPENING_PROVIDER_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: props.at,
      status: Processed,
      processedAt: props.at,
      resultingBalance: props.money,
    });
  }

  /** Reconstrução a partir da persistência: não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt.getTime()),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt ? new Date(state.processedAt.getTime()) : undefined,
      state.resultingBalance,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt.getTime()) : undefined;
  }

  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }

  // ---- transições

  markProcessed(props: {
    referenceTransactionId?: string;
    resultingBalance: Money;
    at: Date;
  }): void {
    this.transitionTo(Processed);
    if (props.referenceTransactionId && !this.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError('Transação sem referência não pode apontar para outra');
    }
    if (this.requiresReference() && !props.referenceTransactionId) {
      throw new InvalidWagerTransactionError(`${this.kind} só é processado com a referência resolvida`);
    }
    this._status = Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this._resultingBalance = props.resultingBalance;
    this._processedAt = new Date(props.at.getTime());
  }

  markPendingReference(props: { resultingBalance: Money }): void {
    this.transitionTo(PendingReference);
    if (!this.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError('Só uma transação com referência pode aguardá-la');
    }
    this._status = PendingReference;
    this._resultingBalance = props.resultingBalance;
  }

  reject(props: { code: FailureCode; resultingBalance: Money; at: Date }): void {
    this.transitionTo(Rejected);
    if (!isRejectionCode(props.code)) {
      throw new InvalidWagerTransactionError(`${props.code} não é um código de rejeição`);
    }
    this._status = Rejected;
    this._failureCode = props.code;
    this._resultingBalance = props.resultingBalance;
    this._processedAt = new Date(props.at.getTime());
  }

  fail(props: { code: FailureCode; at: Date }): void {
    this.transitionTo(Failed);
    if (!isProcessingFailureCode(props.code)) {
      throw new InvalidWagerTransactionError(`${props.code} não é um código de falha de processamento`);
    }
    this._status = Failed;
    this._failureCode = props.code;
    this._processedAt = new Date(props.at.getTime());
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TRANSITIONS[this._status].length === 0;
  }

  /** false só para LOSS: o resultado é registrado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  allowsReferenceKind(kind: WagerTransactionKind): boolean {
    return ALLOWED_REFERENCE_KINDS[this.kind].includes(kind);
  }

  /**
   * Avalia a referência já resolvida por (providerId, referenceExternalTransactionId).
   * Cobre estado, identidade, tipo e valor. "Já revertida" e "saldo suficiente"
   * dependem do banco e da wallet e ficam com o caso de uso.
   */
  assessReference(reference: WagerTransaction): ReferenceAssessment {
    if (
      !this.referenceExternalTransactionId ||
      reference.providerId !== this.providerId ||
      reference.externalTransactionId !== this.referenceExternalTransactionId
    ) {
      throw new InvalidWagerTransactionError('A referência informada não é a desta transação');
    }

    switch (reference.status) {
      case Pending:
      case PendingReference:
        return { outcome: 'pending' };
      case Rejected:
      case Failed:
        return { outcome: 'rejected', code: FailureCode.ReferenceNotProcessed };
      case Processed:
        break;
    }

    const sameContext =
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.money.currency === this.money.currency &&
      reference.roundId === this.roundId;
    if (!sameContext) {
      return { outcome: 'rejected', code: FailureCode.ReferenceMismatch };
    }
    if (!this.allowsReferenceKind(reference.kind)) {
      return { outcome: 'rejected', code: FailureCode.ReferenceKindNotAllowed };
    }
    // Reversão parcial está fora do escopo: só reversões exigem valor igual.
    if (this.isReversal() && !reference.money.equals(this.money)) {
      return { outcome: 'rejected', code: FailureCode.AmountMismatch };
    }
    return { outcome: 'valid' };
  }

  /**
   * Direção do lançamento desta transação. ROLLBACK é o inverso da referência
   * (BET → CREDIT, WIN → DEBIT, REFUND → DEBIT) e por isso exige recebê-la.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (reference && !this.allowsReferenceKind(reference.kind)) {
      throw new InvalidWagerTransactionError(`${this.kind} não pode referenciar ${reference.kind}`);
    }
    if (this.kind === WagerTransactionKind.Rollback) {
      if (!reference) {
        throw new InvalidWagerTransactionError('ROLLBACK precisa da referência para definir a direção');
      }
      return oppositeDirection(reference.ownDirection());
    }
    return this.ownDirection();
  }

  private ownDirection(): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
      case WagerTransactionKind.Rollback:
        throw new InvalidWagerTransactionError(`${this.kind} não tem direção própria de lançamento`);
    }
  }

  private transitionTo(to: WagerTransactionStatus): void {
    if (!canTransition(this._status, to)) {
      throw new InvalidTransactionStateError(this.id, this._status, to);
    }
  }

  private static assertRequiredFields(props: CreateWagerTransactionProps): void {
    const required = [
      'id',
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'payloadHash',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ] as const;
    for (const field of required) {
      if (!props[field]) {
        throw new InvalidWagerTransactionError(`${field} é obrigatório`);
      }
    }
  }

  /** LOSS é informativo e aceita 0.00; as demais operações exigem valor positivo. */
  private static assertAmount(kind: WagerTransactionKind, money: Money): void {
    const valid = kind === WagerTransactionKind.Loss ? !money.isNegative() : money.isPositive();
    if (!valid) {
      throw new InvalidWagerTransactionError(
        kind === WagerTransactionKind.Loss
          ? 'LOSS não aceita valor negativo'
          : `${kind} exige valor maior que zero`,
      );
    }
  }

  private static assertReferenceShape(
    kind: WagerTransactionKind,
    reference: string | undefined,
  ): void {
    const requires = kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
    if (requires && !reference) {
      throw new InvalidWagerTransactionError(`${kind} exige referenceExternalTransactionId`);
    }
    if (!requires && reference && ALLOWED_REFERENCE_KINDS[kind].length === 0) {
      throw new InvalidWagerTransactionError(`${kind} não aceita referenceExternalTransactionId`);
    }
  }
}
