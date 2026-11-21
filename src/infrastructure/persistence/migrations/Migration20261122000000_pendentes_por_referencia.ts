import { Migration } from '@mikro-orm/migrations';

/**
 * Índice para "acordar" as transações PENDING_REFERENCE quando a referência delas é
 * decidida (D-06): busca por (provider_id, reference_external_transaction_id) só entre
 * as pendentes, que são poucas perto do total da tabela.
 */
export class Migration20261122000000PendentesPorReferencia extends Migration {
  override up(): void {
    this.addSql(
      `CREATE INDEX wager_transactions_pending_by_reference
         ON wager_transactions (provider_id, reference_external_transaction_id)
         WHERE status = 'PENDING_REFERENCE'`,
    );
  }

  override down(): void {
    this.addSql('DROP INDEX wager_transactions_pending_by_reference');
  }
}
