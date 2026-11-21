import { Global, Module } from '@nestjs/common';
import { CLOCK } from '../../application/ports/clock.port';
import { ID_GENERATOR } from '../../application/ports/id-generator.port';
import { UNIT_OF_WORK } from '../../application/ports/unit-of-work.port';
import { SystemClock } from '../system/system-clock';
import { UuidV7IdGenerator } from '../system/uuid-v7-id-generator';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work';

@Global()
@Module({
  providers: [
    { provide: UNIT_OF_WORK, useClass: MikroOrmUnitOfWork },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7IdGenerator },
  ],
  exports: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
})
export class PersistenceModule {}
