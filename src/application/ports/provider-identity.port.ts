export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');

/** Quem está chamando. `providerId` ausente significa "sem restrição de provider". */
export interface ProviderIdentity {
  readonly providerId?: string;
}

/**
 * Ponto de extensão da autenticação (não implementada; ver ARCHITECTURE.md, D-01).
 * Uma implementação real validaria o token do IdP e devolveria o provider do cliente.
 */
export interface ProviderIdentityPort {
  /** null quando as credenciais não são aceitas. */
  identify(credentials: { readonly authorization?: string }): Promise<ProviderIdentity | null>;
}
