import { randomUUID } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { createDatabase } from '../../database/database.factory';
import type { AccountKind, Database } from '../../database/database.types';
import { migrateToLatest } from '../../database/migrator';
import { ProfileRepository } from '../profile/profile.repository';
import { ProfileService } from '../profile/profile.service';
import { AccountRepository } from './account.repository';
import { LedgerService } from './ledger.service';

const NOW = new Date('2026-07-17T08:00:00.000Z');

interface LedgerDatabaseTestContext {
  db: Kysely<Database>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

let context: LedgerDatabaseTestContext | undefined;

beforeAll(async () => { context = await createDatabaseTestContext(); });
beforeEach(async () => { await context?.reset(); });
afterAll(async () => { await context?.close(); });

describe('LedgerService', () => {
  test('posts a balanced entry atomically and returns the resulting balance', async () => {
    const userId = await createUser();
    const openingEquityId = await accountId(userId, 'OPENING_EQUITY');
    const freeId = await accountId(userId, 'FREE');
    const ledger = ledgerService();

    const transaction = await ledger.post({
      userId,
      type: 'OPENING_BALANCE',
      effectiveAt: NOW,
      metadata: { origin: 'setup' },
      postings: [
        { accountId: openingEquityId, amountMinor: -100_000 },
        { accountId: freeId, amountMinor: 100_000 },
      ],
    });

    await expect(ledger.getAccountBalance(userId, freeId)).resolves.toBe(100_000);
    expect(transaction).toMatchObject({
      userId,
      type: 'OPENING_BALANCE',
      effectiveAt: NOW,
      reversalOf: null,
      sourceOccurrenceId: null,
      metadata: { origin: 'setup' },
    });
    expect(transaction.postings.reduce((sum, posting) => sum + posting.amountMinor, 0))
      .toBe(0);
  });

  test.each([
    {
      name: 'fewer than two postings',
      amounts: [100],
    },
    {
      name: 'a zero posting',
      amounts: [0, 0],
    },
    {
      name: 'an unsafe integer',
      amounts: [Number.MAX_SAFE_INTEGER + 1, -(Number.MAX_SAFE_INTEGER + 1)],
    },
    {
      name: 'a non-zero sum',
      amounts: [100, -99],
    },
  ])('rejects $name before writing anything', async ({ amounts }) => {
    const userId = await createUser();
    const freeId = await accountId(userId, 'FREE');
    const incomeId = await accountId(userId, 'INCOME_SOURCE');
    const accountIds = [freeId, incomeId];

    await expect(ledgerService().post({
      userId,
      type: 'INCOME',
      effectiveAt: NOW,
      postings: amounts.map((amountMinor, index) => ({
        accountId: accountIds[index % accountIds.length],
        amountMinor,
      })),
    })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });

    await expect(transactionCount(userId)).resolves.toBe(0);
  });

  test('hides another user account as 404 for reads and writes', async () => {
    const ownerId = await createUser();
    const callerId = await createUser();
    const foreignFreeId = await accountId(ownerId, 'FREE');
    const callerIncomeId = await accountId(callerId, 'INCOME_SOURCE');
    const ledger = ledgerService();

    await expect(ledger.getAccountBalance(callerId, foreignFreeId))
      .rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    await expect(ledger.post({
      userId: callerId,
      type: 'INCOME',
      effectiveAt: NOW,
      postings: [
        { accountId: callerIncomeId, amountMinor: -1_000 },
        { accountId: foreignFreeId, amountMinor: 1_000 },
      ],
    })).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    await expect(transactionCount(callerId)).resolves.toBe(0);
  });

  test('allows exactly one opening balance under concurrent requests', async () => {
    const userId = await createUser();
    const ledger = ledgerService();

    const results = await Promise.allSettled([
      ledger.createOpeningBalance(userId, 25_000, NOW),
      ledger.createOpeningBalance(userId, 25_000, NOW),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { status: HttpStatus.CONFLICT },
    });
    await expect(transactionCount(userId, 'OPENING_BALANCE')).resolves.toBe(1);
    await expect(ledger.getAccountBalance(userId, await accountId(userId, 'FREE')))
      .resolves.toBe(25_000);
  });

  test('allows ordinary expense postings to make FREE negative', async () => {
    const userId = await createUser();
    const freeId = await accountId(userId, 'FREE');
    const expenseId = await accountId(userId, 'EXPENSE_SINK');
    const ledger = ledgerService();

    await ledger.post({
      userId,
      type: 'ORDINARY_EXPENSE',
      effectiveAt: NOW,
      postings: [
        { accountId: freeId, amountMinor: -5_000 },
        { accountId: expenseId, amountMinor: 5_000 },
      ],
    });

    await expect(ledger.getAccountBalance(userId, freeId)).resolves.toBe(-5_000);
  });

  test('locks scoped accounts in stable UUID order and reads balances in the transaction', async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    const freeId = await accountId(userId, 'FREE');
    const incomeId = await accountId(userId, 'INCOME_SOURCE');
    const foreignFreeId = await accountId(otherUserId, 'FREE');
    await ledgerService().post({
      userId,
      type: 'INCOME',
      effectiveAt: NOW,
      postings: [
        { accountId: incomeId, amountMinor: -2_500 },
        { accountId: freeId, amountMinor: 2_500 },
      ],
    });

    const locked = await database().transaction().execute((trx) =>
      new AccountRepository(database()).lockAccounts(
        userId,
        [freeId, foreignFreeId, incomeId, freeId],
        trx,
      ));

    expect(locked).toEqual([
      { id: freeId, userId, balanceMinor: 2_500 },
      { id: incomeId, userId, balanceMinor: -2_500 },
    ].sort((left, right) => left.id.localeCompare(right.id)));
  });

