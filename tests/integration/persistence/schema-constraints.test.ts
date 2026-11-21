import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../../support/assert-wallet-matches-ledger';
import {
  applyTransaction,
  expectDbError,
  HASH,
  type SeededWallet,
  seedWallet,
  transactionRow,
} from '../../support/sql-fixtures';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

const ledgerEntry = (wallet: SeededWallet, transactionId: string, overrides: Record<string, unknown> = {}) => ({
  id: Bun.randomUUIDv7(),
  wallet_id: wallet.walletId,
  transaction_id: transactionId,
  direction: 'DEBIT',
  amount: '10.00',
  balance_before: '100.00',
  balance_after: '90.00',
  created_at: new Date(),
  ...overrides,
});

describe('schema: caminho válido', () => {
  test('wallet com abertura e uma aposta respeitam todas as garantias', async () => {
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    await applyTransaction(db.sql, wallet, { direction: 'DEBIT', amount: '80.00' });
    const [row] = await db.sql`SELECT balance::text AS balance, version FROM wallets WHERE id = ${wallet.walletId}`;
    expect(row).toEqual({ balance: '20.00', version: 2 });
    await assertWalletMatchesLedger(db.sql, wallet.walletId);
  });

  test('wallet com saldo zero não precisa de lançamento', async () => {
    const wallet = await seedWallet(db.sql, { balance: '0.00' });
    await assertWalletMatchesLedger(db.sql, wallet.walletId);
  });
});

describe('schema: wallets', () => {
  test('no máximo uma wallet por player + moeda', async () => {
    const wallet = await seedWallet(db.sql, { balance: '0.00' });
    await expectDbError(
      () => db.sql`
        INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
        VALUES (${Bun.randomUUIDv7()}, ${wallet.playerId}, 'BRL', 0, 1, now(), now())`,
      { sqlState: UNIQUE, constraint: 'wallets_player_currency_key' },
    );
    // A mesma pessoa pode ter wallet em outra moeda.
    await db.sql`
      INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
      VALUES (${Bun.randomUUIDv7()}, ${wallet.playerId}, 'USD', 0, 1, now(), now())`;
  });

  test('saldo negativo é recusado pelo CHECK', async () => {
    const wallet = await seedWallet(db.sql, { balance: '0.00' });
    await expectDbError(
      () => db.sql`UPDATE wallets SET balance = -0.01, version = version + 1 WHERE id = ${wallet.walletId}`,
      { sqlState: CHECK, constraint: 'wallets_balance_non_negative' },
    );
  });

  test('moeda fora do formato ISO é recusada', async () => {
    await expectDbError(
      () => db.sql`
        INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
        VALUES (${Bun.randomUUIDv7()}, ${Bun.randomUUIDv7()}, 'brl', 0, 1, now(), now())`,
      { sqlState: CHECK, constraint: 'wallets_currency_format' },
    );
  });

  test.each([
    ['moeda', 'currency', "'USD'"],
    ['player', 'player_id', 'gen_random_uuid()'],
    ['data de criação', 'created_at', "now() - interval '1 day'"],
  ])('identidade imutável: %s não muda', async (_, column, value) => {
    const wallet = await seedWallet(db.sql, { balance: '0.00' });
    await expectDbError(
      () => db.sql.unsafe(`UPDATE wallets SET ${column} = ${value} WHERE id = '${wallet.walletId}'`),
      { sqlState: CHECK, message: /identidade da wallet .* é imutável/ },
    );
  });

  test('mudar o saldo sem incrementar version em 1 é recusado', async () => {
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    await expectDbError(
      () => db.sql`UPDATE wallets SET balance = 90 WHERE id = ${wallet.walletId}`,
      { sqlState: CHECK, message: /mudança de saldo exige version = 2/ },
    );
    await expectDbError(
      () => db.sql`UPDATE wallets SET balance = 90, version = 3 WHERE id = ${wallet.walletId}`,
      { sqlState: CHECK, message: /mudança de saldo exige version = 2/ },
    );
  });

  test('mudar version sem mudar o saldo é recusado', async () => {
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    await expectDbError(
      () => db.sql`UPDATE wallets SET version = version + 1 WHERE id = ${wallet.walletId}`,
      { sqlState: CHECK, message: /version só muda quando o saldo muda/ },
    );
  });

  test('saldo alterado sem lançamento correspondente é recusado no commit', async () => {
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    await expectDbError(
      () => db.sql`UPDATE wallets SET balance = 50, version = 2 WHERE id = ${wallet.walletId}`,
      { sqlState: CHECK, message: /saldo materializado diverge do ledger/ },
    );
  });

  test('wallet criada com saldo positivo e sem lançamento de abertura é recusada no commit', async () => {
    await expectDbError(
      () => db.sql`
        INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
        VALUES (${Bun.randomUUIDv7()}, ${Bun.randomUUIDv7()}, 'BRL', 10, 1, now(), now())`,
      { sqlState: CHECK, message: /saldo materializado diverge do ledger/ },
    );
  });
});

