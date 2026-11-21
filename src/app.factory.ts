import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppConfig } from './config/app-config';
import { CorrelationMiddleware } from './infrastructure/observability/correlation.middleware';

export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), { abortOnError: false, bufferLogs: true });
  // Todo log da aplicação (inclusive o `Logger` do Nest nos workers) sai em JSON pelo pino.
  app.useLogger(app.get(Logger));
  // Registrado antes dos middlewares dos módulos: o contexto de log já existe quando o pino-http roda.
  const correlation = new CorrelationMiddleware();
  app.use(correlation.use.bind(correlation));
  return app;
}
