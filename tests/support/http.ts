export interface HttpResult<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

/** Cliente HTTP mínimo para os testes: sempre devolve status, corpo JSON e headers. */
export function httpClient(baseUrl: string) {
  const request = async <T>(
    method: string,
    path: string,
    options: { body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
  ): Promise<HttpResult<T>> => {
    const hasBody = options.body !== undefined || options.rawBody !== undefined;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...options.headers },
      body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
  };

  return {
    get: <T = any>(path: string, headers?: Record<string, string>) => request<T>('GET', path, { headers }),
    post: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) =>
      request<T>('POST', path, { body, headers }),
    postRaw: <T = any>(path: string, rawBody: string) => request<T>('POST', path, { rawBody }),
  };
}

export type HttpClient = ReturnType<typeof httpClient>;
