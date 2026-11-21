import { Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../application/ports/clock.port';
import { ID_GENERATOR, type IdGenerator } from '../../../application/ports/id-generator.port';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../application/ports/unit-of-work.port';
import { CreateWalletUseCase } from '../../../application/wallets/create-wallet.usecase';
import { GetWalletUseCase } from '../../../application/wallets/get-wallet.usecase';
import { ListWalletLedgerUseCase } from '../../../application/wallets/list-wallet-ledger.usecase';
import { WalletsController } from './wallets.controller';

// Os casos de uso não conhecem o Nest: são montados aqui, com as portas injetadas por token.
@Module({
  controllers: [WalletsController],
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
  ],
})
export class WalletsHttpModule {}
