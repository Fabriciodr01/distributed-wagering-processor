/** Linhas JSON da saída de um processo (ignora o que não for JSON, como avisos do runtime). */
export function logEntries(output: string): Array<Record<string, unknown>> {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

/** Valor de uma série no formato de exposição do Prometheus (0 se ainda não apareceu). */
export function metricValue(exposition: string, name: string, labels: Record<string, string> = {}): number {
  const wanted = Object.entries(labels);
  for (const line of exposition.split('\n')) {
    if (!line.startsWith(name) || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][\w:]*)(?:\{([^}]*)\})?\s+(\S+)$/.exec(line);
    if (!match || match[1] !== name) continue;
    const present = Object.fromEntries(
      (match[2] ?? '')
        .split(',')
        .filter(Boolean)
        .map((pair) => {
          const [key, value] = pair.split('=');
          return [key, value?.replace(/^"|"$/g, '')];
        }),
    );
    if (wanted.every(([key, value]) => present[key] === value)) return Number(match[3]);
  }
  return 0;
}