describe('schema: wager_transactions', () => {
  let wallet: SeededWallet;

  beforeAll(async () => {
    wallet = await seedWallet(db.sql, { balance: '100.00' });
  });

  const insert = (overrides: Record<string, unknown>) => db.sql`INSERT INTO wager_transactions ${db.sql(transactionRow(wallet, overrides))}`;

  test('idempotency key é única por provider', async () => {
    await insert({ idempotency_key: 'k-1', status: 'PENDING_REFERENCE', kind: 'REFUND', reference_external_transaction_id: 'x', resulting_balance: '100.00' });
    await expectDbError(() => insert({ idempotency_key: 'k-1' }), {
      sqlState: UNIQUE,
      constraint: 'wager_transactions_idempotency_key',
    });
    // Outro provider pode usar a mesma chave.
    await insert({ idempotency_key: 'k-1', provider_id: 'provider-b', status: 'PENDING_REFERENCE', kind: 'REFUND', reference_external_transaction_id: 'x', resulting_balance: '100.00' });
  });

  test('externalTransactionId é único por provider', async () => {
    await insert({ external_transaction_id: 'ext-1', status: 'PENDING_REFERENCE', kind: 'ROLLBACK', reference_external_transaction_id: 'x', resulting_balance: '100.00' });
    await expectDbError(() => insert({ external_transaction_id: 'ext-1' }), {
      sqlState: UNIQUE,
      constraint: 'wager_transactions_external_id_key',
    });
  });

  test.each([
    ['kind desconhecido', { kind: 'JACKPOT' }, 'wager_transactions_kind_valid'],
    ['status desconhecido', { status: 'DONE' }, 'wager_transactions_status_valid'],
    ['valor negativo', { amount: '-1.00' }, 'wager_transactions_amount_non_negative'],
    ['BET com valor zero', { amount: '0.00' }, 'wager_transactions_amount_positive_unless_loss'],
    ['payload hash fora do formato', { payload_hash: 'X'.repeat(64) }, 'wager_transactions_payload_hash_format'],
    ['OPENING de provider externo', { kind: 'OPENING' }, 'wager_transactions_opening_is_internal'],
    ['REFUND sem referência', { kind: 'REFUND' }, 'wager_transactions_reversal_requires_reference'],
    ['BET com referência', { reference_external_transaction_id: 'x' }, 'wager_transactions_reference_not_allowed'],
    ['REJECTED sem failure_code', { status: 'REJECTED', processed_at: new Date(), resulting_balance: '1.00' }, 'wager_transactions_failure_code_iff_failed'],
    ['failure_code sem REJECTED/FAILED', { failure_code: 'INSUFFICIENT_FUNDS' }, 'wager_transactions_failure_code_iff_failed'],
    ['terminal sem processed_at', { status: 'FAILED', failure_code: 'PERMANENT_PROCESSING_ERROR' }, 'wager_transactions_processed_at_iff_terminal'],
    ['REJECTED sem saldo resultante', { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', processed_at: new Date() }, 'wager_transactions_resulting_balance_when_decided'],
    ['reversão PROCESSED sem referência resolvida', { kind: 'REFUND', reference_external_transaction_id: 'x', status: 'PROCESSED', processed_at: new Date(), resulting_balance: '1.00' }, 'wager_transactions_processed_reversal_resolved'],
  ])('CHECK: %s', async (_, overrides, constraint) => {
    await expectDbError(() => insert(overrides), { sqlState: CHECK, constraint });
  });

  test('LOSS aceita valor zero e é aplicada sem lançamento', async () => {
    await insert({ kind: 'LOSS', amount: '0.00', status: 'PROCESSED', processed_at: new Date(), resulting_balance: '100.00' });
  });

  test('transação PROCESSED que move saldo sem lançamento é recusada no commit', async () => {
    await expectDbError(
      () => insert({ status: 'PROCESSED', processed_at: new Date(), resulting_balance: '90.00' }),
      { sqlState: CHECK, message: /PROCESSED sem lançamento no ledger/ },
    );
  });

  test.each([
    ['PROCESSED', { status: 'PROCESSED', processed_at: new Date(), resulting_balance: '100.00', kind: 'LOSS' }],
    ['REJECTED', { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', processed_at: new Date(), resulting_balance: '100.00' }],
    ['FAILED', { status: 'FAILED', failure_code: 'PERMANENT_PROCESSING_ERROR', processed_at: new Date() }],
  ])('estado terminal %s não muda mais', async (_, overrides) => {
    const row = transactionRow(wallet, overrides);
    await db.sql`INSERT INTO wager_transactions ${db.sql(row)}`;
    await expectDbError(
      () => db.sql`UPDATE wager_transactions SET status = 'PENDING_REFERENCE' WHERE id = ${row.id}`,
      { sqlState: CHECK, message: /estado terminal/ },
    );
    await expectDbError(() => db.sql`UPDATE wager_transactions SET attempts = 1 WHERE id = ${row.id}`, {
      sqlState: CHECK,
      message: /estado terminal/,
    });
  });

  test('PENDING_REFERENCE aceita reagendamento e conclusão, mas não volta para PENDING nem muda identidade', async () => {
    const row = transactionRow(wallet, {
      kind: 'REFUND',
      reference_external_transaction_id: 'bet-missing',
      status: 'PENDING_REFERENCE',
      resulting_balance: '100.00',
    });
    await db.sql`INSERT INTO wager_transactions ${db.sql(row)}`;
    await db.sql`UPDATE wager_transactions SET attempts = attempts + 1, next_attempt_at = now() WHERE id = ${row.id}`;
    await expectDbError(() => db.sql`UPDATE wager_transactions SET status = 'PENDING' WHERE id = ${row.id}`, {
      sqlState: CHECK,
      message: /não volta para PENDING/,
    });
    await expectDbError(() => db.sql`UPDATE wager_transactions SET amount = 99 WHERE id = ${row.id}`, {
      sqlState: CHECK,
      message: /identidade da transação .* é imutável/,
    });
    await db.sql`
      UPDATE wager_transactions
         SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND_EXPIRED', processed_at = now()
       WHERE id = ${row.id}`;
  });

  test('transações não podem ser apagadas nem truncadas', async () => {
    await expectDbError(() => db.sql`DELETE FROM wager_transactions WHERE wallet_id = ${wallet.walletId}`, {
      sqlState: CHECK,
      message: /não permite remoção/,
    });
    await expectDbError(() => db.sql`TRUNCATE wager_transactions CASCADE`, {
      // O CASCADE alcança o ledger; qualquer uma das duas proteções pode disparar primeiro.
      sqlState: CHECK,
      message: /não permite remoção|ledger é imutável/,
    });
  });

  test('uma referência só é revertida uma vez, por qualquer REFUND ou ROLLBACK', async () => {
    const target = await seedWallet(db.sql, { balance: '100.00' });
    const bet = await applyTransaction(db.sql, target, { direction: 'DEBIT', amount: '25.00' });
    const reversalOf = (kind: string) => ({
      direction: 'CREDIT' as const,
      amount: '25.00',
      kind,
      reference_external_transaction_id: bet.external_transaction_id,
      reference_transaction_id: bet.id,
    });
    await applyTransaction(db.sql, target, reversalOf('REFUND'));
    for (const kind of ['REFUND', 'ROLLBACK']) {
      await expectDbError(() => applyTransaction(db.sql, target, reversalOf(kind)), {
        sqlState: UNIQUE,
        constraint: 'wager_transactions_single_reversal',
      });
    }
    await assertWalletMatchesLedger(db.sql, target.walletId);
  });
});

describe('schema: wallet_ledger_entries', () => {
  test('no máximo um lançamento por transação', async () => {
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    const bet = await applyTransaction(db.sql, wallet, { direction: 'DEBIT', amount: '10.00' });
    await expectDbError(
      () => db.sql`INSERT INTO wallet_ledger_entries ${db.sql(ledgerEntry(wallet, bet.id as string, { balance_before: '90.00', balance_after: '80.00' }))}`,
      { sqlState: UNIQUE, constraint: 'wallet_ledger_entries_transaction_key' },
    );
  });

  test.each([
    ['aritmética de débito errada', { balance_after: '91.00' }, 'wallet_ledger_entries_arithmetic'],
    ['crédito com saldo de débito', { direction: 'CREDIT' }, 'wallet_ledger_entries_arithmetic'],
    ['valor zero', { amount: '0.00', balance_after: '100.00' }, 'wallet_ledger_entries_amount_positive'],
    ['saldo final negativo', { amount: '110.00', balance_after: '-10.00' }, 'wallet_ledger_entries_balances_non_negative'],
  ])('CHECK: %s', async (_, overrides, constraint) => {
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    const row = transactionRow(wallet);
    await expectDbError(
      () =>
        db.sql.begin(async (tx) => {
          await tx`INSERT INTO wager_transactions ${tx(row)}`;
          await tx`INSERT INTO wallet_ledger_entries ${tx(ledgerEntry(wallet, row.id as string, overrides))}`;
        }),
      { sqlState: CHECK, constraint },
    );
  });

  test('lançamento precisa continuar o saldo do anterior', async () => {
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    const row = transactionRow(wallet);
    await expectDbError(
      () =>
        db.sql.begin(async (tx) => {
          await tx`INSERT INTO wager_transactions ${tx(row)}`;
          await tx`INSERT INTO wallet_ledger_entries ${tx(ledgerEntry(wallet, row.id as string, { balance_before: '60.00', balance_after: '50.00' }))}`;
        }),
      { sqlState: CHECK, message: /balance_before não continua o lançamento anterior/ },
    );
  });

  test('lançamento de uma wallet não pode apontar para transação de outra', async () => {
    const owner = await seedWallet(db.sql, { balance: '100.00' });
    const other = await seedWallet(db.sql, { balance: '100.00' });
    const row = transactionRow(owner);
    await expectDbError(
      () =>
        db.sql.begin(async (tx) => {
          await tx`INSERT INTO wager_transactions ${tx(row)}`;
          await tx`INSERT INTO wallet_ledger_entries ${tx(ledgerEntry(other, row.id as string))}`;
        }),
      { sqlState: FOREIGN_KEY, constraint: 'wallet_ledger_entries_transaction_wallet_fk' },
    );
  });

  test.each([
    ['REJECTED', { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', processed_at: new Date(), resulting_balance: '100.00' }, /exige transação PROCESSED/],
    ['LOSS', { kind: 'LOSS', status: 'PROCESSED', processed_at: new Date(), resulting_balance: '90.00' }, /exige transação PROCESSED que mova saldo/],
    ['valor diferente da transação', { amount: '11.00', status: 'PROCESSED', processed_at: new Date(), resulting_balance: '90.00' }, /valor diferente da transação/],
  ])('lançamento para transação %s é recusado no commit', async (_, overrides, message) => {
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    const row = transactionRow(wallet, overrides);
    await expectDbError(
      () =>
        db.sql.begin(async (tx) => {
          await tx`INSERT INTO wager_transactions ${tx(row)}`;
          await tx`INSERT INTO wallet_ledger_entries ${tx(ledgerEntry(wallet, row.id as string))}`;
          await tx`UPDATE wallets SET balance = 90, version = 2 WHERE id = ${wallet.walletId}`;
        }),
      { sqlState: CHECK, message },
    );
  });

  test('ledger é imutável: UPDATE, DELETE e TRUNCATE são recusados', async () => {
    const wallet = await seedWallet(db.sql, { balance: '100.00' });
    await expectDbError(() => db.sql`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ${wallet.walletId}`, {
      sqlState: CHECK,
      message: /ledger é imutável/,
    });
    await expectDbError(() => db.sql`DELETE FROM wallet_ledger_entries WHERE wallet_id = ${wallet.walletId}`, {
      sqlState: CHECK,
      message: /ledger é imutável/,
    });
    await expectDbError(() => db.sql`TRUNCATE wallet_ledger_entries`, {
      sqlState: CHECK,
      message: /ledger é imutável/,
    });
    await assertWalletMatchesLedger(db.sql, wallet.walletId);
  });
});

describe('schema: inbox e outbox', () => {
  const outboxRow = (overrides: Record<string, unknown> = {}) => {
    const id = Bun.randomUUIDv7();
    return {
      id,
      aggregate_id: Bun.randomUUIDv7(),
      event_type: 'WalletBalanceChanged',
      payload: { eventId: id },
      occurred_at: new Date(),
      ...overrides,
    };
  };

  test('inbox deduplica por (consumer_name, message_id)', async () => {
    const insert = (consumer: string) => db.sql`
      INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
      VALUES (${consumer}, 'msg-1', ${HASH}, now())`;
    await insert('consumer-a');
    await insert('consumer-b');
    await expectDbError(() => insert('consumer-a'), { sqlState: UNIQUE, constraint: 'inbox_messages_pkey' });
  });

  test('payload da outbox precisa carregar o próprio eventId', async () => {
    await expectDbError(() => db.sql`INSERT INTO outbox_messages ${db.sql(outboxRow({ payload: { eventId: 'outro' } }))}`, {
      sqlState: CHECK,
      constraint: 'outbox_messages_payload_event_id',
    });
  });

  test('tipo de evento desconhecido é recusado', async () => {
    await expectDbError(() => db.sql`INSERT INTO outbox_messages ${db.sql(outboxRow({ event_type: 'Qualquer' }))}`, {
      sqlState: CHECK,
      constraint: 'outbox_messages_event_type_valid',
    });
  });

  test('evento não muda de conteúdo, não some e fica congelado depois de publicado', async () => {
    const row = outboxRow();
    await db.sql`INSERT INTO outbox_messages ${db.sql(row)}`;
    await db.sql`UPDATE outbox_messages SET attempts = 1, locked_until = now() WHERE id = ${row.id}`;
    await expectDbError(() => db.sql`UPDATE outbox_messages SET event_type = 'WagerTransactionRejected' WHERE id = ${row.id}`, {
      sqlState: CHECK,
      message: /é imutável/,
    });
    await expectDbError(() => db.sql`DELETE FROM outbox_messages WHERE id = ${row.id}`, {
      sqlState: CHECK,
      message: /não permite remoção/,
    });
    await db.sql`UPDATE outbox_messages SET published_at = now() WHERE id = ${row.id}`;
    await expectDbError(() => db.sql`UPDATE outbox_messages SET published_at = now() WHERE id = ${row.id}`, {
      sqlState: CHECK,
      message: /já foi publicado/,
    });
  });
});
