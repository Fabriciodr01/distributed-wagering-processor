import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias de unicidade, imutabilidade, não-negatividade e
 * consistência entre saldo e ledger vivem aqui, não só na aplicação: um bug de
 * código não consegue gravar estado financeiro inválido.
 *
 * Erros de invariante usam SQLSTATE 23514 (check_violation) com mensagem própria.
 */
const UP: readonly string[] = [
  // ---------------------------------------------------------------- wallets
  `CREATE TABLE wallets (
    id          uuid           PRIMARY KEY,
    player_id   uuid           NOT NULL,
    currency    char(3)        NOT NULL,
    balance     numeric(20, 2) NOT NULL,
    version     integer        NOT NULL,
    created_at  timestamptz    NOT NULL,
    updated_at  timestamptz    NOT NULL,
    CONSTRAINT wallets_player_currency_key UNIQUE (player_id, currency),
    CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
    CONSTRAINT wallets_version_positive CHECK (version >= 1)
  )`,

  // Identidade imutável; version sobe exatamente 1 quando o saldo muda e fica igual quando não muda.
  `CREATE FUNCTION wallets_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.player_id IS DISTINCT FROM OLD.player_id
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'identidade da wallet % é imutável', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'wallet %: mudança de saldo exige version = %', OLD.id, OLD.version + 1
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
      RAISE EXCEPTION 'wallet %: version só muda quando o saldo muda', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$`,
  `CREATE TRIGGER wallets_guard_update BEFORE UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION wallets_guard_update()`,

  // ----------------------------------------------------- wager_transactions
  `CREATE TABLE wager_transactions (
    id                                uuid           PRIMARY KEY,
    provider_id                       text           NOT NULL,
    external_transaction_id           text           NOT NULL,
    idempotency_key                   text           NOT NULL,
    payload_hash                      char(64)       NOT NULL,
    wallet_id                         uuid           NOT NULL REFERENCES wallets (id),
    player_id                         uuid           NOT NULL,
    round_id                          text           NOT NULL,
    game_id                           text           NOT NULL,
    kind                              text           NOT NULL,
    amount                            numeric(20, 2) NOT NULL,
    currency                          char(3)        NOT NULL,
    reference_external_transaction_id text,
    reference_transaction_id          uuid           REFERENCES wager_transactions (id),
    status                            text           NOT NULL,
    failure_code                      text,
    resulting_balance                 numeric(20, 2),
    attempts                          integer        NOT NULL DEFAULT 0,
    next_attempt_at                   timestamptz,
    lease_until                       timestamptz,
    created_at                        timestamptz    NOT NULL,
    processed_at                      timestamptz,
    CONSTRAINT wager_transactions_idempotency_key UNIQUE (provider_id, idempotency_key),
    CONSTRAINT wager_transactions_external_id_key UNIQUE (provider_id, external_transaction_id),
    -- Alvo da FK composta do ledger: o lançamento pertence à mesma wallet da transação.
    CONSTRAINT wager_transactions_id_wallet_key UNIQUE (id, wallet_id),
    CONSTRAINT wager_transactions_kind_valid
      CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
    CONSTRAINT wager_transactions_status_valid
      CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
    CONSTRAINT wager_transactions_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT wager_transactions_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT wager_transactions_amount_non_negative CHECK (amount >= 0),
    CONSTRAINT wager_transactions_amount_positive_unless_loss CHECK (kind = 'LOSS' OR amount > 0),
    CONSTRAINT wager_transactions_resulting_balance_non_negative CHECK (resulting_balance >= 0),
    CONSTRAINT wager_transactions_attempts_non_negative CHECK (attempts >= 0),
    CONSTRAINT wager_transactions_opening_is_internal CHECK (kind <> 'OPENING' OR provider_id = 'internal'),
    CONSTRAINT wager_transactions_reversal_requires_reference
      CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
    CONSTRAINT wager_transactions_reference_not_allowed
      CHECK (kind NOT IN ('OPENING', 'BET') OR reference_external_transaction_id IS NULL),
    CONSTRAINT wager_transactions_processed_reversal_resolved
      CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND', 'ROLLBACK') OR reference_transaction_id IS NOT NULL),
    CONSTRAINT wager_transactions_failure_code_iff_failed
      CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
    CONSTRAINT wager_transactions_processed_at_iff_terminal
      CHECK ((status IN ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at IS NOT NULL)),
    CONSTRAINT wager_transactions_resulting_balance_when_decided
      CHECK (status NOT IN ('PROCESSED', 'REJECTED', 'PENDING_REFERENCE') OR resulting_balance IS NOT NULL)
  )`,

  // Uma referência só é revertida uma vez, por qualquer REFUND ou ROLLBACK.
  `CREATE UNIQUE INDEX wager_transactions_single_reversal
    ON wager_transactions (reference_transaction_id)
    WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'`,
  `CREATE INDEX wager_transactions_pending_reference_due
    ON wager_transactions (next_attempt_at)
    WHERE status = 'PENDING_REFERENCE'`,

  `CREATE FUNCTION wager_transactions_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
      RAISE EXCEPTION 'transação % está em estado terminal (%)', OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
      RAISE EXCEPTION 'transação %: PENDING_REFERENCE não volta para PENDING', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF ROW(NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
           NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
           NEW.reference_external_transaction_id, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
           OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
           OLD.reference_external_transaction_id, OLD.created_at) THEN
      RAISE EXCEPTION 'identidade da transação % é imutável', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$`,
  `CREATE TRIGGER wager_transactions_guard_update BEFORE UPDATE ON wager_transactions
    FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard_update()`,

  // Transações são trilha de auditoria: nunca são apagadas.
  `CREATE FUNCTION reject_removal() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION '% não permite remoção de linhas', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END
  $$`,
  `CREATE TRIGGER wager_transactions_no_delete BEFORE DELETE ON wager_transactions
    FOR EACH ROW EXECUTE FUNCTION reject_removal()`,
  `CREATE TRIGGER wager_transactions_no_truncate BEFORE TRUNCATE ON wager_transactions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_removal()`,

  // -------------------------------------------------- wallet_ledger_entries
  `CREATE TABLE wallet_ledger_entries (
    seq             bigserial      NOT NULL,
    id              uuid           PRIMARY KEY,
    wallet_id       uuid           NOT NULL REFERENCES wallets (id),
    transaction_id  uuid           NOT NULL,
    direction       text           NOT NULL,
    amount          numeric(20, 2) NOT NULL,
    balance_before  numeric(20, 2) NOT NULL,
    balance_after   numeric(20, 2) NOT NULL,
    created_at      timestamptz    NOT NULL,
    CONSTRAINT wallet_ledger_entries_seq_key UNIQUE (seq),
    CONSTRAINT wallet_ledger_entries_transaction_key UNIQUE (transaction_id),
    CONSTRAINT wallet_ledger_entries_transaction_wallet_fk
      FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),
    CONSTRAINT wallet_ledger_entries_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
    CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount > 0),
    CONSTRAINT wallet_ledger_entries_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
    CONSTRAINT wallet_ledger_entries_arithmetic CHECK (
      (direction = 'CREDIT' AND balance_after = balance_before + amount)
      OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
    )
  )`,
  `CREATE INDEX wallet_ledger_entries_wallet_seq ON wallet_ledger_entries (wallet_id, seq DESC)`,

  `CREATE FUNCTION wallet_ledger_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'ledger é imutável' USING ERRCODE = 'check_violation';
  END
  $$`,
  `CREATE TRIGGER wallet_ledger_entries_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
    FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_immutable()`,
  `CREATE TRIGGER wallet_ledger_entries_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
    FOR EACH STATEMENT EXECUTE FUNCTION wallet_ledger_entries_immutable()`,

  // Encadeamento: cada lançamento parte do saldo final do anterior (ou de 0.00 no primeiro).
  `CREATE FUNCTION wallet_ledger_entries_chain() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE
    previous numeric(20, 2);
  BEGIN
    SELECT balance_after INTO previous
      FROM wallet_ledger_entries
     WHERE wallet_id = NEW.wallet_id
     ORDER BY seq DESC
     LIMIT 1;
    IF NEW.balance_before <> COALESCE(previous, 0) THEN
      RAISE EXCEPTION 'ledger da wallet %: balance_before não continua o lançamento anterior', NEW.wallet_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$`,
  `CREATE TRIGGER wallet_ledger_entries_chain BEFORE INSERT ON wallet_ledger_entries
    FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_chain()`,

  // Conferido no COMMIT: wallet, transação e lançamento são gravados em ordens diferentes
  // dentro da mesma transação, e só o estado final precisa ser consistente.
  `CREATE FUNCTION assert_wallet_matches_ledger(target uuid) RETURNS void LANGUAGE plpgsql AS $$
  DECLARE
    stored numeric(20, 2);
    last_balance numeric(20, 2);
  BEGIN
    SELECT balance INTO stored FROM wallets WHERE id = target;
    SELECT balance_after INTO last_balance
      FROM wallet_ledger_entries
     WHERE wallet_id = target
     ORDER BY seq DESC
     LIMIT 1;
    IF stored IS DISTINCT FROM COALESCE(last_balance, 0) THEN
      RAISE EXCEPTION 'wallet %: saldo materializado diverge do ledger', target
        USING ERRCODE = 'check_violation';
    END IF;
  END
  $$`,
  `CREATE FUNCTION wallets_check_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    PERFORM assert_wallet_matches_ledger(NEW.id);
    RETURN NULL;
  END
  $$`,
  `CREATE CONSTRAINT TRIGGER wallets_match_ledger AFTER INSERT OR UPDATE OF balance ON wallets
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION wallets_check_ledger()`,

  // O lançamento só existe para transação aplicada que move saldo, com o mesmo valor.
  `CREATE FUNCTION wallet_ledger_entries_check_commit() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE
    tx wager_transactions%ROWTYPE;
  BEGIN
    SELECT * INTO tx FROM wager_transactions WHERE id = NEW.transaction_id;
    IF tx.status <> 'PROCESSED' OR tx.kind = 'LOSS' THEN
      RAISE EXCEPTION 'lançamento % exige transação PROCESSED que mova saldo', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF tx.amount <> NEW.amount THEN
      RAISE EXCEPTION 'lançamento % com valor diferente da transação', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF tx.currency <> (SELECT currency FROM wallets WHERE id = NEW.wallet_id) THEN
      RAISE EXCEPTION 'lançamento % em moeda diferente da wallet', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM assert_wallet_matches_ledger(NEW.wallet_id);
    RETURN NULL;
  END
  $$`,
  `CREATE CONSTRAINT TRIGGER wallet_ledger_entries_check_commit AFTER INSERT ON wallet_ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_check_commit()`,

  // E o inverso: transação aplicada que move saldo precisa ter o seu lançamento.
  `CREATE FUNCTION wager_transactions_check_commit() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.status = 'PROCESSED' AND NEW.kind <> 'LOSS'
       AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = NEW.id) THEN
      RAISE EXCEPTION 'transação % PROCESSED sem lançamento no ledger', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END
  $$`,
  `CREATE CONSTRAINT TRIGGER wager_transactions_check_commit AFTER INSERT OR UPDATE OF status ON wager_transactions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION wager_transactions_check_commit()`,

  // --------------------------------------------------------- inbox_messages
  `CREATE TABLE inbox_messages (
    consumer_name  text        NOT NULL,
    message_id     text        NOT NULL,
    payload_hash   char(64)    NOT NULL,
    received_at    timestamptz NOT NULL,
    processed_at   timestamptz,
    CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id),
    CONSTRAINT inbox_messages_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$')
  )`,

  // -------------------------------------------------------- outbox_messages
  `CREATE TABLE outbox_messages (
    seq              bigserial   NOT NULL,
    id               uuid        PRIMARY KEY,
    aggregate_id     uuid        NOT NULL,
    event_type       text        NOT NULL,
    payload          jsonb       NOT NULL,
    occurred_at      timestamptz NOT NULL,
    attempts         integer     NOT NULL DEFAULT 0,
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    locked_until     timestamptz,
    published_at     timestamptz,
    last_error       text,
    CONSTRAINT outbox_messages_seq_key UNIQUE (seq),
    CONSTRAINT outbox_messages_event_type_valid CHECK (event_type IN (
      'WagerTransactionProcessed', 'WagerTransactionRejected',
      'WalletBalanceChanged', 'WagerTransactionPendingReference'
    )),
    CONSTRAINT outbox_messages_payload_event_id CHECK (payload ->> 'eventId' = id::text),
    CONSTRAINT outbox_messages_attempts_non_negative CHECK (attempts >= 0)
  )`,
  `CREATE INDEX outbox_messages_unpublished ON outbox_messages (seq) WHERE published_at IS NULL`,

  // O evento confirmado não muda nem some; depois de publicado, nada mais muda.
  `CREATE FUNCTION outbox_messages_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF ROW(NEW.id, NEW.seq, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.seq, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at) THEN
      RAISE EXCEPTION 'evento % é imutável', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'evento % já foi publicado', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$`,
  `CREATE TRIGGER outbox_messages_guard_update BEFORE UPDATE ON outbox_messages
    FOR EACH ROW EXECUTE FUNCTION outbox_messages_guard_update()`,
  `CREATE TRIGGER outbox_messages_no_delete BEFORE DELETE ON outbox_messages
    FOR EACH ROW EXECUTE FUNCTION reject_removal()`,
  `CREATE TRIGGER outbox_messages_no_truncate BEFORE TRUNCATE ON outbox_messages
    FOR EACH STATEMENT EXECUTE FUNCTION reject_removal()`,
];

const DOWN: readonly string[] = [
  'DROP TABLE outbox_messages',
  'DROP FUNCTION outbox_messages_guard_update()',
  'DROP TABLE inbox_messages',
  'DROP TABLE wallet_ledger_entries',
  'DROP FUNCTION wallet_ledger_entries_check_commit()',
  'DROP FUNCTION wallet_ledger_entries_chain()',
  'DROP FUNCTION wallet_ledger_entries_immutable()',
  'DROP TABLE wager_transactions',
  'DROP FUNCTION wager_transactions_check_commit()',
  'DROP FUNCTION wager_transactions_guard_update()',
  'DROP FUNCTION reject_removal()',
  'DROP TABLE wallets',
  'DROP FUNCTION wallets_check_ledger()',
  'DROP FUNCTION assert_wallet_matches_ledger(uuid)',
  'DROP FUNCTION wallets_guard_update()',
];

export class Migration20261121000000EsquemaInicial extends Migration {
  override up(): void {
    for (const statement of UP) this.addSql(statement);
  }

  override down(): void {
    for (const statement of DOWN) this.addSql(statement);
  }
}
