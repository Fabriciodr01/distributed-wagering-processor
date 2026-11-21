import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TELEMETRY } from '../../application/ports/telemetry.port';
import type { PrometheusTelemetry } from './prometheus-telemetry';

/** Formato de exposição do Prometheus. Sem autenticação, como os health checks. */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(TELEMETRY) private readonly telemetry: PrometheusTelemetry) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(@Res() response: Response): Promise<void> {
    response.setHeader('Content-Type', this.telemetry.registry.contentType);
    response.send(await this.telemetry.registry.metrics());
  }
}
