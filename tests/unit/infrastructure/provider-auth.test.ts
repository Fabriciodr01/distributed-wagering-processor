import { describe, expect, test } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { ProviderNotAllowedError } from '../../../src/application/errors';
import type { ProviderIdentity, ProviderIdentityPort } from '../../../src/application/ports/provider-identity.port';
import { GetWagerTransactionUseCase } from '../../../src/application/wagering/get-wager-transaction.usecase';
import type { ProcessWagerTransactionUseCase } from '../../../src/application/wagering/process-wager-transaction.usecase';
import { AllowAllProviderIdentity } from '../../../src/infrastructure/http/auth/allow-all-provider-identity';
import { assertCanActAs, ProviderAuthGuard } from '../../../src/infrastructure/http/auth/provider-auth.guard';
import { WageringController } from '../../../src/infrastructure/http/wagering/wagering.controller';
import { newTransaction } from '../../support/domain-fixtures';
import type { InMemoryDatabase } from '../../support/in-memory-ports';

/** Identidade de mentira: o que um IdP real devolveria para cada token. */
class FakeIdentity implements ProviderIdentityPort {
  constructor(private readonly tokens: Record<string, ProviderIdentity>) {}

  async identify({ authorization }: { authorization?: string }): Promise<ProviderIdentity | null> {
    return (authorization && this.tokens[authorization]) || null;
  }
}

function httpContext(headers: Record<string, string>) {
  const request: { headers: Record<string, string>; providerIdentity?: ProviderIdentity } = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { request, context };
}

describe('assertCanActAs', () => {
  test('identidade sem provider (autenticação desligada) pode agir por qualquer provider', () => {
    expect(() => assertCanActAs({}, 'provider-a')).not.toThrow();
  });

  test('identidade do mesmo provider pode agir', () => {
    expect(() => assertCanActAs({ providerId: 'provider-a' }, 'provider-a')).not.toThrow();
  });

  test('identidade de outro provider recebe ProviderNotAllowedError (403)', () => {
    expect(() => assertCanActAs({ providerId: 'provider-b' }, 'provider-a')).toThrow(ProviderNotAllowedError);
  });
});

describe('ProviderAuthGuard', () => {
  const guard = new ProviderAuthGuard(new FakeIdentity({ 'Bearer token-a': { providerId: 'provider-a' } }));

  test('credencial aceita: a identidade fica no request para o controller', async () => {
    const { request, context } = httpContext({ authorization: 'Bearer token-a' });
    expect(await guard.canActivate(context)).toBe(true);
    expect(request.providerIdentity).toEqual({ providerId: 'provider-a' });
  });

  test('credencial ausente ou recusada → 401', async () => {
    await expect(guard.canActivate(httpContext({}).context)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard.canActivate(httpContext({ authorization: 'Bearer outro' }).context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  test('AllowAllProviderIdentity (padrão atual) aceita tudo, sem restrição de provider', async () => {
    const open = new ProviderAuthGuard(new AllowAllProviderIdentity());
    const { request, context } = httpContext({});
    expect(await open.canActivate(context)).toBe(true);
    expect(request.providerIdentity).toEqual({});
  });
});

describe('GET /wagering/transactions/:id com identidade de provider', () => {
  const transaction = newTransaction({ providerId: 'provider-a' });
  const lookup = { run: async () => transaction } as unknown as InMemoryDatabase;
  const controller = new WageringController(
    {} as ProcessWagerTransactionUseCase,
    new GetWagerTransactionUseCase(lookup),
    { next: () => 'unused' },
  );

  test('o próprio provider (ou autenticação desligada) lê a transação', async () => {
    expect((await controller.findById(transaction.id, { providerId: 'provider-a' })).transactionId).toBe(transaction.id);
    expect((await controller.findById(transaction.id, {})).transactionId).toBe(transaction.id);
  });

  test('outro provider recebe 403, mesmo sabendo o id', async () => {
    await expect(controller.findById(transaction.id, { providerId: 'provider-b' })).rejects.toBeInstanceOf(
      ProviderNotAllowedError,
    );
  });
});
