import { describe, expect, test } from 'bun:test';
import { InvalidCursorError } from '../../../src/application/errors';
import { LedgerCursor } from '../../../src/application/ledger-cursor';

const WALLET = '01936f8e-7a4c-7d3e-9b2a-1c4d5e6f7a8b';
const OTHER = '01936f8e-7a4c-7d3e-9b2a-ffffffffffff';
const raw = (text: string) => Buffer.from(text).toString('base64url');

describe('LedgerCursor', () => {
  test.each([1n, 42n, 9223372036854775807n])('ida e volta de %p', (position) => {
    const cursor = LedgerCursor.encode(WALLET, position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(LedgerCursor.decode(cursor, WALLET)).toBe(position);
  });

  test('o id da wallet é comparado sem diferenciar maiúsculas', () => {
    expect(LedgerCursor.decode(LedgerCursor.encode(WALLET.toUpperCase(), 7n), WALLET)).toBe(7n);
  });

  test('cursor de outra wallet é recusado', () => {
    expect(() => LedgerCursor.decode(LedgerCursor.encode(OTHER, 7n), WALLET)).toThrow(InvalidCursorError);
  });

  test.each([
    ['vazio', ''],
    ['caracteres fora do base64url', '%%%'],
    ['sem prefixo de versão', raw('42')],
    ['v1 (sem wallet), não mais aceito', raw('v1:42')],
    ['sem wallet', raw('v2:42')],
    ['wallet que não é UUID', raw('v2:abc:42')],
    ['posição não numérica', raw(`v2:${WALLET}:abc`)],
    ['posição zero', raw(`v2:${WALLET}:0`)],
    ['posição negativa', raw(`v2:${WALLET}:-1`)],
    ['posição grande demais', raw(`v2:${WALLET}:${'9'.repeat(20)}`)],
  ])('rejeita cursor %s', (_, cursor) => {
    expect(() => LedgerCursor.decode(cursor, WALLET)).toThrow(InvalidCursorError);
  });
});
