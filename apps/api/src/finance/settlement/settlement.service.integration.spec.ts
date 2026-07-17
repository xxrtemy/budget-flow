import { randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { Database } from '../../database/database.types';
import { BudgetService } from '../budgets/budget.service';
import { CategoryService } from '../expenses/category.service';
import { LedgerService } from '../ledger/ledger.service';
import { ProfileRepository } from '../profile/profile.repository';
import { ProfileService } from '../profile/profile.service';
import {
  createFinanceDatabaseTestContext,
  type FinanceDatabaseTestContext,
} from '../test/database-test-context';
import { SettlementService } from './settlement.service';

const PROFILE_NOW = new Date('2026-01-01T09:00:00.000Z');
const CLOSE_AT = new Date('2026-02-01T12:00:00.000Z');

let context: FinanceDatabaseTestContext | undefined;

beforeAll(async () => { context = await createFinanceDatabaseTestContext(); });
beforeEach(async () => { await context?.reset(); });
afterAll(async () => { await context?.close(); });

describe('SettlementService', () => {
  test('releases the period budget remainder and offers the exact 70k net cash result', async () => {
    const userId = await createProfile();
    const period = await currentPeriod(userId);
    const accounts = await accountIds(userId);
    const category = await new CategoryService(database()).create(userId, 'Food');
    const plan = await new BudgetService(database()).create({
      userId, categoryId: category.id, amountMinor: 30_000,
      startsOn: '2026-01-01', cadence: 'MONTHLY',
    });
    await database().updateTable('budget_plans').set({
      created_at: PROFILE_NOW,
      updated_at: PROFILE_NOW,
    }).where('user_id', '=', userId).where('id', '=', plan.id).execute();
    await post(userId, 'INCOME', new Date('2026-01-10T10:00:00Z'), [
      [accounts.INCOME_SOURCE, -100_000], [accounts.FREE, 100_000],
    ]);
    await new BudgetService(database()).reconcilePeriod(userId, period.id, PROFILE_NOW);
    await post(userId, 'ORDINARY_EXPENSE', new Date('2026-01-20T10:00:00Z'), [
      [plan.reserveAccountId, -20_000], [accounts.EXPENSE_SINK, 20_000],
    ]);
    await post(userId, 'OBLIGATION_PAYMENT', new Date('2026-01-25T10:00:00Z'), [
      [accounts.FREE, -10_000], [accounts.EXPENSE_SINK, 10_000],
    ]);

    await settlement().closeDuePeriods(userId, CLOSE_AT);

    expect(await balance(userId, plan.reserveAccountId)).toBe(0n);
    expect(await balance(userId, accounts.FREE)).toBe(70_000n);
    const release = await database().selectFrom('ledger_transactions').selectAll()
      .where('user_id', '=', userId).where('type', '=', 'BUDGET_RELEASE')
      .executeTakeFirstOrThrow();
    const allocation = await database().selectFrom('budget_allocations').selectAll()
      .where('user_id', '=', userId).where('period_id', '=', period.id)
      .executeTakeFirstOrThrow();
    expect(allocation.released_transaction_id).toBe(release.id);
    const offer = await pendingOffer(userId);
    expect(BigInt(offer.offered_amount_minor)).toBe(70_000n);
    expect((await database().selectFrom('calculation_periods').selectAll()
      .where('user_id', '=', userId).where('id', '=', period.id)
      .executeTakeFirstOrThrow()).status).toBe('CLOSED');
    expect((await currentPeriod(userId)).starts_at).toEqual(period.ends_at_exclusive);
  });

  test('releases every positive active reserve even when the current period has no allocation', async () => {
    const userId = await createProfile();
    const firstPeriod = await currentPeriod(userId);
    const accounts = await accountIds(userId);
    const plans = [];
    for (const [name, amountMinor] of [['Food', 30_000], ['Transport', 20_000]] as const) {
      const category = await new CategoryService(database()).create(userId, name);
      const plan = await new BudgetService(database()).create({
        userId, categoryId: category.id, amountMinor,
        startsOn: '2026-01-01', cadence: 'ANNUAL',
      });
      await database().updateTable('budget_plans').set({
        created_at: PROFILE_NOW, updated_at: PROFILE_NOW,
      }).where('user_id', '=', userId).where('id', '=', plan.id).execute();
      plans.push({ plan, amountMinor });
    }
    await post(userId, 'INCOME', new Date('2026-01-05T10:00:00Z'), [
      [accounts.INCOME_SOURCE, -50_000], [accounts.FREE, 50_000],
    ]);
    await new BudgetService(database()).reconcilePeriod(userId, firstPeriod.id, PROFILE_NOW);
    const expenses = [];
    for (const { plan, amountMinor } of plans) {
      expenses.push(await post(userId, 'ORDINARY_EXPENSE', new Date('2026-01-20T10:00:00Z'), [
        [plan.reserveAccountId, -amountMinor], [accounts.EXPENSE_SINK, amountMinor],
      ]));
    }
    await settlement().closeDuePeriods(userId, CLOSE_AT);
    const secondPeriod = await currentPeriod(userId);
    for (const expense of expenses) {
      await new LedgerService(database()).reverse(
        userId,
        expense.id,
        new Date('2026-02-15T10:00:00Z'),
      );
    }
    expect(await database().selectFrom('budget_allocations').select('id')
      .where('user_id', '=', userId).where('period_id', '=', secondPeriod.id).execute())
      .toHaveLength(0);

    await settlement().closeDuePeriods(userId, new Date('2026-03-01T12:00:00Z'));

    expect(await balance(userId, accounts.FREE)).toBe(50_000n);
    for (const { plan } of plans) {
      expect(await balance(userId, plan.reserveAccountId)).toBe(0n);
    }
    expect(BigInt((await pendingOffer(userId)).offered_amount_minor)).toBe(50_000n);
    const releases = await database().selectFrom('ledger_transactions').select('id')
      .where('user_id', '=', userId).where('type', '=', 'BUDGET_RELEASE')
      .where('effective_at', '=', new Date('2026-03-01T12:00:00Z')).execute();
    expect(releases).toHaveLength(2);
  });

  test('waits for an eligible posting lock before taking the standalone close snapshot', async () => {
    const userId = await createProfile();
    const accounts = await accountIds(userId);
    const locked = deferred<void>();
    const postNow = deferred<void>();
    const posting = database().transaction().execute(async (trx) => {
      await trx.selectFrom('financial_accounts').select('id')
        .where('user_id', '=', userId).where('id', '=', accounts.FREE)
        .forUpdate().executeTakeFirstOrThrow();
      locked.resolve();
      await postNow.promise;
      await new LedgerService(database()).post({
        userId, type: 'INCOME', effectiveAt: new Date('2026-01-20T10:00:00Z'),
        postings: [
          { accountId: accounts.INCOME_SOURCE, amountMinor: -40_000 },
          { accountId: accounts.FREE, amountMinor: 40_000 },
        ],
      }, trx);
    });
    await locked.promise;
    const closing = settlement().closeDuePeriods(userId, CLOSE_AT);
    try {
      await waitForBlockedRowLocks('financial_accounts', 1);
    } finally {
      postNow.resolve();
      await posting;
    }
    await closing;

    expect(BigInt((await pendingOffer(userId)).offered_amount_minor)).toBe(40_000n);
  });

  test('counts only cash transaction types and eligible reversals at their own effective time', async () => {
    const userId = await createProfile();
    const accounts = await accountIds(userId);
    const ledger = new LedgerService(database());
    await ledger.createOpeningBalance(userId, 500_000, new Date('2026-01-02T10:00:00Z'));
    const income = await post(userId, 'INCOME', new Date('2025-12-20T10:00:00Z'), [
      [accounts.INCOME_SOURCE, -40_000], [accounts.FREE, 40_000],
    ]);
    await ledger.reverse(userId, income.id, new Date('2026-01-05T10:00:00Z'));
    const internal = await post(userId, 'SAVINGS_TRANSFER', new Date('2026-01-06T10:00:00Z'), [
      [accounts.FREE, -30_000], [accounts.SAVINGS_GENERAL, 30_000],
    ]);
    await ledger.reverse(userId, internal.id, new Date('2026-01-07T10:00:00Z'));
    await post(userId, 'INCOME', new Date('2026-01-10T10:00:00Z'), [
      [accounts.INCOME_SOURCE, -100_000], [accounts.FREE, 100_000],
    ]);

    await settlement().closeDuePeriods(userId, CLOSE_AT);

    expect(BigInt((await pendingOffer(userId)).offered_amount_minor)).toBe(60_000n);
  });

  test('creates no offer for a zero or negative cash result', async () => {
    for (const amount of [0, -10_000]) {
      const userId = await createProfile();
      const accounts = await accountIds(userId);
      if (amount < 0) {
        await post(userId, 'ORDINARY_EXPENSE', new Date('2026-01-10T10:00:00Z'), [
          [accounts.FREE, amount], [accounts.EXPENSE_SINK, -amount],
        ]);
      }
      await settlement().closeDuePeriods(userId, CLOSE_AT);
      expect(await database().selectFrom('settlement_offers').select('id')
        .where('user_id', '=', userId).execute()).toHaveLength(0);
    }
  });

  test('clamps a positive net cash result to FREE after excluded internal transfers', async () => {
    const userId = await createProfile();
    const accounts = await accountIds(userId);
    await post(userId, 'INCOME', new Date('2026-01-10T10:00:00Z'), [
      [accounts.INCOME_SOURCE, -100_000], [accounts.FREE, 100_000],
    ]);
    await post(userId, 'SAVINGS_TRANSFER', new Date('2026-01-20T10:00:00Z'), [
      [accounts.FREE, -40_000], [accounts.SAVINGS_GENERAL, 40_000],
    ]);

    await settlement().closeDuePeriods(userId, CLOSE_AT);

    expect(BigInt((await pendingOffer(userId)).offered_amount_minor)).toBe(60_000n);
  });

  test('uses the updated timezone and anchored profile end when opening the next period', async () => {
    const userId = await createProfile('2026-01-31');
    await database().updateTable('financial_profiles').set({
      timezone: 'Asia/Tokyo', next_period_ends_on: '2026-02-28', cycle_anchor_day: 31,
    }).where('user_id', '=', userId).execute();

    await settlement().closeDuePeriods(userId, CLOSE_AT);

    const next = await currentPeriod(userId);
    expect(next.timezone).toBe('Asia/Tokyo');
    expect(next.ends_on_local).toBe('2026-02-28');
    expect(next.ends_at_exclusive).toEqual(new Date('2026-02-28T15:00:00.000Z'));
    expect((await database().selectFrom('financial_profiles').selectAll()
      .where('user_id', '=', userId).executeTakeFirstOrThrow()).next_period_ends_on)
      .toBe('2026-03-31');
  });

  test('repeated and concurrent closure creates one next period and at most one offer', async () => {
    const userId = await createProfile();
    const accounts = await accountIds(userId);
    await post(userId, 'INCOME', new Date('2026-01-10T10:00:00Z'), [
      [accounts.INCOME_SOURCE, -50_000], [accounts.FREE, 50_000],
    ]);
    const blocker = await holdRowLock('financial_profiles', userId, userId);
    const closing = Promise.all([
      settlement().closeDuePeriods(userId, CLOSE_AT),
      settlement().closeDuePeriods(userId, CLOSE_AT),
    ]);
    try {
      await waitForBlockedRowLocks('financial_profiles', 2);
    } finally {
      await blocker.release();
    }
    await closing;
    await settlement().closeDuePeriods(userId, CLOSE_AT);

    expect(await count('calculation_periods', userId)).toBe(2);
    expect(await count('settlement_offers', userId)).toBe(1);
  });

  test('accepts full or partial amounts once and reports reduced FREE exactly', async () => {
    const userId = await createProfile();
    const accounts = await accountIds(userId);
    await post(userId, 'INCOME', new Date('2026-01-10T10:00:00Z'), [
      [accounts.INCOME_SOURCE, -100_000], [accounts.FREE, 100_000],
    ]);
    await settlement().closeDuePeriods(userId, CLOSE_AT);
    const offer = await pendingOffer(userId);
    await post(userId, 'ORDINARY_EXPENSE', CLOSE_AT, [
      [accounts.FREE, -40_000], [accounts.EXPENSE_SINK, 40_000],
    ]);

    const conflict = await settlement().acceptOffer({
      userId, offerId: offer.id, amountMinor: 70_000, acceptedAt: CLOSE_AT,
    }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ConflictException);
    expect((conflict as ConflictException).getResponse()).toMatchObject({ availableAmountMinor: 60_000 });

    const accepted = await settlement().acceptOffer({
      userId, offerId: offer.id, amountMinor: 25_000, acceptedAt: CLOSE_AT,
    });
    expect(accepted).toMatchObject({ status: 'ACCEPTED', acceptedAmountMinor: 25_000 });
    expect(await balance(userId, accounts.SAVINGS_GENERAL)).toBe(25_000n);
    await expect(settlement().acceptOffer({ userId, offerId: offer.id, acceptedAt: CLOSE_AT }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  test('accepts the full offered amount when amountMinor is omitted', async () => {
    const userId = await createProfile();
    const accounts = await accountIds(userId);
    await post(userId, 'INCOME', new Date('2026-01-10T10:00:00Z'), [
      [accounts.INCOME_SOURCE, -50_000], [accounts.FREE, 50_000],
    ]);
    await settlement().closeDuePeriods(userId, CLOSE_AT);
    const offer = await pendingOffer(userId);

    const accepted = await settlement().acceptOffer({
      userId, offerId: offer.id, acceptedAt: CLOSE_AT,
    });

    expect(accepted).toMatchObject({ status: 'ACCEPTED', acceptedAmountMinor: 50_000 });
    expect(await balance(userId, accounts.FREE)).toBe(0n);
    expect(await balance(userId, accounts.SAVINGS_GENERAL)).toBe(50_000n);
  });

  test('cursor-paginates both offer states without leaking another tenant', async () => {
    const userId = await createProfile();
    const otherUserId = await createProfile();
    const periodRows = Array.from({ length: 51 }, (_, index) => ({
      id: randomUUID(), user_id: userId,
      starts_at: new Date(Date.UTC(2020, 0, 1 + index)),
      ends_at_exclusive: new Date(Date.UTC(2020, 0, 2 + index)),
      ends_on_local: new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10),
      timezone: 'Europe/Moscow', status: 'CLOSED' as const,
      closed_at: new Date(Date.UTC(2020, 0, 2 + index)),
    }));
    await database().insertInto('calculation_periods').values(periodRows).execute();
    const offerRows = periodRows.map((period, index) => ({
      id: randomUUID(), user_id: userId, period_id: period.id,
      offered_amount_minor: index + 1, accepted_amount_minor: null,
      status: 'PENDING' as const,
      accepted_at: null,
      transfer_transaction_id: null,
      created_at: new Date('2026-02-01T00:00:00Z'),
    }));
    await database().insertInto('settlement_offers').values(offerRows).execute();
    const ownerAccounts = await accountIds(userId);
    await post(userId, 'INCOME', CLOSE_AT, [
      [ownerAccounts.INCOME_SOURCE, -1], [ownerAccounts.FREE, 1],
    ]);
    await settlement().acceptOffer({
      userId, offerId: offerRows[0]!.id, amountMinor: 1, acceptedAt: CLOSE_AT,
    });
    const otherPeriod = await currentPeriod(otherUserId);
    await database().insertInto('settlement_offers').values({
      id: randomUUID(), user_id: otherUserId, period_id: otherPeriod.id,
      offered_amount_minor: 999, accepted_amount_minor: null, status: 'PENDING',
      accepted_at: null, transfer_transaction_id: null,
    }).execute();

    const first = await settlement().listOffers(userId);
    const second = await settlement().listOffers(userId, first.nextCursor!);

    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(({ id }) => id)))
      .toEqual(new Set(offerRows.map(({ id }) => id)));
    expect([...first.items, ...second.items].some(({ status }) => status === 'ACCEPTED')).toBe(true);
    expect(first.items.every(({ userId: owner }) => owner === userId)).toBe(true);
  });

  test('serializes concurrent accept calls into one transfer and one conflict', async () => {
    const userId = await createProfile();
    const accounts = await accountIds(userId);
    await post(userId, 'INCOME', new Date('2026-01-10T10:00:00Z'), [
      [accounts.INCOME_SOURCE, -50_000], [accounts.FREE, 50_000],
    ]);
    await settlement().closeDuePeriods(userId, CLOSE_AT);
    const offer = await pendingOffer(userId);
    const blocker = await holdRowLock('settlement_offers', userId, offer.id);
    const accepting = Promise.allSettled([
      settlement().acceptOffer({ userId, offerId: offer.id, acceptedAt: CLOSE_AT }),
      settlement().acceptOffer({ userId, offerId: offer.id, acceptedAt: CLOSE_AT }),
    ]);
    try {
      await waitForBlockedRowLocks('settlement_offers', 2);
    } finally {
      await blocker.release();
    }
    const results = await accepting;

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(await countTransactions(userId, 'SETTLEMENT_TRANSFER')).toBe(1);
  });

  test('re-reads reduced FREE after a concurrent spend holding the account lock', async () => {
    const userId = await createProfile();
    const accounts = await accountIds(userId);
    await post(userId, 'INCOME', new Date('2026-01-10T10:00:00Z'), [
      [accounts.INCOME_SOURCE, -50_000], [accounts.FREE, 50_000],
    ]);
    await settlement().closeDuePeriods(userId, CLOSE_AT);
    const offer = await pendingOffer(userId);
    const locked = deferred<void>();
    const release = deferred<void>();
    const spending = database().transaction().execute(async (trx) => {
      await trx.selectFrom('financial_accounts').select('id')
        .where('user_id', '=', userId).where('id', '=', accounts.FREE)
        .forUpdate().executeTakeFirstOrThrow();
      locked.resolve();
      await release.promise;
      await new LedgerService(database()).post({
        userId, type: 'ORDINARY_EXPENSE', effectiveAt: CLOSE_AT,
        postings: [
          { accountId: accounts.FREE, amountMinor: -20_000 },
          { accountId: accounts.EXPENSE_SINK, amountMinor: 20_000 },
        ],
      }, trx);
    });
    let accepting: Promise<unknown> | undefined;
    try {
      await locked.promise;
      accepting = settlement().acceptOffer({ userId, offerId: offer.id, acceptedAt: CLOSE_AT });
      await waitForBlockedAccountLock();
    } finally {
      release.resolve();
      await spending;
    }
    const conflict = await accepting!.catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ConflictException);
    expect((conflict as ConflictException).getResponse()).toMatchObject({ availableAmountMinor: 30_000 });
    expect(await countTransactions(userId, 'SETTLEMENT_TRANSFER')).toBe(0);
  });

  test('strictly validates UUIDs, dates, amounts, cursors, and tenant ownership', async () => {
    const userId = await createProfile();
    const otherUserId = await createProfile();
    const accounts = await accountIds(userId);
    await post(userId, 'INCOME', new Date('2026-01-10T10:00:00Z'), [
      [accounts.INCOME_SOURCE, -10_000], [accounts.FREE, 10_000],
    ]);
    await settlement().closeDuePeriods(userId, CLOSE_AT);
    const offer = await pendingOffer(userId);

    await expect(settlement().closeDuePeriods('bad', CLOSE_AT)).rejects.toBeInstanceOf(BadRequestException);
    await expect(settlement().closeDuePeriods(userId, new Date('bad'))).rejects.toBeInstanceOf(BadRequestException);
    await expect(settlement().listOffers(userId, '***')).rejects.toBeInstanceOf(BadRequestException);
    await expect(settlement().acceptOffer({ userId, offerId: 'bad', acceptedAt: CLOSE_AT }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(settlement().acceptOffer({ userId, offerId: offer.id, amountMinor: 0, acceptedAt: CLOSE_AT }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(settlement().acceptOffer({
      userId, offerId: offer.id, amountMinor: 20_000, acceptedAt: CLOSE_AT,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(settlement().acceptOffer({ userId: otherUserId, offerId: offer.id, acceptedAt: CLOSE_AT }))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});

function settlement(): SettlementService { return new SettlementService(database(), new BudgetService(database())); }

async function createProfile(firstPeriodEndsOn = '2026-01-31'): Promise<string> {
  const userId = randomUUID();
  await new ProfileService(new ProfileRepository(database()), () => PROFILE_NOW).upsert({
    userId, timezone: 'Europe/Moscow', cadence: 'MONTHLY', firstPeriodEndsOn,
  });
  return userId;
}

async function currentPeriod(userId: string) {
  return database().selectFrom('calculation_periods').selectAll()
    .where('user_id', '=', userId).where('status', '=', 'OPEN').executeTakeFirstOrThrow();
}

async function accountIds(userId: string): Promise<Record<string, string>> {
  const rows = await database().selectFrom('financial_accounts').select(['id', 'kind'])
    .where('user_id', '=', userId).execute();
  return Object.fromEntries(rows.map(({ kind, id }) => [kind, id]));
}

async function post(userId: string, type: Parameters<LedgerService['post']>[0]['type'], effectiveAt: Date, pairs: Array<[string, number]>) {
  return new LedgerService(database()).post({
    userId, type, effectiveAt,
    postings: pairs.map(([accountId, amountMinor]) => ({ accountId, amountMinor })),
  });
}

async function balance(userId: string, accountId: string): Promise<bigint> {
  const row = await database().selectFrom('ledger_postings')
    .select(sql<string>`coalesce(sum(amount_minor), 0)`.as('amount'))
    .where('user_id', '=', userId).where('account_id', '=', accountId).executeTakeFirstOrThrow();
  return BigInt(row.amount);
}

function pendingOffer(userId: string) {
  return database().selectFrom('settlement_offers').selectAll()
    .where('user_id', '=', userId).where('status', '=', 'PENDING').executeTakeFirstOrThrow();
}

async function count(table: 'calculation_periods' | 'settlement_offers', userId: string): Promise<number> {
  const row = await database().selectFrom(table).select(sql<string>`count(*)`.as('count'))
    .where('user_id', '=', userId).executeTakeFirstOrThrow();
  return Number(row.count);
}

async function countTransactions(userId: string, type: string): Promise<number> {
  const row = await database().selectFrom('ledger_transactions').select(sql<string>`count(*)`.as('count'))
    .where('user_id', '=', userId).where('type', '=', type).executeTakeFirstOrThrow();
  return Number(row.count);
}

function database(): Kysely<Database> {
  if (!context) throw new Error('Database test context was not created');
  return context.db;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function waitForBlockedAccountLock(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await sql<{ pid: number }>`
      select pid
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and state = 'active'
        and wait_event_type = 'Lock'
        and query ilike '%financial_accounts%'
        and query ilike '%for update%'
    `.execute(database());
    if (result.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for settlement acceptance to block on FREE');
}

async function holdRowLock(
  table: 'financial_profiles' | 'settlement_offers',
  userId: string,
  id: string,
): Promise<{ release(): Promise<void> }> {
  const entered = deferred<void>();
  const release = deferred<void>();
  const holder = database().transaction().execute(async (trx) => {
    if (table === 'financial_profiles') {
      await trx.selectFrom('financial_profiles').select('user_id')
        .where('user_id', '=', userId).forUpdate().executeTakeFirstOrThrow();
    } else {
      await trx.selectFrom('settlement_offers').select('id')
        .where('user_id', '=', userId).where('id', '=', id)
        .forUpdate().executeTakeFirstOrThrow();
    }
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let released = false;
  return {
    async release() {
      if (!released) {
        released = true;
        release.resolve();
      }
      await holder;
    },
  };
}

async function waitForBlockedRowLocks(table: string, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await sql<{ pid: number }>`
      select pid
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and state = 'active'
        and wait_event_type = 'Lock'
        and query ilike ${`%${table}%`}
        and query ilike '%for update%'
    `.execute(database());
    if (result.rows.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} blocked ${table} row locks`);
}
