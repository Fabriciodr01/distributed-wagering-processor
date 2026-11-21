import { MikroOrmModule } from '@mikro-orm/nestjs';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { AppConfig } from './config/app-config';
import { ConfigModule } from './config/config.module';
import { HttpErrorFilter } from './infrastructure/http/errors/http-error.filter';
import { WalletsHttpModule } from './infrastructure/http/wallets/wallets-http.module';
import { HealthModule } from './infrastructure/observability/health.module';
import { buildOrmOptions } from './infrastructure/persistence/mikro-orm.config';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        MikroOrmModule.forRoot({
          ...buildOrmOptions(config.database),
          // Cada operação abre o próprio fork; não queremos um contexto implícito por request.
          registerRequestContext: false,
        }),
        PersistenceModule,
        HealthModule,
        // Health fica sempre de pé; a API de negócio só nas instâncias com o papel HTTP.
        ...(config.roles.http ? [WalletsHttpModule] : []),
      ],
      providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }],
    };
  }
}
