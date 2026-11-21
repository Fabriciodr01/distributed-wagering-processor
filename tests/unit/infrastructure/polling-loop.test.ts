import { describe, expect, test } from 'bun:test';
import { PollingLoop } from '../../../src/infrastructure/workers/polling-loop';

describe('PollingLoop', () => {
  test('stop() interrompe a espera e aguarda a rodada em andamento terminar', async () => {
    let started = 0;
    let finished = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = new PollingLoop(
      60_000,
      async () => {
        started += 1;
        if (started === 1) await gate;
        finished += 1;
        return false;
      },
      () => {},
    );

    loop.start();
    const stopping = loop.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(started).toBe(1);
    expect(finished).toBe(1);
  });

  test('erro numa rodada não derruba o laço: espera o intervalo e tenta de novo', async () => {
    const errors: unknown[] = [];
    let ticks = 0;
    let done!: () => void;
    const reachedFive = new Promise<void>((resolve) => {
      done = resolve;
    });
    const loop = new PollingLoop(
      5,
      async () => {
        ticks += 1;
        if (ticks === 2) throw new Error('falha transitória');
        if (ticks === 5) done();
        return true;
      },
      (error) => errors.push(error),
    );
    loop.start();
    await reachedFive;
    await loop.stop();
    expect(errors).toHaveLength(1);
    expect(ticks).toBeGreaterThanOrEqual(5);
  });
});
