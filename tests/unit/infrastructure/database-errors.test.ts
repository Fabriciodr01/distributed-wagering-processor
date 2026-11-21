import { describe, expect, test } from 'bun:test';
import { classifyTransient, databaseErrorCode, violatedConstraint } from '../../../src/infrastructure/persistence/database-errors';

const pgError = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error('db'), { code, ...extra });

describe('classificação de erros do banco', () => {
  test.each([
    ['55P03', 'lock_timeout'],
    ['40P01', 'deadlock'],
    ['40001', 'deadlock'],
    ['08006', 'unavailable'],
    ['57P01', 'unavailable'],
    ['57P03', 'unavailable'],
    ['53300', 'unavailable'],
    ['ECONNREFUSED', 'unavailable'],
  ])('%s é transitório (%s)', (code, kind) => {
    expect(classifyTransient(pgError(code))).toBe(kind as ReturnType<typeof classifyTransient>);
  });

  test.each(['23505', '23514', '23503', '42P01', '22P02'])('%s é permanente', (code) => {
    expect(classifyTransient(pgError(code))).toBeUndefined();
  });

  test('procura o código e a constraint na cadeia de causas', () => {
    const wrapped = new Error('wrapper', { cause: pgError('23505', { constraint: 'wallets_player_currency_key' }) });
    expect(databaseErrorCode(wrapped)).toBe('23505');
    expect(violatedConstraint(wrapped)).toBe('wallets_player_currency_key');
    expect(classifyTransient(new Error('x', { cause: pgError('55P03') }))).toBe('lock_timeout');
  });

  test('erro sem código só é transitório se for de conexão', () => {
    expect(classifyTransient(new Error('Connection terminated unexpectedly'))).toBe('unavailable');
    expect(classifyTransient(new Error('bug qualquer'))).toBeUndefined();
  });
});
