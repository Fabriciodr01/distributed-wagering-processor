import { describe, expect, test } from 'bun:test';
import { referenceRetryDelayMs } from '../../../src/application/wagering/reference-retry-policy';

describe('referenceRetryDelayMs', () => {
  test('sequência documentada: 5, 10, 20, 40, 80, 160 s e depois limitado a 300 s', () => {
    const policy = { baseDelayMs: 5_000, maxDelayMs: 300_000, maxAttempts: 10 };
    const delays = Array.from({ length: 9 }, (_, i) => referenceRetryDelayMs(i + 1, policy) / 1000);
    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 300, 300, 300]);
    // ~20 min entre a submissão e a 10ª avaliação, que expira a transação.
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(1215);
  });

  test('nunca é menor que a base', () => {
    expect(referenceRetryDelayMs(0, { baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 3 })).toBe(100);
  });
});
