import type { ProviderIdentity, ProviderIdentityPort } from '../../../application/ports/provider-identity.port';

/** Autenticação desligada: toda chamada é aceita, sem restrição de provider. */
export class AllowAllProviderIdentity implements ProviderIdentityPort {
  async identify(): Promise<ProviderIdentity> {
    return {};
  }
}
