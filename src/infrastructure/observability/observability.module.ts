import { Global, Module } from '@nestjs/common';
import { TELEMETRY } from '../../application/ports/telemetry.port';
import { MetricsController } from './metrics.controller';
import { PrometheusTelemetry } from './prometheus-telemetry';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [{ provide: TELEMETRY, useClass: PrometheusTelemetry }],
  exports: [TELEMETRY],
})
export class ObservabilityModule {}
