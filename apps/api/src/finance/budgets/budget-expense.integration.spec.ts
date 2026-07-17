import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import { HttpStatus } from '@nestjs/common';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { createDatabase } from '../../database/database.factory';
import type { Database } from '../../database/database.types';
import { migrateToLatest } from '../../database/migrator';
import { CategoryService } from '../expenses/category.service';
import { ExpenseService } from '../expenses/expense.service';
import { LedgerService } from '../ledger/ledger.service';
import { ProfileRepository } from '../profile/profile.repository';
import { ProfileService } from '../profile/profile.service';
import { BudgetService } from './budget.service';

const NOW = new Date('2026-07-17T08:00:00.000Z');

let context: DatabaseTestContext | undefined;

interface DatabaseTestContext {
  db: Kysely<Database>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

beforeAll(async () => { context = await createDatabaseTestContext(); });
beforeEach(async () => { await context?.reset(); });
afterAll(async () => { await context?.close(); });

describe('category budget expenses', () => {
  test('spends a category reserve first and sends only the remainder from FREE', async () => {
    const userId = await createUserWithOpeningBalance(50_000);
    const category = await new CategoryService(database()).create(userId, 'Food');
    const budget = budgetService();
    const plan = await budget.create({
      userId,
      categoryId: category.id,
      amountMinor: 12_000,
      startsOn: '2026-07-17',
      cadence: 'ANNUAL',
    });
    await budget.reconcilePeriod(userId, await currentPeriodId(userId), NOW);

    const expenseService = new ExpenseService(database());
    const first = await expenseService.create({
      userId,
      categoryId: category.id,
      amountMinor: 8_000,
      occurredAt: NOW,
      description: 'Groceries',
    });

    await expect(accountBalance(userId, plan.reserveAccountId)).resolves.toBe(4_000);
    expect(first.remainingCategoryReserveMinor).toBe(4_000);

    const second = await expenseService.create({
      userId,
      categoryId: category.id,
      amountMinor: 6_000,
      occurredAt: new Date('2026-07-18T08:00:00.000Z'),
    });

    await expect(accountBalance(userId, plan.reserveAccountId)).resolves.toBe(0);
    await expect(accountBalance(userId, await systemAccountId(userId, 'FREE')))
      .resolves.toBe(36_000);
    expect(second.transaction.postings).toHaveLength(3);
    expect(second.transaction.postings.reduce(
      (sum, posting) => sum + posting.amountMinor,
      0,
    )).toBe(0);
    expect(second.remainingCategoryReserveMinor).toBe(0);
  });

  test('reconcile is idempotent and expenses consume multiple plans in account UUID order', async () => {
    const userId = await createUserWithOpeningBalance(20_000);
    const category = await new CategoryService(database()).create(userId, 'Food');
    const budget = budgetService();
    const plans = await Promise.all([
      budget.create({
        userId,
        categoryId: category.id,
        amountMinor: 3_000,
        startsOn: '2026-07-17',
        cadence: 'ANNUAL',
      }),
      budget.create({
        userId,
        categoryId: category.id,
        amountMinor: 5_000,
        startsOn: '2026-07-17',
        cadence: 'ANNUAL',
      }),
    ]);
    const periodId = await currentPeriodId(userId);

    await budget.reconcilePeriod(userId, periodId, NOW);
    await budget.reconcilePeriod(userId, periodId, NOW);

    await expect(allocationCount(userId)).resolves.toBe(2);
    await expect(transactionCount(userId, 'BUDGET_RESERVATION')).resolves.toBe(2);

    const ordered = [...plans].sort((left, right) =>
      left.reserveAccountId.localeCompare(right.reserveAccountId));
    const balancesBefore = await Promise.all(ordered.map((plan) =>
      accountBalance(userId, plan.reserveAccountId)));
    const expense = await new ExpenseService(database()).create({
      userId,
      categoryId: category.id,
      amountMinor: 4_000,
      occurredAt: NOW,
    });
    const firstConsumed = Math.min(balancesBefore[0]!, 4_000);

    await expect(accountBalance(userId, ordered[0]!.reserveAccountId))
      .resolves.toBe(balancesBefore[0]! - firstConsumed);
    await expect(accountBalance(userId, ordered[1]!.reserveAccountId))
      .resolves.toBe(balancesBefore[1]! - (4_000 - firstConsumed));
    expect(expense.transaction.postings).toEqual(expect.arrayContaining([
      {
        accountId: ordered[0]!.reserveAccountId,
        amountMinor: -firstConsumed,
        createdAt: expect.any(Date),
        id: expect.any(String),
        transactionId: expense.id,
        userId,
      },
    ]));
  });

  test('category pagination does not lose rows that share a millisecond', async () => {
    const userId = await createUserWithOpeningBalance(1_000);
    await database().transaction().execute(async (trx) => {
      for (let index = 0; index < 51; index += 1) {
        await sql`
          insert into categories (
            id, user_id, name, archived_at, created_at, updated_at
          ) values (
            ${randomUUID()}::uuid,
            ${userId}::uuid,
            ${`Category ${index}`},
            null,
            timestamptz '2026-07-17 08:00:00+00'
              + ${index} * interval '10 microseconds',
            timestamptz '2026-07-17 08:00:00+00'
          )
        `.execute(trx);
      }
    });
    const categories = new CategoryService(database());

    const first = await categories.list(userId);
    const second = await categories.list(userId, first.nextCursor!);

    expect(first.items).toHaveLength(50);
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(51);
  });

  test('supports scoped category and budget CRUD and lists expenses from ledger metadata', async () => {
    const userId = await createUserWithOpeningBalance(10_000);
    const categories = new CategoryService(database());
    const createdCategory = await categories.create(userId, ' Food ');
    const category = await categories.update(userId, createdCategory.id, 'Dining');
    const budget = budgetService();
    const createdPlan = await budget.create({
      userId,
      categoryId: category.id,
      amountMinor: 2_000,
      startsOn: '2026-07-17',
      cadence: 'MONTHLY',
    });
    const updatedPlan = await budget.update(userId, createdPlan.id, {
      amountMinor: 2_500,
      cadence: 'QUARTERLY',
    }, NOW);
    const expenseService = new ExpenseService(database());
    const expense = await expenseService.create({
      userId,
      categoryId: category.id,
      amountMinor: 500,
      occurredAt: NOW,
      description: 'Lunch',
    });

    await expect(budget.get(userId, createdPlan.id)).resolves.toMatchObject({
      amountMinor: 2_500,
      cadence: 'QUARTERLY',
    });
    await expect(budget.list(userId)).resolves.toMatchObject({
      items: [{ id: createdPlan.id }],
    });
    await expect(expenseService.list(userId)).resolves.toMatchObject({
      items: [{ id: expense.id, categoryId: category.id, description: 'Lunch' }],
    });

    await budget.archive(userId, updatedPlan.id);
    await categories.archive(userId, category.id);
    await expect(budget.list(userId)).resolves.toMatchObject({ items: [] });
    await expect(categories.list(userId)).resolves.toMatchObject({ items: [] });
    await expect(budget.get(userId, updatedPlan.id))
      .rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  test('rejects malformed scoped cursors as domain 400 errors', async () => {
    const userId = await createUserWithOpeningBalance(1_000);
    const malformedCursor = Buffer.from(JSON.stringify({
      createdAtMicros: '1784275200000000',
      id: 'not-a-uuid',
    })).toString('base64url');

    await expect(new CategoryService(database()).list(userId, malformedCursor))
      .rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    await expect(budgetService().list(userId, malformedCursor))
      .rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
  });
});

function database(): Kysely<Database> {
  if (!context) {
    throw new Error('Database test context was not created');
  }
  return context.db;
}

function budgetService(): BudgetService {
  return new BudgetService(database());
}

async function createUserWithOpeningBalance(amountMinor: number): Promise<string> {
  const userId = randomUUID();
  await new ProfileService(new ProfileRepository(database()), () => NOW).upsert({
    userId,
    cadence: 'MONTHLY',
    firstPeriodEndsOn: '2026-07-31',
  });
  await new LedgerService(database()).createOpeningBalance(userId, amountMinor, NOW);
  return userId;
}

async function currentPeriodId(userId: string): Promise<string> {
  const period = await database().selectFrom('calculation_periods')
    .select('id')
    .where('user_id', '=', userId)
    .where('status', '=', 'OPEN')
    .executeTakeFirstOrThrow();
  return period.id;
}

async function systemAccountId(userId: string, kind: 'FREE'): Promise<string> {
  const account = await database().selectFrom('financial_accounts')
    .select('id')
    .where('user_id', '=', userId)
    .where('kind', '=', kind)
    .executeTakeFirstOrThrow();
  return account.id;
}

async function accountBalance(userId: string, accountId: string): Promise<number> {
  return new LedgerService(database()).getAccountBalance(userId, accountId);
}

async function allocationCount(userId: string): Promise<number> {
  const result = await database().selectFrom('budget_allocations')
    .select((expression) => expression.fn.countAll<string>().as('count'))
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  return Number(result.count);
}

async function transactionCount(userId: string, type: string): Promise<number> {
  const result = await database().selectFrom('ledger_transactions')
    .select((expression) => expression.fn.countAll<string>().as('count'))
    .where('user_id', '=', userId)
    .where('type', '=', type)
    .executeTakeFirstOrThrow();
  return Number(result.count);
}

async function createDatabaseTestContext(): Promise<DatabaseTestContext> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const db = createDatabase(container.getConnectionUri());
  await migrateToLatest(db);

  return {
    db,
    async reset(): Promise<void> {
      await sql`
        truncate table
          idempotency_records,
          settlement_offers,
          budget_allocations,
          budget_plans,
          schedule_occurrences,
          obligation_schedules,
          income_schedules,
          categories,
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
