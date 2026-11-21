import type { Money } from '../../domain/money';
import { WalletNotFoundError } from '../errors';
import type { Telemetry } from '../ports/telemetry.port';
import type { UnitOfWork } from '../ports/unit-of-work.port';

export interface ReconciliationReport {
  readonly walletId: string;
  readonly storedBalance: Money;
  readonly calculatedBalance: Money;
  /** storedBalance - calculatedBalance; zero quando consistente. */
  readonly difference: Money;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

/**
 * Compara o saldo materializado com o saldo reconstruído pelo ledger. As duas leituras
 * acontecem no mesmo snapshot (REPEATABLE READ, só leitura): um commit concorrente entre
 * elas não gera divergência falsa. Divergência é sinalizada e alertada, nunca corrigida.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly telemetry: Telemetry,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.unitOfWork.run(
      async ({ wallets, ledger }) => {
        const wallet = await wallets.findById(walletId);
        if (!wallet) throw new WalletNotFoundError(walletId);
        const summary = await ledger.summarize(wallet.id, wallet.currency);
        const calculatedBalance = summary.credits.subtract(summary.debits);
        const difference = wallet.balance.subtract(calculatedBalance);
        return {
          walletId: wallet.id,
          storedBalance: wallet.balance,
          calculatedBalance,
          difference,
          consistent: difference.isZero(),
          checkedEntries: summary.entries,
        };
      },
      { isolation: 'repeatable read', readOnly: true },
    );
    if (!report.consistent) {
      this.telemetry.walletDivergence({ walletId: report.walletId, checkedEntries: report.checkedEntries });
    }
    return report;
  }
}
