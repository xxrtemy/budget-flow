import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { createDatabase } from '../../database/database.factory';
import type { Database } from '../../database/database.types';
import { migrateToLatest } from '../../database/migrator';
import { ProfileRepository } from '../profile/profile.repository';
import { ProfileService } from '../profile/profile.service';
import { IncomeService } from './income.service';

const NOW = new Date('2026-01-01T09:00:00.000Z');

interface IncomeDatabaseTestContext {
  db: Kysely<Database>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

let context: IncomeDatabaseTestContext | undefined;

beforeAll(async () => { context = await createDatabaseTestContext(); });
beforeEach(async () => { await context?.reset(); });
afterAll(async () => { await context?.close(); });

describe('IncomeService', () => {
  test('posts a one-off income from INCOME_SOURCE to FREE and lists only one-offs', async () => {
    const userId = await createProfile();
    const service = incomeService();

    const oneOff = await service.createOneOff({
      userId,
      amountMinor: 150_000,
      effectiveAt: new Date('2026-01-15T10:30:00.000Z'),
      name: 'Freelance',
    });
    const schedule = await service.createSchedule({
      userId,
      amountMinor: 80_000,
      startsOn: '2026-01-31',
      cadence: 'MONTHLY',
      name: 'Salary',
    });
    await service.materializeAndApplyDue(
      userId,
      new Date('2026-01-30T21:00:00.000Z'),
    );

    const accounts = await database().selectFrom('financial_accounts')
      .select(['id', 'kind'])
      .where('user_id', '=', userId)
      .where('kind', 'in', ['INCOME_SOURCE', 'FREE'])
      .execute();
    const sourceId = accounts.find(({ kind }) => kind === 'INCOME_SOURCE')!.id;
    const freeId = accounts.find(({ kind }) => kind === 'FREE')!.id;
    expect(oneOff).toMatchObject({
      userId,
      type: 'INCOME',
      effectiveAt: new Date('2026-01-15T10:30:00.000Z'),
      sourceOccurrenceId: null,
      metadata: { name: 'Freelance' },
    });
    expect(oneOff.postings).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: sourceId, amountMinor: -150_000 }),
      expect.objectContaining({ accountId: freeId, amountMinor: 150_000 }),
    ]));
    await expect(accountBalance(userId, sourceId)).resolves.toBe(-230_000);
    await expect(accountBalance(userId, freeId)).resolves.toBe(230_000);

    const listed = await service.listOneOff(userId);
    expect(listed).toEqual({ items: [oneOff], nextCursor: null });
    expect(listed.items.every(({ sourceOccurrenceId }) => sourceOccurrenceId === null)).toBe(true);
    expect(schedule.name).toBe('Salary');
  });

  test('materializes January 31 through March 31 with timezone-aware anchored dates exactly once', async () => {
    const userId = await createProfile('Europe/Moscow');
    const service = incomeService();
    const schedule = await service.createSchedule({
      userId,
      amountMinor: 100_000,
      startsOn: '2026-01-31',
      cadence: 'MONTHLY',
      name: 'Salary',
    });

    await service.materializeAndApplyDue(userId, new Date('2026-03-30T21:00:00.000Z'));
    await service.materializeAndApplyDue(userId, new Date('2026-03-30T21:00:00.000Z'));

    const occurrences = await database().selectFrom('schedule_occurrences')
      .select(['id', 'due_at', 'status', 'applied_transaction_id'])
      .where('user_id', '=', userId)
      .where('schedule_type', '=', 'INCOME')
      .where('schedule_id', '=', schedule.id)
      .orderBy('due_at')
      .execute();
    expect(occurrences).toEqual([
      expect.objectContaining({
        due_at: new Date('2026-01-30T21:00:00.000Z'),
        status: 'APPLIED',
        applied_transaction_id: expect.any(String),
      }),
      expect.objectContaining({
        due_at: new Date('2026-02-27T21:00:00.000Z'),
        status: 'APPLIED',
        applied_transaction_id: expect.any(String),
      }),
      expect.objectContaining({
        due_at: new Date('2026-03-30T21:00:00.000Z'),
        status: 'APPLIED',
        applied_transaction_id: expect.any(String),
      }),
    ]);
    const linkedTransactions = await database().selectFrom('ledger_transactions')
      .select(['id', 'source_occurrence_id'])
      .where('user_id', '=', userId)
      .where('type', '=', 'INCOME')
      .where('source_occurrence_id', 'is not', null)
      .execute();
    expect(linkedTransactions).toHaveLength(3);
    expect(new Set(linkedTransactions.map(({ source_occurrence_id }) => source_occurrence_id)).size)
      .toBe(3);
  });

  test('serializes concurrent materialization without duplicate occurrences or transactions', async () => {
    const userId = await createProfile();
    const service = incomeService();
    await service.createSchedule({
      userId,
      amountMinor: 42_000,
      startsOn: '2026-01-31',
      cadence: 'MONTHLY',
      name: 'Salary',
    });
    const through = new Date('2026-03-30T21:00:00.000Z');

    await Promise.all([
      service.materializeAndApplyDue(userId, through),
      service.materializeAndApplyDue(userId, through),
    ]);

    const occurrences = await database().selectFrom('schedule_occurrences')
      .select('id')
      .where('user_id', '=', userId)
      .where('schedule_type', '=', 'INCOME')
      .execute();
    const transactions = await database().selectFrom('ledger_transactions')
      .select('id')
      .where('user_id', '=', userId)
      .where('type', '=', 'INCOME')
      .where('source_occurrence_id', 'is not', null)
      .execute();
    expect(occurrences).toHaveLength(3);
    expect(transactions).toHaveLength(3);
  });

  test('updates only future unmaterialized income and archive stops future materialization', async () => {
    const userId = await createProfile();
    const service = incomeService(() => new Date('2026-02-01T00:00:00.000Z'));
    const schedule = await service.createSchedule({
      userId,
      amountMinor: 100_000,
      startsOn: '2026-01-31',
      cadence: 'MONTHLY',
      name: 'Old salary',
    });
    await service.materializeAndApplyDue(userId, new Date('2026-01-30T21:00:00.000Z'));

    const updated = await service.updateSchedule(userId, schedule.id, {
      amountMinor: 120_000,
      name: 'New salary',
    });
    await service.materializeAndApplyDue(userId, new Date('2026-03-30T21:00:00.000Z'));

    const transactions = await recurringIncomeTransactions(userId);
    expect(transactions.map(({ amount_minor }) => Number(amount_minor))).toEqual([
      100_000,
      120_000,
      120_000,
    ]);
    expect(updated).toMatchObject({ amountMinor: 120_000, name: 'New salary' });

    await service.archiveSchedule(userId, schedule.id);
    await service.materializeAndApplyDue(userId, new Date('2026-04-29T21:00:00.000Z'));
    await expect(service.getSchedule(userId, schedule.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateSchedule(userId, schedule.id, { amountMinor: 1 }))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.archiveSchedule(userId, schedule.id))
      .rejects.toBeInstanceOf(NotFoundException);
    expect((await service.listSchedules(userId)).items).toEqual([]);
    await expect(recurringIncomeTransactions(userId)).resolves.toHaveLength(3);
  });

  test('materializes missed old-rule income before changing cadence', async () => {
    const userId = await createProfile();
    const commandTime = new Date('2026-03-01T00:00:00.000Z');
    const service = incomeService(() => commandTime);
    const schedule = await service.createSchedule({
      userId,
      amountMinor: 100_000,
      startsOn: '2026-01-31',
      cadence: 'MONTHLY',
      name: 'Salary',
    });
    await service.materializeAndApplyDue(userId, new Date('2026-01-30T21:00:00.000Z'));

    await service.updateSchedule(userId, schedule.id, { cadence: 'QUARTERLY' });
    await service.materializeAndApplyDue(userId, new Date('2026-04-29T21:00:00.000Z'));

    await expect(recurringIncomeOccurrenceOns(userId)).resolves.toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-04-30',
    ]);
  });

  test('does not reinterpret past dates after changing startsOn and applies the next new-rule date', async () => {
    const userId = await createProfile();
    const commandTime = new Date('2026-04-01T00:00:00.000Z');
    const service = incomeService(() => commandTime);
    const schedule = await service.createSchedule({
      userId,
      amountMinor: 100_000,
      startsOn: '2026-01-31',
      cadence: 'MONTHLY',
      name: 'Salary',
    });
    await service.materializeAndApplyDue(userId, new Date('2026-03-30T21:00:00.000Z'));

    await service.updateSchedule(userId, schedule.id, { startsOn: '2026-01-30' });
    await service.materializeAndApplyDue(userId, new Date('2026-04-29T21:00:00.000Z'));

    await expect(recurringIncomeOccurrenceOns(userId)).resolves.toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });

  test('deduplicates a local occurrence date after the profile timezone changes', async () => {
    const userId = await createProfile('Europe/Moscow');
    const service = incomeService();
    await service.createSchedule({
      userId,
      amountMinor: 100_000,
      startsOn: '2026-01-31',
      cadence: 'MONTHLY',
      name: 'Salary',
    });
    await service.materializeAndApplyDue(userId, new Date('2026-01-30T21:00:00.000Z'));
    await new ProfileService(new ProfileRepository(database()), () => NOW).upsert({
      userId,
      timezone: 'UTC',
      cadence: 'MONTHLY',
      firstPeriodEndsOn: '2026-01-31',
    });

    await service.materializeAndApplyDue(userId, new Date('2026-01-31T00:00:00.000Z'));

    await expect(recurringIncomeOccurrenceOns(userId)).resolves.toEqual(['2026-01-31']);
    const occurrences = await database().selectFrom('schedule_occurrences')
      .select(['due_at'])
      .where('user_id', '=', userId)
      .where('schedule_type', '=', 'INCOME')
      .execute();
    expect(occurrences).toEqual([{ due_at: new Date('2026-01-30T21:00:00.000Z') }]);
  });

  test('applies an already-due missed income before archiving its schedule', async () => {
    const userId = await createProfile();
    const service = incomeService(() => new Date('2026-02-01T00:00:00.000Z'));
    const schedule = await service.createSchedule({
      userId,
      amountMinor: 100_000,
      startsOn: '2026-01-31',
      cadence: 'MONTHLY',
      name: 'Salary',
    });

    await service.archiveSchedule(userId, schedule.id);

    await expect(recurringIncomeOccurrenceOns(userId)).resolves.toEqual(['2026-01-31']);
    await expect(service.getSchedule(userId, schedule.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  test.each(['update', 'archive'] as const)(
    'rolls back pre-%s materialization and the schedule mutation when ledger posting fails',
    async (operation) => {
      const userId = await createProfile();
      const service = incomeService(() => new Date('2026-02-01T00:00:00.000Z'));
      const schedule = await service.createSchedule({
        userId,
        amountMinor: 100_000,
        startsOn: '2026-01-31',
        cadence: 'MONTHLY',
        name: 'Salary',
      });

      await installRecurringIncomeFailureTrigger();
      try {
        const mutation = operation === 'update'
          ? service.updateSchedule(userId, schedule.id, { amountMinor: 120_000 })
          : service.archiveSchedule(userId, schedule.id);
        await expect(mutation).rejects.toThrow('injected recurring income failure');
      } finally {
        await dropRecurringIncomeFailureTrigger();
      }

      await expect(service.getSchedule(userId, schedule.id)).resolves.toMatchObject({
        amountMinor: 100_000,
        archivedAt: null,
      });
      await expect(recurringIncomeOccurrenceOns(userId)).resolves.toEqual([]);
    },
  );

  test('hides schedules and one-off incomes from another tenant', async () => {
    const ownerId = await createProfile();
    const otherId = await createProfile();
    const service = incomeService();
    const schedule = await service.createSchedule({
      userId: ownerId,
      amountMinor: 75_000,
      startsOn: '2026-01-10',
      cadence: 'WEEKLY',
      name: 'Owner salary',
    });
    await service.createOneOff({
      userId: ownerId,
      amountMinor: 1_500,
      effectiveAt: NOW,
      name: 'Owner income',
    });

    await expect(service.getSchedule(otherId, schedule.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateSchedule(otherId, schedule.id, { name: 'stolen' }))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.archiveSchedule(otherId, schedule.id))
      .rejects.toBeInstanceOf(NotFoundException);
    expect((await service.listSchedules(otherId)).items).toEqual([]);
    expect((await service.listOneOff(otherId)).items).toEqual([]);
  });

  test('validates money, names, dates, cadence, through date, patch and strict cursors', async () => {
    const userId = await createProfile();
    const service = incomeService();

    await expect(service.createOneOff({ userId, amountMinor: 0, effectiveAt: NOW }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createOneOff({
      userId,
      amountMinor: Number.MAX_SAFE_INTEGER + 1,
      effectiveAt: NOW,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createOneOff({
      userId,
      amountMinor: 1,
      effectiveAt: new Date('invalid'),
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createSchedule({
      userId,
      amountMinor: 1,
      startsOn: '2026-1-01',
      cadence: 'MONTHLY',
      name: 'Salary',
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createSchedule({
      userId,
      amountMinor: 1,
      startsOn: '2026-02-30',
      cadence: 'MONTHLY',
      name: 'Salary',
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createSchedule({
      userId,
      amountMinor: 1,
      startsOn: '2026-01-01',
      cadence: 'HOURLY' as never,
      name: 'Salary',
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createSchedule({
      userId,
      amountMinor: 1,
      startsOn: '2026-01-01',
      cadence: 'MONTHLY',
      name: '   ',
    })).rejects.toBeInstanceOf(BadRequestException);
    const schedule = await service.createSchedule({
      userId,
      amountMinor: 1,
      startsOn: '2026-01-01',
      cadence: 'MONTHLY',
      name: 'Salary',
    });
    await expect(service.updateSchedule(userId, schedule.id, {}))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateSchedule(userId, schedule.id, { unknown: true } as never))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.materializeAndApplyDue(userId, new Date('invalid')))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.listOneOff(userId, 'not-a-cursor'))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.listSchedules(userId, 'not-a-cursor'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  test('uses stable cursor pagination for one-off incomes', async () => {
    const userId = await createProfile();
    const service = incomeService();
    for (let index = 0; index < 52; index += 1) {
      await service.createOneOff({
        userId,
        amountMinor: index + 1,
        effectiveAt: new Date(NOW.getTime() + index),
      });
    }

    const first = await service.listOneOff(userId);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.listOneOff(userId, first.nextCursor!);
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(52);
  });

  test('rolls back the occurrence when linked ledger posting fails', async () => {
    const userId = await createProfile();
    const service = incomeService();
    await service.createSchedule({
      userId,
      amountMinor: 10_000,
      startsOn: '2026-01-31',
      cadence: 'MONTHLY',
      name: 'Salary',
    });

    await installRecurringIncomeFailureTrigger();
    try {
      await expect(service.materializeAndApplyDue(
        userId,
        new Date('2026-01-30T21:00:00.000Z'),
      )).rejects.toThrow('injected recurring income failure');
    } finally {
      await dropRecurringIncomeFailureTrigger();
    }

    const occurrences = await database().selectFrom('schedule_occurrences')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    const transactions = await database().selectFrom('ledger_transactions')
      .select('id')
      .where('user_id', '=', userId)
      .where('source_occurrence_id', 'is not', null)
      .execute();
    expect(occurrences).toEqual([]);
    expect(transactions).toEqual([]);
  });
});

function incomeService(clock?: () => Date): IncomeService {
  return new IncomeService(database(), clock);
}

async function createProfile(timezone = 'Europe/Moscow'): Promise<string> {
  const userId = randomUUID();
  const service = new ProfileService(new ProfileRepository(database()), () => NOW);
  await service.upsert({
    userId,
    timezone,
    cadence: 'MONTHLY',
    firstPeriodEndsOn: '2026-01-31',
  });
  return userId;
}

async function accountBalance(userId: string, accountId: string): Promise<number> {
  const row = await database().selectFrom('ledger_postings')
    .select(sql<string>`coalesce(sum(amount_minor), 0)`.as('balance_minor'))
    .where('user_id', '=', userId)
    .where('account_id', '=', accountId)
    .executeTakeFirstOrThrow();
  return Number(row.balance_minor);
}

async function recurringIncomeTransactions(userId: string): Promise<Array<{
  amount_minor: string;
}>> {
  return database().selectFrom('ledger_transactions')
    .innerJoin('ledger_postings', (join) => join
      .onRef('ledger_postings.transaction_id', '=', 'ledger_transactions.id')
      .onRef('ledger_postings.user_id', '=', 'ledger_transactions.user_id'))
    .innerJoin('financial_accounts', (join) => join
      .onRef('financial_accounts.id', '=', 'ledger_postings.account_id')
      .onRef('financial_accounts.user_id', '=', 'ledger_postings.user_id'))
    .select('ledger_postings.amount_minor')
    .where('ledger_transactions.user_id', '=', userId)
    .where('ledger_transactions.type', '=', 'INCOME')
    .where('ledger_transactions.source_occurrence_id', 'is not', null)
    .where('financial_accounts.kind', '=', 'FREE')
    .orderBy('ledger_transactions.effective_at')
    .execute();
}

async function recurringIncomeOccurrenceOns(userId: string): Promise<string[]> {
  const rows = await database().selectFrom('ledger_transactions')
    .select('metadata')
    .where('user_id', '=', userId)
    .where('type', '=', 'INCOME')
    .where('source_occurrence_id', 'is not', null)
    .orderBy('effective_at')
    .execute();
  return rows.map(({ metadata }) => {
    const occurrenceOn = (metadata as Record<string, unknown>).occurrenceOn;
    if (typeof occurrenceOn !== 'string') {
      throw new Error('Recurring income metadata is missing occurrenceOn');
    }
    return occurrenceOn;
  });
}

async function installRecurringIncomeFailureTrigger(): Promise<void> {
  await sql`
    create function fail_recurring_income() returns trigger as $$
    begin
      if new.type = 'INCOME' and new.source_occurrence_id is not null then
        raise exception 'injected recurring income failure';
      end if;
      return new;
    end;
    $$ language plpgsql;

    create trigger fail_recurring_income_trigger
      before insert on ledger_transactions
      for each row execute function fail_recurring_income()
  `.execute(database());
}

async function dropRecurringIncomeFailureTrigger(): Promise<void> {
  await sql`drop trigger if exists fail_recurring_income_trigger on ledger_transactions`.execute(database());
  await sql`drop function if exists fail_recurring_income()`.execute(database());
}

function database(): Kysely<Database> {
  if (!context) {
    throw new Error('Database test context was not created');
  }
  return context.db;
}

async function createDatabaseTestContext(): Promise<IncomeDatabaseTestContext> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const db = createDatabase(container.getConnectionUri());
  await migrateToLatest(db);

  return {
    db,
    async reset(): Promise<void> {
      await dropRecurringIncomeFailureTrigger();
      await sql`
        truncate table
          schedule_occurrences,
          income_schedules,
          ledger_postings,
          ledger_transactions,
          calculation_periods,
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
