import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { toHttpError } from './http-error-mapping';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body, headers, unexpected } = toHttpError(exception);
    if (unexpected) {
      this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    }
    if (headers) response.set(headers);
    response.status(status).json(body);
  }
}
