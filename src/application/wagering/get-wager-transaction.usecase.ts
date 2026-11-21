import type { WagerTransaction } from '../../domain/wager-transaction';
import { TransactionNotFoundError } from '../errors';
import type { UnitOfWork } from '../ports/unit-of-work.port';

export class GetWagerTransactionUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    return this.found(
      await this.unitOfWork.run(({ transactions }) => transactions.findById(transactionId), { readOnly: true }),
    );
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    return this.found(
      await this.unitOfWork.run(
        ({ transactions }) => transactions.findByExternalId(providerId, externalTransactionId),
        { readOnly: true },
      ),
    );
  }

  private found(transaction: WagerTransaction | null): WagerTransaction {
    if (!transaction) throw new TransactionNotFoundError();
    return transaction;
  }
}
