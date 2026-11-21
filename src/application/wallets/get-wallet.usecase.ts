import type { Wallet } from '../../domain/wallet';
import { WalletNotFoundError } from '../errors';
import type { UnitOfWork } from '../ports/unit-of-work.port';

export class GetWalletUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.unitOfWork.run(({ wallets }) => wallets.findById(walletId), {
      readOnly: true,
    });
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }
}
