import { Global, Module } from '@nestjs/common';
import { PROVIDER_IDENTITY } from '../../../application/ports/provider-identity.port';
import { AllowAllProviderIdentity } from './allow-all-provider-identity';
import { ProviderAuthGuard } from './provider-auth.guard';

/** Trocar `AllowAllProviderIdentity` por uma implementação com IdP liga a autenticação. */
@Global()
@Module({
  providers: [{ provide: PROVIDER_IDENTITY, useClass: AllowAllProviderIdentity }, ProviderAuthGuard],
  exports: [PROVIDER_IDENTITY, ProviderAuthGuard],
})
export class AuthModule {}
