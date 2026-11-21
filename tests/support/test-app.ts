import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/app.factory';
import type { AppConfig } from '../../src/config/app-config';

export interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  close(): Promise<void>;
}

/**
 * Sobe a aplicação Nest real em porta efêmera, no mesmo processo do teste. Para ler a
 * saída do logger, use `spawnInstance` (processo próprio, como em produção).
 */
export async function startTestApp(config: AppConfig): Promise<TestApp> {
  const app = await createApp(config);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') {
    throw new Error('Não foi possível descobrir a porta da aplicação de teste');
  }
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}
