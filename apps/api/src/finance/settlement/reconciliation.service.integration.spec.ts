import { randomUUID } from 'node:crypto';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { Database } from '../../database/database.types';
import { BudgetService } from '../budgets/budget.service';
import { CategoryService } from '../expenses/category.service';
import { IncomeService } from '../income/income.service';
import { ObligationService } from '../obligations/obligation.service';
import { ProfileRepository } from '../profile/profile.repository';
import { ProfileService } from '../profile/profile.service';
import {
  createFinanceDatabaseTestContext,
  type FinanceDatabaseTestContext,
} from '../test/database-test-context';
import {
  type PeriodCloser,
  ReconciliationService,
} from './reconciliation.service';
import { SettlementService } from './settlement.service';

const PROFILE_NOW = new Date('2026-01-01T09:00:00.000Z');
const RECONCILE_AT = new Date('2026-01-15T12:00:00.000Z');

let context: FinanceDatabaseTestContext | undefined;

beforeAll(async () => { context = await createFinanceDatabaseTestContext(); });
beforeEach(async () => { await context?.reset(); });
afterAll(async () => { await context?.close(); });

describe('ReconciliationService', () => {
  test('rejects an invalid reconciliation timestamp as a bad request', async () => {
    const service = reconciliationService({ async closeDuePeriods() {} });
    await expect(service.reconcileUser(randomUUID(), new Date('invalid')))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  test('runs the exact orchestration order and invokes the closer in the same transaction', async () => {
    const userId = await createProfile();
    const calls: string[] = [];
    const budgets = {
      async reconcileOpenPeriods(actualUserId: string, now: Date, trx: Transaction<Database>) {
        expect(actualUserId).toBe(userId);
        expect(now).toEqual(RECONCILE_AT);
        expect(await openPeriodCount(actualUserId, trx)).toBe(1);
        calls.push('budgets');
      },
    } as unknown as BudgetService;
    const obligations = {
      async reserveOpenPeriods() { calls.push('obligation-reserve'); },
      async applyDue() { calls.push('obligation-apply'); },
    } as unknown as ObligationService;
    const incomes = {
      async materializeAndApplyDue() { calls.push('income'); },
    } as unknown as IncomeService;
    const closer: PeriodCloser = {
      async closeDuePeriods(_userId, _now, trx) {
        expect(trx).toBeDefined();
        calls.push('closer');
      },
    };

    await new ReconciliationService(database(), budgets, obligations, incomes, closer)
      .reconcileUser(userId, RECONCILE_AT);

    expect(calls).toEqual([
      'budgets', 'obligation-reserve', 'income', 'obligation-apply', 'closer',
    ]);
  });

  test('stops after one effect pass when a no-op closer leaves the same due period', async () => {
    const userId = await createWeeklyProfile();
    const calls: string[] = [];
    const budgets = { async reconcileOpenPeriods() { calls.push('budget'); } } as unknown as BudgetService;
    const obligations = {
      async reserveOpenPeriods() { calls.push('reserve'); },
      async applyDue() { calls.push('obligation'); },
    } as unknown as ObligationService;
    const incomes = { async materializeAndApplyDue() { calls.push('income'); } } as unknown as IncomeService;
    const closer = { async closeDuePeriods() { calls.push('close'); } };

    await new ReconciliationService(database(), budgets, obligations, incomes, closer)
      .reconcileUser(userId, new Date('2026-01-25T12:00:00Z'));

    expect(calls).toEqual(['budget', 'reserve', 'income', 'obligation', 'close']);
  });

  test('catches up every overdue period through the full effect order before stopping on current', async () => {
    const userId = await createWeeklyProfile();
    const category = await new CategoryService(database()).create(userId, 'Weekly food');
    const budget = await new BudgetService(database()).create({
      userId, categoryId: category.id, amountMinor: 1_000,
      startsOn: '2026-01-01', cadence: 'WEEKLY',
    });
    await database().updateTable('budget_plans').set({
      created_at: PROFILE_NOW, updated_at: PROFILE_NOW,
    }).where('user_id', '=', userId).where('id', '=', budget.id).execute();
    await new IncomeService(database()).createSchedule({
      userId, amountMinor: 10_000, startsOn: '2026-01-03',
      cadence: 'WEEKLY', name: 'Weekly income',
    });

    const budgets = new BudgetService(database());
    const service = new ReconciliationService(
      database(), budgets, new ObligationService(database()), new IncomeService(database()),
      new SettlementService(database(), budgets),
    );
    await service.reconcileUser(userId, new Date('2026-01-25T12:00:00Z'));

    expect(await count('calculation_periods', userId, (query) => query.where('status', '=', 'CLOSED')))
      .toBe(4);
    expect(await openPeriodCount(userId)).toBe(1);
    expect(await occurrenceCount(userId, 'INCOME')).toBe(4);
    expect(await transactionCount(userId, 'INCOME')).toBe(4);
    const allocationPeriods = await database().selectFrom('budget_allocations')
      .select('period_id').distinct().where('user_id', '=', userId).execute();
    expect(allocationPeriods).toHaveLength(5);
  });

  test('rolls back all domain effects when the period closer fails', async () => {
    const fixture = await createFinanceFixture();
    const before = await financialCounts(fixture.userId);
    const closer: PeriodCloser = {
      async closeDuePeriods() { throw new Error('injected closer failure'); },
    };
    const service = reconciliationService(closer);

    await expect(service.reconcileUser(fixture.userId, RECONCILE_AT))
      .rejects.toThrow('injected closer failure');

    expect(await financialCounts(fixture.userId)).toEqual(before);
  });

  test('two concurrent reconciliations serialize without duplicate financial effects', async () => {
    const fixture = await createFinanceFixture();
    const closerCalls: string[] = [];
    const closer: PeriodCloser = {
      async closeDuePeriods(userId) { closerCalls.push(userId); },
    };
    const service = reconciliationService(closer);

    await Promise.all([
      service.reconcileUser(fixture.userId, RECONCILE_AT),
      service.reconcileUser(fixture.userId, RECONCILE_AT),
    ]);

    const counts = await financialCounts(fixture.userId);
    expect(counts).toMatchObject({
      openPeriods: 1,
      budgetAllocations: 1,
      incomeOccurrences: 1,
      incomeTransactions: 1,
      obligationOccurrences: 1,
      obligationReservations: 1,
      obligationPayments: 1,
    });
    expect(closerCalls).toEqual([fixture.userId, fixture.userId]);
  });

  test('serializes a category and budget creation chain behind the reconciliation profile prefix', async () => {
    const userId = await createProfile();
    const enteredCloser = deferred<void>();
    const releaseCloser = deferred<void>();
    const noOpBudgets = { async reconcileOpenPeriods() {} } as unknown as BudgetService;
    const noOpObligations = {
      async reserveOpenPeriods() {}, async applyDue() {},
    } as unknown as ObligationService;
    const noOpIncomes = { async materializeAndApplyDue() {} } as unknown as IncomeService;
    const closer: PeriodCloser = {
      async closeDuePeriods() {
        enteredCloser.resolve();
        await releaseCloser.promise;
      },
    };
    const reconciliation = new ReconciliationService(
      database(), noOpBudgets, noOpObligations, noOpIncomes, closer,
    ).reconcileUser(userId, RECONCILE_AT);
    let creation: Promise<unknown> | undefined;
    try {
      await Promise.race([
        enteredCloser.promise,
        reconciliation.then(
          () => Promise.reject(new Error('Reconciliation finished before the closer barrier')),
          (error: unknown) => Promise.reject(error),
        ),
      ]);
      creation = new CategoryService(database()).create(userId, 'Late category')
        .then((category) => new BudgetService(database()).create({
          userId,
          categoryId: category.id,
          amountMinor: 1_000,
          startsOn: '2026-01-20',
          cadence: 'MONTHLY',
        }));
      await waitForBlockedProfileLock();
      expect(await categoryCount(userId)).toBe(0);
    } finally {
      releaseCloser.resolve();
      await Promise.allSettled([
        reconciliation,
        ...(creation ? [creation] : []),
      ]);
    }

    expect(creation).toBeDefined();
    await expect(Promise.all([reconciliation, creation])).resolves.toHaveLength(2);
    expect(await countFinancialAccounts(userId, 'BUDGET_RESERVE')).toBe(1);
  });

  test('category and budget creators hide a missing financial profile with 404', async () => {
    const missingUserId = randomUUID();
    await expect(new CategoryService(database()).create(missingUserId, 'Orphan'))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(await categoryCount(missingUserId)).toBe(0);

    const categoryId = randomUUID();
    await database().insertInto('categories').values({
      id: categoryId,
      user_id: missingUserId,
      name: 'Forged orphan',
      archived_at: null,
    }).execute();
    await expect(new BudgetService(database()).create({
      userId: missingUserId,
      categoryId,
      amountMinor: 1_000,
      startsOn: '2026-01-20',
      cadence: 'MONTHLY',
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(await countFinancialAccounts(missingUserId, 'BUDGET_RESERVE')).toBe(0);
  });
});

function reconciliationService(closer: PeriodCloser): ReconciliationService {
  return new ReconciliationService(
    database(),
    new BudgetService(database()),
    new ObligationService(database()),
    new IncomeService(database()),
    closer,
  );
}

async function createFinanceFixture(): Promise<{ userId: string }> {
  const userId = await createProfile();
  const category = await new CategoryService(database()).create(userId, 'Food');
  const budget = await new BudgetService(database()).create({
    userId,
    categoryId: category.id,
    amountMinor: 20_000,
    startsOn: '2026-01-01',
    cadence: 'MONTHLY',
  });
  await database().updateTable('budget_plans').set({
    created_at: PROFILE_NOW,
    updated_at: PROFILE_NOW,
  }).where('user_id', '=', userId).where('id', '=', budget.id).execute();
  await new IncomeService(database()).createSchedule({
    userId,
    amountMinor: 100_000,
    startsOn: '2026-01-15',
    cadence: 'MONTHLY',
    name: 'Salary',
  });
  await new ObligationService(database(), () => PROFILE_NOW).create({
    userId,
    amountMinor: 30_000,
    startsOn: '2026-01-15',
    cadence: 'MONTHLY',
    name: 'Rent',
  });
  return { userId };
}

async function createProfile(): Promise<string> {
  const userId = randomUUID();
  await new ProfileService(new ProfileRepository(database()), () => PROFILE_NOW).upsert({
    userId,
    timezone: 'Europe/Moscow',
    cadence: 'MONTHLY',
    firstPeriodEndsOn: '2026-01-31',
  });
  return userId;
}

async function createWeeklyProfile(): Promise<string> {
  const userId = randomUUID();
  await new ProfileService(new ProfileRepository(database()), () => PROFILE_NOW).upsert({
    userId,
    timezone: 'Europe/Moscow',
    cadence: 'WEEKLY',
    firstPeriodEndsOn: '2026-01-02',
  });
  return userId;
}

async function openPeriodCount(
  userId: string,
  executor: Kysely<Database> | Transaction<Database> = database(),
): Promise<number> {
  const row = await executor.selectFrom('calculation_periods')
    .select(sql<string>`count(*)`.as('count')).where('user_id', '=', userId)
    .where('status', '=', 'OPEN').executeTakeFirstOrThrow();
  return Number(row.count);
}

async function financialCounts(userId: string) {
  const rows = await Promise.all([
    count('calculation_periods', userId, (query) => query.where('status', '=', 'OPEN')),
    count('budget_allocations', userId),
    occurrenceCount(userId, 'INCOME'),
    transactionCount(userId, 'INCOME'),
    occurrenceCount(userId, 'OBLIGATION'),
    transactionCount(userId, 'OBLIGATION_RESERVATION'),
    transactionCount(userId, 'OBLIGATION_PAYMENT'),
  ]);
  return {
    openPeriods: rows[0], budgetAllocations: rows[1], incomeOccurrences: rows[2],
    incomeTransactions: rows[3], obligationOccurrences: rows[4],
    obligationReservations: rows[5], obligationPayments: rows[6],
  };
}

async function count(
  table: 'calculation_periods' | 'budget_allocations',
  userId: string,
  refine?: (query: any) => any,
): Promise<number> {
  let query: any = database().selectFrom(table).select(sql<string>`count(*)`.as('count'))
    .where('user_id', '=', userId);
  if (refine) query = refine(query);
  return Number((await query.executeTakeFirstOrThrow()).count);
}

async function occurrenceCount(userId: string, type: 'INCOME' | 'OBLIGATION'): Promise<number> {
  const row = await database().selectFrom('schedule_occurrences')
    .select(sql<string>`count(*)`.as('count')).where('user_id', '=', userId)
    .where('schedule_type', '=', type).executeTakeFirstOrThrow();
  return Number(row.count);
}

async function transactionCount(userId: string, type: string): Promise<number> {
  const row = await database().selectFrom('ledger_transactions')
    .select(sql<string>`count(*)`.as('count')).where('user_id', '=', userId)
    .where('type', '=', type).executeTakeFirstOrThrow();
  return Number(row.count);
}

async function countFinancialAccounts(userId: string, kind: 'BUDGET_RESERVE'): Promise<number> {
  const row = await database().selectFrom('financial_accounts')
    .select(sql<string>`count(*)`.as('count')).where('user_id', '=', userId)
    .where('kind', '=', kind).executeTakeFirstOrThrow();
  return Number(row.count);
}

async function categoryCount(userId: string): Promise<number> {
  const row = await database().selectFrom('categories')
    .select(sql<string>`count(*)`.as('count')).where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForBlockedProfileLock(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await sql<{ pid: number }>`
      select pid
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and state = 'active'
        and wait_event_type = 'Lock'
        and query ilike '%from "financial_profiles"%'
        and query ilike '%for update%'
    `.execute(database());
    if (result.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for category creation to block on the profile row');
}

function database(): Kysely<Database> {
  if (!context) throw new Error('Database test context was not created');
  return context.db;
}
