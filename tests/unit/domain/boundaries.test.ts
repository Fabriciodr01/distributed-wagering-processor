import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { Glob } from 'bun';

const ROOT = resolve(import.meta.dir, '../../..');

describe('fronteira do domínio', () => {
  test('src/domain só importa o próprio domínio e não usa decorators', async () => {
    const offenders: string[] = [];
    for await (const file of new Glob('src/domain/**/*.ts').scan({ cwd: ROOT })) {
      const source = await Bun.file(`${ROOT}/${file}`).text();
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      for (const match of code.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1] ?? '';
        if (!specifier.startsWith('.')) offenders.push(`${file}: importa ${specifier}`);
      }
      if (/^\s*@\w+/m.test(code)) offenders.push(`${file}: usa decorator`);
    }
    expect(offenders).toEqual([]);
  });
});
