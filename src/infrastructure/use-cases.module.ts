import { Global, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../application/ports/clock.port';
import { ID_GENERATOR, type IdGenerator } from '../application/ports/id-generator.port';
import { UNIT_OF_WORK, type UnitOfWork } from '../application/ports/unit-of-work.port';
import { GetWagerTransactionUseCase } from '../application/wagering/get-wager-transaction.usecase';
import { ProcessWagerTransactionUseCase } from '../application/wagering/process-wager-transaction.usecase';
import { CreateWalletUseCase } from '../application/wallets/create-wallet.usecase';
import { GetWalletUseCase } from '../application/wallets/get-wallet.usecase';
import { ListWalletLedgerUseCase } from '../application/wallets/list-wallet-ledger.usecase';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';

const USE_CASES = [
  CreateWalletUseCase,
  GetWalletUseCase,
  ListWalletLedgerUseCase,
  ProcessWagerTransactionUseCase,
  GetWagerTransactionUseCase,
];

/**
 * Os casos de uso não conhecem o Nest: são montados aqui, com as portas injetadas por
 * token, e ficam disponíveis para qualquer borda (HTTP, consumidor SQS, workers).
 */
@Global()
@Module({
  providers: [
    {
      provide: CreateWalletUseCase,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new CreateWalletUseCase(uow, clock, ids),
    },
    {
      provide: GetWalletUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new GetWalletUseCase(uow),
    },
    {
      provide: ListWalletLedgerUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new ListWalletLedgerUseCase(uow),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, APP_CONFIG],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, config: AppConfig) =>
        new ProcessWagerTransactionUseCase(uow, clock, ids, {
          referenceRetryBaseDelayMs: config.pendingReference.baseDelayMs,
        }),
    },
    {
      provide: GetWagerTransactionUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new GetWagerTransactionUseCase(uow),
    },
  ],
  exports: USE_CASES,
})
export class UseCasesModule {}
