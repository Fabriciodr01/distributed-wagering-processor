import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { WagerTransactionProcessed } from '../../../src/domain/events';
import { InboxMessage } from '../../../src/domain/inbox-message';
import { Money } from '../../../src/domain/money';
import { OutboxMessage } from '../../../src/domain/outbox-message';
import { WagerTransaction, WagerTransactionKind } from '../../../src/domain/wager-transaction';
import { Wallet } from '../../../src/domain/wallet';
import { LedgerDirection } from '../../../src/domain/wallet-ledger-entry';
import { InboxMessageMapper } from '../../../src/infrastructure/persistence/mappers/inbox-message.mapper';
import { OutboxMessageMapper } from '../../../src/infrastructure/persistence/mappers/outbox-message.mapper';
import { WagerTransactionMapper } from '../../../src/infrastructure/persistence/mappers/wager-transaction.mapper';
import { WalletMapper } from '../../../src/infrastructure/persistence/mappers/wallet.mapper';
import { WalletLedgerEntryMapper } from '../../../src/infrastructure/persistence/mappers/wallet-ledger-entry.mapper';
import { buildOrmOptions } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { InboxMessageRow } from '../../../src/infrastructure/persistence/rows/inbox-message.row';
import { OutboxMessageRow } from '../../../src/infrastructure/persistence/rows/outbox-message.row';
import { WagerTransactionRow } from '../../../src/infrastructure/persistence/rows/wager-transaction.row';
import { WalletRow } from '../../../src/infrastructure/persistence/rows/wallet.row';
import { WalletLedgerEntryRow } from '../../../src/infrastructure/persistence/rows/wallet-ledger-entry.row';
import { assertWalletMatchesLedger } from '../../support/assert-wallet-matches-ledger';
import { HASH } from '../../support/sql-fixtures';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const id = () => Bun.randomUUIDv7();
// Precisão de milissegundos: é o que o timestamptz devolve para um Date do JS.
const NOW = new Date('2026-11-21T12:00:00.123Z');

