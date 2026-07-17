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
const BUDGET_UPDATE_LOCK_KEY = 41_004;
const CATEGORY_ARCHIVE_LOCK_KEY = 41_005;
const REVERSAL_INSERT_LOCK_KEY = 41_006;
const ORDERED_SINK_ID = '00000000-0000-4000-8000-000000000001';
const ORDERED_FREE_ID = '00000000-0000-4000-8000-000000000002';
const ORDERED_RESERVE_ID = '00000000-0000-4000-8000-000000000003';

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

  test('locks the complete expense posting set before a concurrent posting can invert account order', async () => {
    const userId = await createUserWithoutOpeningBalance();
    const category = await new CategoryService(database()).create(userId, 'Food');
    const budget = budgetService();
    const plan = await budget.create({
      userId,
      categoryId: category.id,
      amountMinor: 500,
      startsOn: '2026-07-17',
      cadence: 'ANNUAL',
    });
    await setAccountId(userId, 'EXPENSE_SINK', ORDERED_SINK_ID);
    await setAccountId(userId, 'FREE', ORDERED_FREE_ID);
    await setAccountId(userId, 'BUDGET_RESERVE', ORDERED_RESERVE_ID, plan.id);
    await new LedgerService(database()).createOpeningBalance(userId, 1_000, NOW);
    await budget.reconcilePeriod(userId, await currentPeriodId(userId), NOW);
    const blocker = await holdAccountLock(userId, ORDERED_RESERVE_ID);
    const concurrent: Promise<unknown>[] = [];

    try {
      const expense = new ExpenseService(database()).create({
        userId,
        categoryId: category.id,
        amountMinor: 100,
        occurredAt: NOW,
      });
      concurrent.push(expense);
      await waitForBlockedQueryCount('from "financial_accounts"', 1);
      const directPosting = new LedgerService(database()).post({
        userId,
        type: 'BUDGET_RESERVATION',
        effectiveAt: NOW,
        postings: [
          { accountId: ORDERED_SINK_ID, amountMinor: -1 },
          { accountId: ORDERED_RESERVE_ID, amountMinor: 1 },
        ],
      });
      concurrent.push(directPosting);
      await waitForBlockedQueryCount('from "financial_accounts"', 2);
      blocker.release();
      await blocker.done;

      await expect(Promise.all(concurrent)).resolves.toHaveLength(2);
    } finally {
      blocker.release();
      await blocker.done;
      await Promise.allSettled(concurrent);
    }

    await expect(accountBalance(userId, ORDERED_RESERVE_ID)).resolves.toBe(401);
    await expect(transactionCount(userId, 'ORDINARY_EXPENSE')).resolves.toBe(1);
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

  test('archives a plan by releasing its positive reserve to FREE and preserving allocation history', async () => {
    const userId = await createUserWithOpeningBalance(20_000);
    const category = await new CategoryService(database()).create(userId, 'Food');
    const budget = budgetService();
    const plan = await budget.create({
      userId,
      categoryId: category.id,
      amountMinor: 7_000,
      startsOn: '2026-07-17',
      cadence: 'ANNUAL',
    });
    await budget.reconcilePeriod(userId, await currentPeriodId(userId), NOW);
    const allocationBefore = await database().selectFrom('budget_allocations')
      .selectAll()
      .where('user_id', '=', userId)
      .where('budget_plan_id', '=', plan.id)
      .executeTakeFirstOrThrow();

    await budget.archive(userId, plan.id);

    await expect(accountBalance(userId, await systemAccountId(userId, 'FREE')))
      .resolves.toBe(20_000);
    await expect(accountBalance(userId, plan.reserveAccountId)).resolves.toBe(0);
    const release = await ledgerTransaction(userId, 'BUDGET_RELEASE', plan.id);
    expect(release.postings).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: plan.reserveAccountId, amountMinor: -7_000 }),
      expect.objectContaining({
        accountId: await systemAccountId(userId, 'FREE'),
        amountMinor: 7_000,
      }),
    ]));
    await expect(database().selectFrom('financial_accounts')
      .select('archived_at')
      .where('user_id', '=', userId)
      .where('id', '=', plan.reserveAccountId)
      .executeTakeFirstOrThrow()).resolves.toMatchObject({ archived_at: expect.any(Date) });
    await expect(database().selectFrom('budget_allocations')
      .selectAll()
      .where('user_id', '=', userId)
      .where('id', '=', allocationBefore.id)
      .executeTakeFirstOrThrow()).resolves.toEqual(allocationBefore);
  });

  test('rejects direct postings to an archived budget reserve', async () => {
    const userId = await createUserWithOpeningBalance(20_000);
    const category = await new CategoryService(database()).create(userId, 'Food');
    const budget = budgetService();
    const plan = await budget.create({
      userId,
      categoryId: category.id,
      amountMinor: 5_000,
      startsOn: '2026-07-17',
      cadence: 'ANNUAL',
    });
    await budget.reconcilePeriod(userId, await currentPeriodId(userId), NOW);
    await budget.archive(userId, plan.id);
    const transactionCountBefore = await transactionCount(userId, 'BUDGET_RESERVATION');

    await expect(new LedgerService(database()).post({
      userId,
      type: 'BUDGET_RESERVATION',
      effectiveAt: NOW,
      postings: [
        { accountId: await expenseSinkAccountId(userId), amountMinor: -100 },
        { accountId: plan.reserveAccountId, amountMinor: 100 },
      ],
    })).rejects.toMatchObject({ status: HttpStatus.CONFLICT });

    await expect(accountBalance(userId, plan.reserveAccountId)).resolves.toBe(0);
    await expect(transactionCount(userId, 'BUDGET_RESERVATION'))
      .resolves.toBe(transactionCountBefore);
  });

  test('rejects reversal of a budget release after its reserve was archived', async () => {
    const userId = await createUserWithOpeningBalance(20_000);
    const category = await new CategoryService(database()).create(userId, 'Food');
    const budget = budgetService();
    const plan = await budget.create({
      userId,
      categoryId: category.id,
      amountMinor: 5_000,
      startsOn: '2026-07-17',
      cadence: 'ANNUAL',
    });
    await budget.reconcilePeriod(userId, await currentPeriodId(userId), NOW);
    await budget.archive(userId, plan.id);
    const release = await ledgerTransaction(userId, 'BUDGET_RELEASE', plan.id);
    const freeId = await systemAccountId(userId, 'FREE');
    const transactionCountBefore = await allTransactionCount(userId);

    await expect(new LedgerService(database()).reverse(userId, release.id, NOW))
      .rejects.toMatchObject({ status: HttpStatus.CONFLICT });

    await expect(accountBalance(userId, freeId)).resolves.toBe(20_000);
    await expect(accountBalance(userId, plan.reserveAccountId)).resolves.toBe(0);
    await expect(allTransactionCount(userId)).resolves.toBe(transactionCountBefore);
  });

  test('serializes reversal before archive and releases the restored reserve without stranding value', async () => {
    const userId = await createUserWithOpeningBalance(20_000);
    const category = await new CategoryService(database()).create(userId, 'Food');
    const budget = budgetService();
    const plan = await budget.create({
      userId,
      categoryId: category.id,
      amountMinor: 5_000,
      startsOn: '2026-07-17',
      cadence: 'ANNUAL',
    });
    await budget.reconcilePeriod(userId, await currentPeriodId(userId), NOW);
    const expense = await new ExpenseService(database()).create({
      userId,
      categoryId: category.id,
      amountMinor: 2_000,
      occurredAt: NOW,
    });
    const blocker = await holdAdvisoryLock(REVERSAL_INSERT_LOCK_KEY);

    try {
      await installReversalInsertWaitTrigger();
      const reversal = new LedgerService(database()).reverse(userId, expense.id, NOW);
      await waitForBlockedQuery('insert into "ledger_transactions"');
      const archive = budget.archive(userId, plan.id);
      await expect(settlementState(archive)).resolves.toBe('blocked');
      blocker.release();
      await blocker.done;
      await Promise.all([reversal, archive]);
    } finally {
      blocker.release();
      await blocker.done;
      await removeReversalInsertWaitTrigger();
    }

    await expect(accountBalance(userId, await systemAccountId(userId, 'FREE')))
      .resolves.toBe(20_000);
    await expect(accountBalance(userId, plan.reserveAccountId)).resolves.toBe(0);
    await expect(database().selectFrom('financial_accounts')
      .select('archived_at')
      .where('user_id', '=', userId)
      .where('id', '=', plan.reserveAccountId)
      .executeTakeFirstOrThrow()).resolves.toMatchObject({ archived_at: expect.any(Date) });
  });

  test('rejects a posting whose prospective budget reserve balance exceeds the safe range', async () => {
    const userId = await createUserWithOpeningBalance(1_000);
    const category = await new CategoryService(database()).create(userId, 'Food');
    const plan = await budgetService().create({
      userId,
      categoryId: category.id,
      amountMinor: 1,
      startsOn: '2026-07-17',
      cadence: 'ANNUAL',
    });
    const sinkId = await expenseSinkAccountId(userId);
    const ledger = new LedgerService(database());
    await ledger.post({
      userId,
      type: 'BUDGET_RESERVATION',
      effectiveAt: NOW,
      postings: [
        { accountId: sinkId, amountMinor: -Number.MAX_SAFE_INTEGER },
        { accountId: plan.reserveAccountId, amountMinor: Number.MAX_SAFE_INTEGER },
      ],
    });

    await expect(ledger.post({
      userId,
      type: 'BUDGET_RESERVATION',
      effectiveAt: NOW,
      postings: [
        { accountId: sinkId, amountMinor: -1 },
        { accountId: plan.reserveAccountId, amountMinor: 1 },
      ],
    })).rejects.toMatchObject({ status: HttpStatus.CONFLICT });

    await expect(accountBalance(userId, plan.reserveAccountId))
      .resolves.toBe(Number.MAX_SAFE_INTEGER);
  });

  test('archives a category by releasing and archiving every active plan atomically', async () => {
    const userId = await createUserWithOpeningBalance(30_000);
    const categories = new CategoryService(database());
    const category = await categories.create(userId, 'Food');
    const budget = budgetService();
    const plans = await Promise.all([4_000, 6_000].map((amountMinor) => budget.create({
      userId,
      categoryId: category.id,
      amountMinor,
      startsOn: '2026-07-17',
      cadence: 'ANNUAL',
    })));
    await budget.reconcilePeriod(userId, await currentPeriodId(userId), NOW);
    const expense = await new ExpenseService(database()).create({
      userId,
      categoryId: category.id,
      amountMinor: 1_000,
      occurredAt: NOW,
      description: 'Historical category expense',
    });

    await categories.archive(userId, category.id);

    await expect(accountBalance(userId, await systemAccountId(userId, 'FREE')))
      .resolves.toBe(29_000);
    await expect(transactionCount(userId, 'BUDGET_RELEASE')).resolves.toBe(2);
    const archivedPlans = await database().selectFrom('budget_plans')
      .select(['id', 'archived_at'])
      .where('user_id', '=', userId)
      .where('category_id', '=', category.id)
      .orderBy('id')
      .execute();
    expect(archivedPlans).toHaveLength(2);
    expect(archivedPlans.every(({ archived_at }) => archived_at instanceof Date)).toBe(true);
    const archivedAccounts = await database().selectFrom('financial_accounts')
      .select(['id', 'archived_at'])
      .where('user_id', '=', userId)
      .where('id', 'in', plans.map(({ reserveAccountId }) => reserveAccountId))
      .execute();
    expect(archivedAccounts.every(({ archived_at }) => archived_at instanceof Date)).toBe(true);
    await expect(new ExpenseService(database()).list(userId)).resolves.toMatchObject({
      items: [{
        id: expense.id,
        categoryId: category.id,
        description: 'Historical category expense',
      }],
    });
  });

  test('rolls back the release and all archives when category archival fails', async () => {
    const userId = await createUserWithOpeningBalance(20_000);
    const categories = new CategoryService(database());
    const category = await categories.create(userId, 'Food');
    const budget = budgetService();
    const plan = await budget.create({
      userId,
      categoryId: category.id,
      amountMinor: 5_000,
      startsOn: '2026-07-17',
      cadence: 'ANNUAL',
    });
    await budget.reconcilePeriod(userId, await currentPeriodId(userId), NOW);

    try {
      await installArchiveFailureTrigger();
      await expect(categories.archive(userId, category.id)).rejects.toThrow('induced archive failure');
    } finally {
      await removeArchiveFailureTrigger();
    }

    await expect(transactionCount(userId, 'BUDGET_RELEASE')).resolves.toBe(0);
    await expect(accountBalance(userId, plan.reserveAccountId)).resolves.toBe(5_000);
    await expect(database().selectFrom('categories')
      .select('archived_at')
      .where('user_id', '=', userId)
      .where('id', '=', category.id)
      .executeTakeFirstOrThrow()).resolves.toEqual({ archived_at: null });
    await expect(database().selectFrom('budget_plans')
      .select('archived_at')
      .where('user_id', '=', userId)
      .where('id', '=', plan.id)
      .executeTakeFirstOrThrow()).resolves.toEqual({ archived_at: null });
  });

  test('serializes a budget update before reconcile reads the plan rule', async () => {
    const userId = await createUserWithOpeningBalance(20_000);
    const category = await new CategoryService(database()).create(userId, 'Food');
    const budget = budgetService();
    const plan = await budget.create({
      userId,
      categoryId: category.id,
      amountMinor: 3_000,
      startsOn: '2026-07-17',
      cadence: 'ANNUAL',
    });
    const blocker = await holdAdvisoryLock(BUDGET_UPDATE_LOCK_KEY);

    try {
      await installBudgetUpdateWaitTrigger();
      const update = budget.update(userId, plan.id, { amountMinor: 8_000 }, NOW);
      await waitForBlockedQuery('update "budget_plans"');
      const reconcile = budget.reconcilePeriod(userId, await currentPeriodId(userId), NOW);
      await expect(settlementState(reconcile)).resolves.toBe('blocked');
      blocker.release();
      await blocker.done;
      await Promise.all([update, reconcile]);
    } finally {
      blocker.release();
      await blocker.done;
      await removeBudgetUpdateWaitTrigger();
    }

    await expect(accountBalance(userId, plan.reserveAccountId)).resolves.toBe(8_000);
  });

  test('serializes category archive before reconcile re-checks active category and plan state', async () => {
    const userId = await createUserWithOpeningBalance(20_000);
    const categories = new CategoryService(database());
    const category = await categories.create(userId, 'Food');
    const budget = budgetService();
    await budget.create({
      userId,
      categoryId: category.id,
      amountMinor: 5_000,
      startsOn: '2026-07-17',
      cadence: 'ANNUAL',
    });
    const blocker = await holdAdvisoryLock(CATEGORY_ARCHIVE_LOCK_KEY);

    try {
      await installCategoryArchiveWaitTrigger();
      const archive = categories.archive(userId, category.id);
      await waitForBlockedQuery('update "categories"');
      const reconcile = budget.reconcilePeriod(userId, await currentPeriodId(userId), NOW);
      await expect(settlementState(reconcile)).resolves.toBe('blocked');
      blocker.release();
      await blocker.done;
      await Promise.all([archive, reconcile]);
    } finally {
      blocker.release();
      await blocker.done;
      await removeCategoryArchiveWaitTrigger();
    }

    await expect(allocationCount(userId)).resolves.toBe(0);
    await expect(transactionCount(userId, 'BUDGET_RESERVATION')).resolves.toBe(0);
  });

  test('rejects an unsafe aggregate category reserve without writing expense metadata', async () => {
    const userId = await createUserWithOpeningBalance(1_000);
    const category = await new CategoryService(database()).create(userId, 'Food');
    const budget = budgetService();
    const plans = await Promise.all([1, 2].map(() => budget.create({
      userId,
      categoryId: category.id,
      amountMinor: 1,
      startsOn: '2026-07-17',
      cadence: 'ANNUAL',
    })));
    const sinkId = await expenseSinkAccountId(userId);
    for (const plan of plans) {
      await new LedgerService(database()).post({
        userId,
        type: 'BUDGET_RESERVATION',
        effectiveAt: NOW,
        postings: [
          { accountId: sinkId, amountMinor: -Number.MAX_SAFE_INTEGER },
          { accountId: plan.reserveAccountId, amountMinor: Number.MAX_SAFE_INTEGER },
        ],
      });
    }

    await expect(new ExpenseService(database()).create({
      userId,
      categoryId: category.id,
      amountMinor: 1,
      occurredAt: NOW,
    })).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    await expect(transactionCount(userId, 'ORDINARY_EXPENSE')).resolves.toBe(0);
  });

  test('filters expense posting reads by user even for already-scoped transaction ids', async () => {
    const userId = await createUserWithOpeningBalance(1_000);
    const category = await new CategoryService(database()).create(userId, 'Food');
    const expenseService = new ExpenseService(database());
    const expense = await expenseService.create({
      userId,
      categoryId: category.id,
      amountMinor: 100,
      occurredAt: NOW,
    });
    const foreignUserId = randomUUID();
    const sinkId = await expenseSinkAccountId(userId);
    const freeId = await systemAccountId(userId, 'FREE');
    await database().insertInto('ledger_postings').values([
      {
        id: randomUUID(),
        transaction_id: expense.id,
        user_id: foreignUserId,
        account_id: sinkId,
        amount_minor: 77,
      },
      {
        id: randomUUID(),
        transaction_id: expense.id,
        user_id: foreignUserId,
        account_id: freeId,
        amount_minor: -77,
      },
    ]).execute();

    const [listed] = (await expenseService.list(userId)).items;

    expect(listed?.amountMinor).toBe(100);
    expect(listed?.transaction.postings).toHaveLength(2);
    expect(listed?.transaction.postings.every((posting) => posting.userId === userId)).toBe(true);
    const ledgerExpense = (await new LedgerService(database()).list(userId)).items
      .find(({ id }) => id === expense.id);
    expect(ledgerExpense?.postings).toHaveLength(2);
    expect(ledgerExpense?.postings.every((posting) => posting.userId === userId)).toBe(true);
  });

  test('rejects malformed category, budget and expense cursors with one domain error', async () => {
    const userId = await createUserWithOpeningBalance(1_000);
    const malformedCursor = Buffer.from(JSON.stringify({
      createdAtMicros: '1784275200000000',
      id: 'not-a-uuid',
    })).toString('base64url');

    const services = [
      new CategoryService(database()),
      budgetService(),
      new ExpenseService(database()),
    ];
    for (const service of services) {
      await expect(service.list(userId, malformedCursor))
        .rejects.toMatchObject({
          status: HttpStatus.BAD_REQUEST,
          response: { message: 'Invalid cursor' },
        });
    }
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
  const userId = await createUserWithoutOpeningBalance();
  await new LedgerService(database()).createOpeningBalance(userId, amountMinor, NOW);
  return userId;
}

async function createUserWithoutOpeningBalance(): Promise<string> {
  const userId = randomUUID();
  await new ProfileService(new ProfileRepository(database()), () => NOW).upsert({
    userId,
    cadence: 'MONTHLY',
    firstPeriodEndsOn: '2026-07-31',
  });
  return userId;
}

async function setAccountId(
  userId: string,
  kind: 'FREE' | 'EXPENSE_SINK' | 'BUDGET_RESERVE',
  id: string,
  referenceId?: string,
): Promise<void> {
  let query = database().updateTable('financial_accounts')
    .set({ id })
    .where('user_id', '=', userId)
    .where('kind', '=', kind);
  if (referenceId) {
    query = query.where('reference_id', '=', referenceId);
  }
  const result = await query.executeTakeFirst();
  expect(Number(result.numUpdatedRows)).toBe(1);
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

async function allTransactionCount(userId: string): Promise<number> {
  const result = await database().selectFrom('ledger_transactions')
    .select((expression) => expression.fn.countAll<string>().as('count'))
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  return Number(result.count);
}

async function ledgerTransaction(
  userId: string,
  type: string,
  budgetPlanId: string,
) {
  const transactions = (await new LedgerService(database()).list(userId)).items;
  const transaction = transactions.find((item) =>
    item.type === type && item.metadata.budgetPlanId === budgetPlanId);
  if (!transaction) {
    throw new Error(`${type} ledger transaction not found`);
  }
  return transaction;
}

async function expenseSinkAccountId(userId: string): Promise<string> {
  const account = await database().selectFrom('financial_accounts')
    .select('id')
    .where('user_id', '=', userId)
    .where('kind', '=', 'EXPENSE_SINK')
    .executeTakeFirstOrThrow();
  return account.id;
}

interface AdvisoryLockBlocker {
  release(): void;
  done: Promise<void>;
}

async function holdAccountLock(userId: string, accountId: string): Promise<AdvisoryLockBlocker> {
  let markReady!: () => void;
  let releaseLock!: () => void;
  let released = false;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const release = new Promise<void>((resolve) => { releaseLock = resolve; });
  const done = database().transaction().execute(async (trx) => {
    await trx.selectFrom('financial_accounts')
      .select('id')
      .where('user_id', '=', userId)
      .where('id', '=', accountId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    markReady();
    await release;
  });
  await ready;
  return {
    release(): void {
      if (!released) {
        released = true;
        releaseLock();
      }
    },
    done,
  };
}

async function holdAdvisoryLock(key: number): Promise<AdvisoryLockBlocker> {
  let markReady!: () => void;
  let releaseLock!: () => void;
  let released = false;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const release = new Promise<void>((resolve) => { releaseLock = resolve; });
  const done = database().transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(${key})`.execute(trx);
    markReady();
    await release;
  });
  await ready;
  return {
    release(): void {
      if (!released) {
        released = true;
        releaseLock();
      }
    },
    done,
  };
}

async function settlementState(promise: Promise<unknown>): Promise<'completed' | 'blocked'> {
  return Promise.race([
    promise.then(() => 'completed' as const),
    new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 200)),
  ]);
}

async function waitForBlockedQuery(fragment: string): Promise<void> {
  await waitForBlockedQueryCount(fragment, 1);
}

async function waitForBlockedQueryCount(fragment: string, expectedCount: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await sql<{ count: string }>`
      select count(*)::text as count
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and query like ${`%${fragment}%`}
    `.execute(database());
    if (Number(result.rows[0]?.count ?? 0) >= expectedCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expectedCount} blocked queries: ${fragment}`);
}

async function installBudgetUpdateWaitTrigger(): Promise<void> {
  await sql`
    create function task4_wait_for_budget_update() returns trigger as $$
    begin
      perform pg_advisory_xact_lock(41004);
      return new;
    end;
    $$ language plpgsql;
    create trigger task4_wait_for_budget_update
      before update on budget_plans
      for each row execute function task4_wait_for_budget_update()
  `.execute(database());
}

async function removeBudgetUpdateWaitTrigger(): Promise<void> {
  await sql`
    drop trigger if exists task4_wait_for_budget_update on budget_plans;
    drop function if exists task4_wait_for_budget_update()
  `.execute(database());
}

async function installCategoryArchiveWaitTrigger(): Promise<void> {
  await sql`
    create function task4_wait_for_category_archive() returns trigger as $$
    begin
      perform pg_advisory_xact_lock(41005);
      return new;
    end;
    $$ language plpgsql;
    create trigger task4_wait_for_category_archive
      before update on categories
      for each row execute function task4_wait_for_category_archive()
  `.execute(database());
}

async function removeCategoryArchiveWaitTrigger(): Promise<void> {
  await sql`
    drop trigger if exists task4_wait_for_category_archive on categories;
    drop function if exists task4_wait_for_category_archive()
  `.execute(database());
}

async function installReversalInsertWaitTrigger(): Promise<void> {
  await sql`
    create function task4_wait_for_reversal_insert() returns trigger as $$
    begin
      if new.type = 'REVERSAL' then
        perform pg_advisory_xact_lock(41006);
      end if;
      return new;
    end;
    $$ language plpgsql;
    create trigger task4_wait_for_reversal_insert
      before insert on ledger_transactions
      for each row execute function task4_wait_for_reversal_insert()
  `.execute(database());
}

async function removeReversalInsertWaitTrigger(): Promise<void> {
  await sql`
    drop trigger if exists task4_wait_for_reversal_insert on ledger_transactions;
    drop function if exists task4_wait_for_reversal_insert()
  `.execute(database());
}

async function installArchiveFailureTrigger(): Promise<void> {
  await sql`
    create function task4_fail_budget_account_archive() returns trigger as $$
    begin
      if new.kind = 'BUDGET_RESERVE' and new.archived_at is not null then
        raise exception 'induced archive failure';
      end if;
      return new;
    end;
    $$ language plpgsql;
    create trigger task4_fail_budget_account_archive
      before update on financial_accounts
      for each row execute function task4_fail_budget_account_archive()
  `.execute(database());
}

async function removeArchiveFailureTrigger(): Promise<void> {
  await sql`
    drop trigger if exists task4_fail_budget_account_archive on financial_accounts;
    drop function if exists task4_fail_budget_account_archive()
  `.execute(database());
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
