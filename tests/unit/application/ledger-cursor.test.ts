import { describe, expect, test } from 'bun:test';
import { InvalidCursorError } from '../../../src/application/errors';
import { LedgerCursor } from '../../../src/application/ledger-cursor';

describe('LedgerCursor', () => {
  test.each([1n, 42n, 9223372036854775807n])('ida e volta de %p', (position) => {
    const cursor = LedgerCursor.encode(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(LedgerCursor.decode(cursor)).toBe(position);
  });

  test.each([
    ['vazio', ''],
    ['caracteres fora do base64url', '%%%'],
    ['sem prefixo de versão', Buffer.from('42').toString('base64url')],
    ['posição não numérica', Buffer.from('v1:abc').toString('base64url')],
    ['posição zero', Buffer.from('v1:0').toString('base64url')],
    ['posição negativa', Buffer.from('v1:-1').toString('base64url')],
    ['posição grande demais', Buffer.from(`v1:${'9'.repeat(20)}`).toString('base64url')],
  ])('rejeita cursor %s', (_, cursor) => {
    expect(() => LedgerCursor.decode(cursor)).toThrow(InvalidCursorError);
  });
});
