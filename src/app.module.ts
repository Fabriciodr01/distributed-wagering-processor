import { MikroOrmModule } from '@mikro-orm/nestjs';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { AppConfig } from './config/app-config';
import { ConfigModule } from './config/config.module';
import { AuthModule } from './infrastructure/http/auth/auth.module';
import { HttpErrorFilter } from './infrastructure/http/errors/http-error.filter';
import { WageringHttpModule } from './infrastructure/http/wagering/wagering-http.module';
import { WalletsHttpModule } from './infrastructure/http/wallets/wallets-http.module';
import { HealthModule } from './infrastructure/observability/health.module';
import { loggerParams } from './infrastructure/observability/logging';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { buildOrmOptions } from './infrastructure/persistence/mikro-orm.config';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { SqsModule } from './infrastructure/sqs/sqs.module';
import { UseCasesModule } from './infrastructure/use-cases.module';
import { WorkersModule } from './infrastructure/workers/workers.module';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot(loggerParams(config)),
        MikroOrmModule.forRoot({
          ...buildOrmOptions(config.database),
          // Cada operação abre o próprio fork; não queremos um contexto implícito por request.
          registerRequestContext: false,
        }),
        PersistenceModule,
        SqsModule,
        ObservabilityModule,
        UseCasesModule,
        HealthModule,
        WorkersModule,
        // Health e métricas ficam sempre de pé; a API de negócio só nas instâncias com o papel HTTP.
        ...(config.roles.http ? [AuthModule, WalletsHttpModule, WageringHttpModule] : []),
      ],
      providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }],
    };
  }
}
