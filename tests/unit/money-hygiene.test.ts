import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { findViolations, scanSources } from '../support/money-hygiene';

describe('higiene: dinheiro nunca passa por number/float', () => {
  test('o código-fonte não tem nenhuma violação', async () => {
    const violations = await scanSources(resolve(import.meta.dir, '../..'));
    expect(violations).toEqual([]);
  });

  // Garante que o detector de fato detecta; sem isso o teste acima passaria vazio.
  test.each([
    ['src/domain/wallet.ts', 'private balance: number;'],
    ['src/domain/wallet.ts', 'readonly amountInCents?: number'],
    ['src/application/x.ts', 'const v = parseFloat(input.amount);'],
    ['src/application/x.ts', 'return total.toFixed(2);'],
    ['src/application/x.ts', 'const n = Number(dto.money.amount);'],
    ['src/infrastructure/persistence/m.ts', 'balance double precision NOT NULL'],
    ['src/infrastructure/persistence/m.ts', "amount: { type: 'float' }"],
    ['src/domain/money.ts', 'private readonly scale: number = 2;'],
  ])('detecta violação em %s: %s', (file, line) => {
    expect(findViolations(file, line).length).toBeGreaterThan(0);
  });

  test.each([
    ['src/domain/wallet.ts', 'private _version: number;'],
    ['src/domain/wallet.ts', 'readonly balance: Money;'],
    ['src/config/app-config.ts', 'readonly poolMax: number;'],
    ['src/domain/money.ts', "// nunca usamos number aqui"],
    ['src/application/x.ts', ' * Uma implementação real validaria o token.'],
    ['src/application/x.ts', '/** valor real do saldo: number nunca */'],
  ])('não acusa falso positivo em %s: %s', (file, line) => {
    expect(findViolations(file, line)).toEqual([]);
  });
});
