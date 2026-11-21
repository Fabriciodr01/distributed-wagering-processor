import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { AppConfig } from './config/app-config';

export async function createApp(config: AppConfig): Promise<INestApplication> {
  return NestFactory.create(AppModule.forRoot(config), {
    abortOnError: false,
    logger: config.logLevel === 'silent' ? false : undefined,
  });
}