  test('reverses by appending exact mirrored postings and rejects a second reversal', async () => {
    const userId = await createUser();
    const freeId = await accountId(userId, 'FREE');
    const incomeId = await accountId(userId, 'INCOME_SOURCE');
    const ledger = ledgerService();
    const original = await ledger.post({
      userId,
      type: 'INCOME',
      effectiveAt: NOW,
      postings: [
        { accountId: incomeId, amountMinor: -7_500 },
        { accountId: freeId, amountMinor: 7_500 },
      ],
    });
    const reversedAt = new Date('2026-07-18T09:30:00.000Z');

    const reversal = await ledger.reverse(userId, original.id, reversedAt);

    expect(reversal).toMatchObject({
      userId,
      type: 'REVERSAL',
      effectiveAt: reversedAt,
      reversalOf: original.id,
    });
    expect(normalizedPostings(reversal.postings)).toEqual(normalizedPostings(
      original.postings.map((posting) => ({
        ...posting,
        amountMinor: -posting.amountMinor,
      })),
    ));
    await expect(ledger.getAccountBalance(userId, freeId)).resolves.toBe(0);
    await expect(ledger.reverse(userId, original.id, reversedAt))
      .rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    await expect(transactionCount(userId)).resolves.toBe(2);
  });

  test('returns only the user ledger with deterministic cursor pagination', async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    const ledger = ledgerService();
    await insertIncomesWithinOneMillisecond(userId, 51);
    await postIncomes(ledger, otherUserId, 1);

    const firstPage = await ledger.list(userId);
    const secondPage = await ledger.list(userId, firstPage.nextCursor!);

    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect(new Set([...firstPage.items, ...secondPage.items].map(({ id }) => id)).size)
      .toBe(51);
    expect([...firstPage.items, ...secondPage.items].every((item) => item.userId === userId))
      .toBe(true);
    expect(firstPage.items.every((item) => item.postings.length === 2)).toBe(true);
  });

  test('relies on the deferred database trigger for direct unbalanced inserts', async () => {
    const userId = await createUser();
    const freeId = await accountId(userId, 'FREE');
    const incomeId = await accountId(userId, 'INCOME_SOURCE');
    let reachedTransactionEnd = false;

    await expect(database().transaction().execute(async (transaction) => {
      const transactionId = randomUUID();
      await transaction.insertInto('ledger_transactions').values({
        id: transactionId,
        user_id: userId,
        type: 'INCOME',
        effective_at: NOW,
        reversal_of: null,
        source_occurrence_id: null,
        metadata: {},
      }).execute();
      await transaction.insertInto('ledger_postings').values([
        {
          id: randomUUID(), transaction_id: transactionId, user_id: userId,
          account_id: incomeId, amount_minor: -100,
        },
        {
          id: randomUUID(), transaction_id: transactionId, user_id: userId,
          account_id: freeId, amount_minor: 99,
        },
      ]).execute();
      reachedTransactionEnd = true;
    })).rejects.toThrow(/not balanced/i);

    expect(reachedTransactionEnd).toBe(true);
  });
});

