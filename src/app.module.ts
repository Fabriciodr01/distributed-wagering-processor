import { MikroOrmModule } from '@mikro-orm/nestjs';
import { type DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from './config/app-config';
import { ConfigModule } from './config/config.module';
import { buildOrmOptions } from './infrastructure/persistence/mikro-orm.config';
import { HealthModule } from './infrastructure/observability/health.module';

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
        HealthModule,
      ],
    };
  }
}
