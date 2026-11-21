import { beforeEach, describe, expect, test } from 'bun:test';
import { WalletNotFoundError } from '../../../src/application/errors';
import { ReconcileWalletUseCase } from '../../../src/application/wallets/reconcile-wallet.usecase';
import { Money } from '../../../src/domain/money';
import { Wallet } from '../../../src/domain/wallet';
import { InMemoryDatabase, RecordingTelemetry } from '../../support/in-memory-ports';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const AT = new Date('2026-11-21T00:00:00.000Z');

let db: InMemoryDatabase;
let telemetry: RecordingTelemetry;
let useCase: ReconcileWalletUseCase;

beforeEach(() => {
  db = new InMemoryDatabase();
  telemetry = new RecordingTelemetry();
  useCase = new ReconcileWalletUseCase(db, telemetry);
});

function seed(initial: string, storedOverride?: string) {
  const { wallet, openingEntry } = Wallet.open({
    id: 'w-1',
    playerId: 'p-1',
    initialBalance: brl(initial),
    at: AT,
    opening: { transactionId: 't-open', ledgerEntryId: 'e-open' },
  });
  const debit = wallet.debit({ ledgerEntryId: 'e-1', transactionId: 't-1', money: brl('30.00'), at: AT });
  // Saldo materializado adulterado: o ledger continua o mesmo.
  const stored = storedOverride
    ? Wallet.rehydrate({
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: brl(storedOverride),
        version: wallet.version,
        createdAt: AT,
        updatedAt: AT,
      })
    : wallet;
  db.seedWallet(stored, openingEntry);
  return debit;
}

describe('ReconcileWalletUseCase', () => {
  test('consistente: soma créditos menos débitos e não alerta', async () => {
    const debit = seed('100.00');
    await db.run(async ({ ledger }) => ledger.append(debit));
    const report = await useCase.execute('w-1');
    expect(report.consistent).toBe(true);
    expect(report.calculatedBalance.toJSON().amount).toBe('70.00');
    expect(report.difference.isZero()).toBe(true);
    expect(report.checkedEntries).toBe(2);
    expect(telemetry.signals()).toEqual([]);
  });

  test('divergente: diferença com sinal e alerta, sem corrigir o saldo', async () => {
    const debit = seed('100.00', '75.00');
    await db.run(async ({ ledger }) => ledger.append(debit));
    const report = await useCase.execute('w-1');
    expect(report.consistent).toBe(false);
    expect(report.difference.toJSON().amount).toBe('5.00');
    expect(telemetry.signals()).toEqual([['walletDivergence', 'w-1', 2]]);
    expect(db.wallet('w-1').balance.toJSON().amount).toBe('75.00');
  });

  test('wallet inexistente', async () => {
    await expect(useCase.execute('nao-existe')).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});