describe('mapeamento domínio ↔ banco (MikroORM real)', () => {
  let db: TestDatabase;
  let orm: MikroORM;

  beforeAll(async () => {
    db = await createTestDatabase();
    orm = await MikroORM.init(buildOrmOptions({ url: db.url, poolMax: 2 }));
  });

  afterAll(async () => {
    await orm?.close(true);
    await db?.drop();
  });

  test('wallet aberta, aposta aplicada e eventos sobrevivem à ida e volta sem perder precisão', async () => {
    const walletId = id();
    const openingId = id();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: id(),
      initialBalance: brl('1000.00'),
      at: NOW,
      opening: { transactionId: openingId, ledgerEntryId: id() },
    });
    const opening = WagerTransaction.opening({
      id: openingId,
      walletId,
      playerId: wallet.playerId,
      money: brl('1000.00'),
      payloadHash: HASH,
      at: NOW,
    });

    const bet = WagerTransaction.create({
      id: id(),
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      payloadHash: HASH,
      walletId,
      playerId: wallet.playerId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: brl('25.10'),
      referenceExternalTransactionId: undefined,
      createdAt: NOW,
    });
    const debit = wallet.debit({ ledgerEntryId: id(), transactionId: bet.id, money: bet.money, at: NOW });
    bet.markProcessed({ resultingBalance: wallet.balance, at: NOW });

    const event = WagerTransactionProcessed.from(bet, { eventId: id(), correlationId: 'corr-1', occurredAt: NOW });
    const outbox = OutboxMessage.enqueue(event);
    const inbox = InboxMessage.receive({ messageId: 'msg-1', consumerName: 'consumer', payloadHash: HASH, receivedAt: NOW });
    inbox.markProcessed(NOW);

    // As rows não declaram relações, então o Unit of Work não ordena os INSERTs pelas FKs:
    // a ordem wallet → transação → ledger é explícita, com um flush por etapa.
    await orm.em.fork().transactional(async (em) => {
      await em.persist(WalletMapper.fromDomain(wallet)).flush();
      await em
        .persist([WagerTransactionMapper.fromDomain(opening), WagerTransactionMapper.fromDomain(bet)])
        .flush();
      em.persist(WalletLedgerEntryMapper.fromDomain(openingEntry!));
      em.persist(WalletLedgerEntryMapper.fromDomain(debit));
      em.persist(OutboxMessageMapper.fromDomain(outbox));
      em.persist(InboxMessageMapper.fromDomain(inbox));
    });

    const em = orm.em.fork();
    const walletRow = await em.findOneOrFail(WalletRow, { id: walletId });
    expect(typeof walletRow.balance).toBe('string');
    const loaded = WalletMapper.toDomain(walletRow);
    expect(loaded.balance.toJSON()).toEqual({ amount: '974.90', currency: 'BRL' });
    expect(loaded.version).toBe(2);
    expect(loaded.createdAt).toEqual(NOW);

    const betRow = await em.findOneOrFail(WagerTransactionRow, { id: bet.id });
    const loadedBet = WagerTransactionMapper.toDomain(betRow);
    expect(loadedBet.status).toBe(bet.status);
    expect(loadedBet.money.toJSON()).toEqual({ amount: '25.10', currency: 'BRL' });
    expect(loadedBet.resultingBalance?.toJSON()).toEqual({ amount: '974.90', currency: 'BRL' });
    expect(loadedBet.referenceExternalTransactionId).toBeUndefined();
    expect(loadedBet.processedAt).toEqual(NOW);
    expect(loadedBet.matchesPayload(HASH)).toBe(true);

    const entries = await em.find(WalletLedgerEntryRow, { walletId }, { orderBy: { seq: 'asc' } });
    expect(entries.map((row) => typeof row.seq)).toEqual(['bigint', 'bigint']);
    const loadedEntries = entries.map((row) => WalletLedgerEntryMapper.toDomain(row, 'BRL'));
    expect(loadedEntries.map((entry) => entry.direction)).toEqual([LedgerDirection.Credit, LedgerDirection.Debit]);
    expect(loadedEntries.every((entry) => entry.isBalanced())).toBe(true);

    const outboxRow = await em.findOneOrFail(OutboxMessageRow, { id: outbox.id });
    const loadedOutbox = OutboxMessageMapper.toDomain(outboxRow);
    expect(loadedOutbox.payload).toEqual(outbox.payload);
    expect(loadedOutbox.isDue(NOW)).toBe(true);

    const inboxRow = await em.findOneOrFail(InboxMessageRow, { consumerName: 'consumer', messageId: 'msg-1' });
    expect(InboxMessageMapper.toDomain(inboxRow).isProcessed()).toBe(true);

    await assertWalletMatchesLedger(db.sql, walletId);
  });

  test('transação pendente de referência preserva referência e saldo observado', async () => {
    const wallet = Wallet.open({ id: id(), playerId: id(), initialBalance: brl('0.00'), at: NOW }).wallet;
    const refund = WagerTransaction.create({
      id: id(),
      providerId: 'provider-a',
      externalTransactionId: 'refund-1',
      idempotencyKey: 'provider-a:refund-1',
      payloadHash: HASH,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: brl('5.00'),
      referenceExternalTransactionId: 'bet-ainda-nao-chegou',
      createdAt: NOW,
    });
    refund.markPendingReference({ resultingBalance: wallet.balance });

    await orm.em.fork().transactional(async (em) => {
      await em.persist(WalletMapper.fromDomain(wallet)).flush();
      em.persist(WagerTransactionMapper.fromDomain(refund, { attempts: 2, nextAttemptAt: NOW, leaseUntil: null }));
    });

    const row = await orm.em.fork().findOneOrFail(WagerTransactionRow, { id: refund.id });
    expect(row.attempts).toBe(2);
    expect(row.nextAttemptAt).toEqual(NOW);
    const loaded = WagerTransactionMapper.toDomain(row);
    expect(loaded.status).toBe(refund.status);
    expect(loaded.referenceExternalTransactionId).toBe('bet-ainda-nao-chegou');
    expect(loaded.referenceTransactionId).toBeUndefined();
    expect(loaded.resultingBalance?.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });
});
