import { Glob } from 'bun';

export interface HygieneViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

const MONEY_NAME =
  '(amount|balance|money|price|stake|payout|total|credit|debit|cents|value)';

const RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  {
    rule: 'campo monetário tipado como number',
    pattern: new RegExp(`\\b\\w*${MONEY_NAME}\\w*\\??\\s*:\\s*number\\b`, 'i'),
  },
  { rule: 'conversão de dinheiro para ponto flutuante', pattern: /\bparseFloat\s*\(|\.toFixed\s*\(/ },
  {
    rule: 'Number() aplicado a valor monetário',
    pattern: new RegExp(`\\bNumber\\s*\\([^)]*${MONEY_NAME}`, 'i'),
  },
  {
    rule: 'tipo de coluna em ponto flutuante',
    pattern: /\b(float4|float8|real|double precision)\b|type:\s*['"](float|double|real)['"]/i,
  },
];

/** Arquivos em que `number` não pode aparecer de jeito nenhum. */
const STRICT_FILES = [/(^|\/)money\.ts$/];

export function findViolations(file: string, source: string): HygieneViolation[] {
  const violations: HygieneViolation[] = [];
  const strict = STRICT_FILES.some((pattern) => pattern.test(file));
  source.split('\n').forEach((text, index) => {
    // Comentários não são código: texto em português ("real", "valor") não pode disparar a regra.
    const code = /^\s*(\/\*|\*)/.test(text) ? '' : text.replace(/\/\/.*$/, '');
    for (const { rule, pattern } of RULES) {
      if (pattern.test(code)) violations.push({ file, line: index + 1, rule, text: text.trim() });
    }
    if (strict && /\bnumber\b/.test(code)) {
      violations.push({ file, line: index + 1, rule: 'number em arquivo de Money', text: text.trim() });
    }
  });
  return violations;
}

export async function scanSources(root: string): Promise<HygieneViolation[]> {
  const violations: HygieneViolation[] = [];
  for await (const file of new Glob('src/**/*.ts').scan({ cwd: root })) {
    const normalized = file.replaceAll('\\', '/');
    const source = await Bun.file(`${root}/${normalized}`).text();
    violations.push(...findViolations(normalized, source));
  }
  return violations;
}