async function postIncomes(ledger: LedgerService, userId: string, count: number): Promise<void> {
  const freeId = await accountId(userId, 'FREE');
  const incomeId = await accountId(userId, 'INCOME_SOURCE');
  for (let index = 0; index < count; index += 1) {
    await ledger.post({
      userId,
      type: 'INCOME',
      effectiveAt: new Date(NOW.getTime() + index),
      postings: [
        { accountId: incomeId, amountMinor: -1 },
        { accountId: freeId, amountMinor: 1 },
      ],
    });
  }
}

async function insertIncomesWithinOneMillisecond(userId: string, count: number): Promise<void> {
  const freeId = await accountId(userId, 'FREE');
  const incomeId = await accountId(userId, 'INCOME_SOURCE');

  await database().transaction().execute(async (trx) => {
    for (let index = 0; index < count; index += 1) {
      const transactionId = randomUUID();
      await sql`
        insert into ledger_transactions (
          id, user_id, type, effective_at, reversal_of, source_occurrence_id,
          metadata, created_at
        ) values (
          ${transactionId}::uuid, ${userId}::uuid, 'INCOME', ${NOW}, null, null,
          '{}'::jsonb,
          timestamptz '2026-07-17 08:00:00+00' + ${index} * interval '10 microseconds'
        )
      `.execute(trx);
      await trx.insertInto('ledger_postings').values([
        {
          id: randomUUID(), transaction_id: transactionId, user_id: userId,
          account_id: incomeId, amount_minor: -1,
        },
        {
          id: randomUUID(), transaction_id: transactionId, user_id: userId,
          account_id: freeId, amount_minor: 1,
        },
      ]).execute();
    }
  });
}

async function createUser(): Promise<string> {
  const userId = randomUUID();
  await new ProfileService(new ProfileRepository(database()), () => NOW).upsert({
    userId,
    cadence: 'MONTHLY',
    firstPeriodEndsOn: '2026-07-31',
  });
  return userId;
}

async function accountId(userId: string, kind: AccountKind): Promise<string> {
  const account = await database()
    .selectFrom('financial_accounts')
    .select('id')
    .where('user_id', '=', userId)
    .where('kind', '=', kind)
    .executeTakeFirstOrThrow();
  return account.id;
}

async function transactionCount(userId: string, type?: string): Promise<number> {
  let query = database()
    .selectFrom('ledger_transactions')
    .select((expression) => expression.fn.countAll<string>().as('count'))
    .where('user_id', '=', userId);
  if (type) {
    query = query.where('type', '=', type);
  }
  const result = await query.executeTakeFirstOrThrow();
  return Number(result.count);
}

function ledgerService(): LedgerService {
  return new LedgerService(database());
}

function normalizedPostings(
  postings: ReadonlyArray<{ accountId: string; amountMinor: number }>,
): Array<{ accountId: string; amountMinor: number }> {
  return postings
    .map(({ accountId: id, amountMinor }) => ({ accountId: id, amountMinor }))
    .sort((left, right) => left.accountId.localeCompare(right.accountId));
}

function database(): Kysely<Database> {
  if (!context) {
    throw new Error('Database test context was not created');
  }
  return context.db;
}

async function createDatabaseTestContext(): Promise<LedgerDatabaseTestContext> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const db = createDatabase(container.getConnectionUri());
  await migrateToLatest(db);

  return {
    db,
    async reset(): Promise<void> {
      await sql`
        truncate table
          calculation_periods,
          ledger_postings,
          ledger_transactions,
          financial_accounts,
          financial_profiles
        restart identity cascade
      `.execute(db);
    },
    async close(): Promise<void> {
      try {
        await db.destroy();
      } finally {
        await container.stop();
      }
    },
  };
}
