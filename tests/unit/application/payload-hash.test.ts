import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson, payloadHash } from '../../../src/application/payload-hash';

describe('payload-hash', () => {
  test('JSON canônico ordena chaves em todos os níveis e omite undefined', () => {
    expect(canonicalJson({ b: '1', a: { d: '2', c: null }, e: undefined, f: ['x', { h: true, g: 'y' }] })).toBe(
      '{"a":{"c":null,"d":"2"},"b":"1","f":["x",{"g":"y","h":true}]}',
    );
  });

  test('mesmo conteúdo em ordem diferente gera o mesmo hash', () => {
    const a = payloadHash({ kind: 'BET', money: { amount: '25.00', currency: 'BRL' } });
    const b = payloadHash({ money: { currency: 'BRL', amount: '25.00' }, kind: 'BET' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('qualquer diferença de valor muda o hash', () => {
    const base = { kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };
    expect(payloadHash(base)).not.toBe(payloadHash({ ...base, money: { amount: '25.01', currency: 'BRL' } }));
    expect(payloadHash(base)).not.toBe(payloadHash({ ...base, kind: 'WIN' }));
  });

  test('é SHA-256 em hex do JSON canônico em UTF-8', () => {
    const value = { roundId: 'rodada-ç', a: 'b' };
    const expected = createHash('sha256').update('{"a":"b","roundId":"rodada-ç"}', 'utf8').digest('hex');
    expect(payloadHash(value)).toBe(expected);
  });
});
