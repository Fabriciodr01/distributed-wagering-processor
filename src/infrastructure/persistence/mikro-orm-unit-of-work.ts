import { IsolationLevel, MikroORM, type SqlEntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { TransientFailureError } from '../../application/errors';
import type {
  TransactionScope,
  UnitOfWork,
  UnitOfWorkOptions,
} from '../../application/ports/unit-of-work.port';
import type { AppConfig } from '../../config/app-config';
import { APP_CONFIG } from '../../config/config.module';
import { classifyTransient } from './database-errors';
import { MikroOrmLedgerRepository } from './repositories/mikro-orm-ledger.repository';
import { MikroOrmOutboxRepository } from './repositories/mikro-orm-outbox.repository';
import { MikroOrmWagerTransactionRepository } from './repositories/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository';

/**
 * Uma transação SQL por chamada, num EntityManager próprio (fork). Os repositórios
 * escrevem com INSERT/UPDATE imediatos, na ordem em que são chamados.
 */
@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          // Lock preso por mais que isso vira falha transitória (503 / retry), nunca espera infinita.
          await em.execute(`SET LOCAL lock_timeout = ${this.config.database.lockTimeoutMs}`);
          return work(scopeFor(em));
        },
        {
          isolationLevel:
            options.isolation === 'repeatable read' ? IsolationLevel.REPEATABLE_READ : IsolationLevel.READ_COMMITTED,
          readOnly: options.readOnly ?? false,
        },
      );
    } catch (error) {
      const kind = classifyTransient(error);
      if (kind) throw new TransientFailureError(kind, { cause: error });
      throw error;
    }
  }
}

function scopeFor(em: SqlEntityManager): TransactionScope {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
