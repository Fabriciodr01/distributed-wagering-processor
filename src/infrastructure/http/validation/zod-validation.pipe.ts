import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { RequestValidationError } from '../errors/request-validation.error';

/** Valida e transforma a entrada com um schema zod; falha vira 400 com o detalhe por campo. */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new RequestValidationError(
        result.error.issues.map((issue) => ({
          field: issue.path.map(String).join('.') || '(corpo)',
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}
