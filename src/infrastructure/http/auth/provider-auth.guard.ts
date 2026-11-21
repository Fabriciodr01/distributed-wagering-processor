import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ProviderNotAllowedError } from '../../../application/errors';
import {
  PROVIDER_IDENTITY,
  type ProviderIdentity,
  type ProviderIdentityPort,
} from '../../../application/ports/provider-identity.port';

type AuthenticatedRequest = Request & { providerIdentity?: ProviderIdentity };

/** Aplicado aos controllers de negócio; health e métricas ficam de fora. */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const identity = await this.identity.identify({ authorization: request.headers.authorization });
    if (!identity) throw new UnauthorizedException();
    request.providerIdentity = identity;
    return true;
  }
}

export const CurrentProvider = createParamDecorator(
  (_: unknown, context: ExecutionContext): ProviderIdentity =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().providerIdentity ?? {},
);

export function assertCanActAs(identity: ProviderIdentity, providerId: string): void {
  if (identity.providerId !== undefined && identity.providerId !== providerId) {
    throw new ProviderNotAllowedError(providerId);
  }
}
