import { Module } from '@nestjs/common';
import { SqsModule } from '../sqs/sqs.module';
import { HealthController } from './health.controller';
import { ReadinessService } from './readiness.service';

@Module({
  imports: [SqsModule],
  controllers: [HealthController],
  providers: [ReadinessService],
})
export class HealthModule {}
