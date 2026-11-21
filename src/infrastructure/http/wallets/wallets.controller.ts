import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CreateWalletUseCase } from '../../../application/wallets/create-wallet.usecase';
import { GetWalletUseCase } from '../../../application/wallets/get-wallet.usecase';
import { ListWalletLedgerUseCase } from '../../../application/wallets/list-wallet-ledger.usecase';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import { walletIdParamSchema } from '../validation/common.schemas';
import { ZodValidationPipe } from '../validation/zod-validation.pipe';
import {
  type LedgerEntryResponse,
  presentLedgerEntry,
  presentWallet,
  type WalletResponse,
} from './wallet.presenter';
import {
  type CreateWalletBody,
  createWalletBodySchema,
  type LedgerQuery,
  ledgerQuerySchema,
} from './wallets.schemas';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly listLedger: ListWalletLedgerUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(createWalletBodySchema)) body: CreateWalletBody,
  ): Promise<WalletResponse> {
    return presentWallet(await this.createWallet.execute(body));
  }

  @Get(':walletId')
  async findOne(
    @Param('walletId', new ZodValidationPipe(walletIdParamSchema)) walletId: string,
  ): Promise<WalletResponse> {
    return presentWallet(await this.getWallet.execute(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', new ZodValidationPipe(walletIdParamSchema)) walletId: string,
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQuery,
  ): Promise<{ items: LedgerEntryResponse[]; nextCursor: string | null }> {
    const page = await this.listLedger.execute({ walletId, limit: query.limit, cursor: query.cursor });
    return { items: page.items.map(presentLedgerEntry), nextCursor: page.nextCursor };
  }
}
