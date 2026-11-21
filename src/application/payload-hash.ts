import { createHash } from 'node:crypto';

type Canonical = string | boolean | null | readonly Canonical[] | { readonly [key: string]: Canonical | undefined };

/**
 * JSON canônico: chaves em ordem alfabética em todos os níveis, sem espaços e sem
 * chaves `undefined`. Duas representações do mesmo conteúdo geram a mesma string.
 */
export function canonicalJson(value: Canonical): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as { readonly [key: string]: Canonical | undefined };
  const fields = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as Canonical)}`);
  return `{${fields.join(',')}}`;
}

/** SHA-256 (hex minúsculo) do JSON canônico, em UTF-8. */
export function payloadHash(value: Canonical): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
