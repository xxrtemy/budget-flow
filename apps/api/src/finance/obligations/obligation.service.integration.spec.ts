import { randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { AccountKind, Database } from '../../database/database.types';
import { LedgerService } from '../ledger/ledger.service';
import { ProfileRepository } from '../profile/profile.repository';
import { ProfileService } from '../profile/profile.service';
import {
  createFinanceDatabaseTestContext,
  type FinanceDatabaseTestContext,
} from '../test/database-test-context';
import { ObligationService } from './obligation.service';

const PROFILE_NOW = new Date('2026-01-01T09:00:00.000Z');
const COMMAND_NOW = new Date('2026-01-02T09:00:00.000Z');

let context: FinanceDatabaseTestContext | undefined;

beforeAll(async () => { context = await createFinanceDatabaseTestContext(); });
beforeEach(async () => { await context?.reset(); });
afterAll(async () => { await context?.close(); });

describe('ObligationService', () => {
  test('never backfills dates before initial creation during later reconciliation', async () => {
    const userId = await createProfile();
    const createdAt = new Date('2026-01-10T12:00:00.000Z');
    const service = obligationService(() => createdAt);
    const schedule = await service.create({
      userId, amountMinor: 1_000, startsOn: '2026-01-08', cadence: 'DAILY', name: 'Meals',
    });
    const periodId = await currentPeriodId(userId);

    await service.reservePeriod(userId, periodId, new Date('2026-01-20T12:00:00.000Z'));
    await service.reservePeriod(userId, periodId, new Date('2026-01-20T12:00:00.000Z'));
    await service.applyDue(userId, new Date('2026-01-20T12:00:00.000Z'));

    const occurrences = (await service.listOccurrences(userId, schedule.id)).items;
    expect(occurrences.every(({ dueAt }) => dueAt >= createdAt)).toBe(true);
    expect(occurrences.some(({ occurrenceOn }) => occurrenceOn <= '2026-01-10')).toBe(false);
  });

  test('reserves an occurrence whose due instant equals initial creation time', async () => {
    const userId = await createProfile('UTC');
    const createdAt = new Date('2026-01-02T00:00:00.000Z');
    const service = obligationService(() => createdAt);

    const schedule = await service.create({
      userId, amountMinor: 2_000, startsOn: '2026-01-02', cadence: 'MONTHLY', name: 'Exact',
    });

    expect((await service.listOccurrences(userId, schedule.id)).items).toEqual([
      expect.objectContaining({ occurrenceOn: '2026-01-02', status: 'RESERVED' }),
    ]);
  });

  test('create reserves only future occurrences in the open period and may make FREE negative', async () => {
    const userId = await createProfile();
    const service = obligationService(() => COMMAND_NOW);

    const schedule = await service.create({
      userId,
      amountMinor: 10_000,
      startsOn: '2026-01-01',
      cadence: 'WEEKLY',
      name: 'Transport',
    });

    const occurrences = await service.listOccurrences(userId, schedule.id);
    expect(occurrences.items.map(({ occurrenceOn }) => occurrenceOn).sort().reverse()).toEqual([
      '2026-01-29', '2026-01-22', '2026-01-15', '2026-01-08',
    ]);
    expect(occurrences.items.every(({ status }) => status === 'RESERVED')).toBe(true);
    await expect(balanceByKind(userId, 'FREE')).resolves.toBe(-40_000);
    await expect(balanceByKind(userId, 'OBLIGATION_RESERVE')).resolves.toBe(40_000);
    await expect(transactionCount(userId, 'OBLIGATION_RESERVATION')).resolves.toBe(4);
  });

  test('period reconciliation includes missed past occurrences, then applyDue pays automatically', async () => {
    const userId = await createProfile();
    const service = obligationService(() => COMMAND_NOW);
    const schedule = await service.create({
      userId,
      amountMinor: 10_000,
      startsOn: '2026-01-01',
      cadence: 'WEEKLY',
      name: 'Food',
    });
    const periodId = await currentPeriodId(userId);

    await service.reservePeriod(userId, periodId, new Date('2026-01-20T09:00:00.000Z'));
    await service.applyDue(userId, new Date('2026-01-15T00:00:00.000Z'));

    const occurrences = await service.listOccurrences(userId, schedule.id);
    expect(occurrences.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ occurrenceOn: '2026-01-08', status: 'APPLIED' }),
      expect.objectContaining({ occurrenceOn: '2026-01-15', status: 'APPLIED' }),
    ]));
    await expect(transactionCount(userId, 'OBLIGATION_RESERVATION')).resolves.toBe(4);
    await expect(transactionCount(userId, 'OBLIGATION_PAYMENT')).resolves.toBe(2);
    await expect(balanceByKind(userId, 'OBLIGATION_RESERVE')).resolves.toBe(20_000);
    await expect(balanceByKind(userId, 'EXPENSE_SINK')).resolves.toBe(20_000);
  });

  test('cancelling one reserved occurrence releases its original amount and leaves later recurrence intact', async () => {
    const userId = await createProfile();
    const service = obligationService(() => PROFILE_NOW);
    const schedule = await service.create({
      userId,
      amountMinor: 10_000,
      startsOn: '2026-01-15',
      cadence: 'MONTHLY',
      name: 'Internet',
    });
    const january = (await service.listOccurrences(userId, schedule.id)).items[0]!;

    const cancelled = await service.cancelOccurrence(userId, january.id, COMMAND_NOW);
    await insertOpenPeriod(userId, '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '2026-02-28');
    const periods = await openPeriodIds(userId);
    await service.reservePeriod(userId, periods.at(-1)!, COMMAND_NOW);

    expect(cancelled.status).toBe('CANCELLED');
    expect((await service.listOccurrences(userId, schedule.id)).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ occurrenceOn: '2026-01-15', status: 'CANCELLED' }),
      expect.objectContaining({ occurrenceOn: '2026-02-15', status: 'RESERVED' }),
    ]));
    await expect(transactionCount(userId, 'OBLIGATION_RELEASE')).resolves.toBe(1);
  });

  test('cancel after payment and repeated cancel return 409 without extra release', async () => {
    const userId = await createProfile();
    const service = obligationService(() => PROFILE_NOW);
    const first = await service.create({
      userId, amountMinor: 5_000, startsOn: '2026-01-02', cadence: 'MONTHLY', name: 'Rent',
    });
    const applied = (await service.listOccurrences(userId, first.id)).items[0]!;
    await service.applyDue(userId, new Date('2026-01-02T00:00:00.000Z'));
    await expect(service.cancelOccurrence(userId, applied.id, COMMAND_NOW))
      .rejects.toBeInstanceOf(ConflictException);

    const second = await service.create({
      userId, amountMinor: 7_000, startsOn: '2026-01-03', cadence: 'MONTHLY', name: 'Phone',
    });
    const reserved = (await service.listOccurrences(userId, second.id)).items[0]!;
    await service.cancelOccurrence(userId, reserved.id, COMMAND_NOW);
    await expect(service.cancelOccurrence(userId, reserved.id, COMMAND_NOW))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(transactionCount(userId, 'OBLIGATION_RELEASE')).resolves.toBe(1);
  });

  test('amount update preserves the immutable amount reserved by an existing occurrence', async () => {
    const userId = await createProfile();
    const service = obligationService(() => PROFILE_NOW);
    const schedule = await service.create({
      userId, amountMinor: 10_000, startsOn: '2026-01-15', cadence: 'MONTHLY', name: 'Internet',
    });
    const occurrence = (await service.listOccurrences(userId, schedule.id)).items[0]!;

    await service.updateFuture(userId, schedule.id, { amountMinor: 99_000 });
    await service.cancelOccurrence(userId, occurrence.id, COMMAND_NOW);

    const releaseAmount = await postingAmount(userId, 'OBLIGATION_RELEASE', 'FREE');
    expect(releaseAmount).toBe(10_000);
  });

  test('future open-period occurrences introduced by an update use the new amount', async () => {
    const userId = await createProfile();
    const service = obligationService(() => PROFILE_NOW);
    const schedule = await service.create({
      userId, amountMinor: 10_000, startsOn: '2026-01-15', cadence: 'MONTHLY', name: 'Internet',
    });
    await insertOpenPeriod(
      userId,
      '2026-01-31T21:00:00.000Z',
      '2026-02-28T21:00:00.000Z',
      '2026-02-28',
    );
    const updater = obligationService(() => new Date('2026-01-10T12:00:00.000Z'));

    await updater.updateFuture(userId, schedule.id, { amountMinor: 99_000 });

    await expect(reservedAmountForOccurrence(userId, schedule.id, '2026-01-15')).resolves.toBe(10_000);
    await expect(reservedAmountForOccurrence(userId, schedule.id, '2026-02-15')).resolves.toBe(99_000);
  });

  test('recurrence and timezone updates do not create alternative historical duplicates', async () => {
    const userId = await createProfile('Europe/Moscow');
    const service = obligationService(() => new Date('2026-01-10T12:00:00.000Z'));
    const schedule = await service.create({
      userId, amountMinor: 1_000, startsOn: '2026-01-08', cadence: 'WEEKLY', name: 'Bus',
    });
    const periodId = await currentPeriodId(userId);
    await service.reservePeriod(userId, periodId, new Date('2026-01-20T00:00:00.000Z'));
    await database().updateTable('financial_profiles').set({ timezone: 'Asia/Yekaterinburg' })
      .where('user_id', '=', userId).execute();
    const updated = await service.updateFuture(
      userId,
      schedule.id,
      { startsOn: '2026-01-09', cadence: 'WEEKLY' },
    );
    expect(updated.updatedAt.getTime()).toBeGreaterThan(new Date('2026-01-10T12:00:00.000Z').getTime());
    await service.reservePeriod(userId, periodId, new Date('2026-01-20T00:00:00.000Z'));

    const occurrenceOns = (await service.listOccurrences(userId, schedule.id)).items
      .map(({ occurrenceOn }) => occurrenceOn);
    expect(occurrenceOns.filter((date) => date <= '2026-01-10')).toEqual([]);
    expect(occurrenceOns.filter((date) => date === '2026-01-15')).toHaveLength(1);
    expect(occurrenceOns.filter((date) => date === '2026-01-16')).toHaveLength(1);
    expect(new Set(occurrenceOns).size).toBe(occurrenceOns.length);
  });

  test('concurrent reserve, apply and cancel are exactly once and never expose unique violations', async () => {
    const userId = await createProfile();
    const service = obligationService(() => PROFILE_NOW);
    const schedule = await service.create({
      userId, amountMinor: 8_000, startsOn: '2026-01-10', cadence: 'MONTHLY', name: 'Insurance',
    });
    const periodId = await currentPeriodId(userId);
    await Promise.all([
      service.reservePeriod(userId, periodId, COMMAND_NOW),
      service.reservePeriod(userId, periodId, COMMAND_NOW),
    ]);
    const occurrence = (await service.listOccurrences(userId, schedule.id)).items[0]!;
    const settled = await Promise.allSettled([
      service.applyDue(userId, new Date('2026-01-10T00:00:00.000Z')),
      service.cancelOccurrence(userId, occurrence.id, COMMAND_NOW),
      service.cancelOccurrence(userId, occurrence.id, COMMAND_NOW),
    ]);

    expect(settled.filter(({ status }) => status === 'rejected').every((result) =>
      result.status === 'rejected' && result.reason instanceof ConflictException)).toBe(true);
    expect(await transactionCount(userId, 'OBLIGATION_RESERVATION')).toBe(1);
    expect((await transactionCount(userId, 'OBLIGATION_PAYMENT'))
      + (await transactionCount(userId, 'OBLIGATION_RELEASE'))).toBe(1);
  });

  test('pays into a technical expense sink whose lifetime balance exceeds MAX_SAFE_INTEGER', async () => {
    const userId = await createProfile();
    const service = obligationService(() => PROFILE_NOW);
    await service.create({
      userId, amountMinor: 100, startsOn: '2026-01-02', cadence: 'MONTHLY', name: 'Rent',
    });
    const accounts = await database().selectFrom('financial_accounts').select(['id', 'kind'])
      .where('user_id', '=', userId).where('kind', 'in', ['INCOME_SOURCE', 'EXPENSE_SINK'])
      .execute();
    const sourceId = accounts.find(({ kind }) => kind === 'INCOME_SOURCE')!.id;
    const sinkId = accounts.find(({ kind }) => kind === 'EXPENSE_SINK')!.id;
    const ledger = new LedgerService(database());
    await ledger.post({
      userId, type: 'ORDINARY_EXPENSE', effectiveAt: PROFILE_NOW,
      postings: [
        { accountId: sourceId, amountMinor: -Number.MAX_SAFE_INTEGER },
        { accountId: sinkId, amountMinor: Number.MAX_SAFE_INTEGER },
      ],
    });
    await ledger.post({
      userId, type: 'ORDINARY_EXPENSE', effectiveAt: PROFILE_NOW,
      postings: [
        { accountId: sourceId, amountMinor: -1 },
        { accountId: sinkId, amountMinor: 1 },
      ],
    });

    await service.applyDue(userId, new Date('2026-01-02T00:00:00.000Z'));

    expect(await transactionCount(userId, 'OBLIGATION_PAYMENT')).toBe(1);
    expect(await accountBalanceBigInt(userId, sinkId))
      .toBe(BigInt(Number.MAX_SAFE_INTEGER) + 101n);
  });

  test('ledger failure rolls back schedule, occurrence and reservation atomically', async () => {
    const userId = await createProfile();
    await installReservationFailureTrigger();
    try {
      await expect(obligationService(() => PROFILE_NOW).create({
        userId, amountMinor: 5_000, startsOn: '2026-01-15', cadence: 'MONTHLY', name: 'Failure',
      })).rejects.toThrow('injected obligation reservation failure');
    } finally {
      await dropReservationFailureTrigger();
    }

    await expect(rowCount('obligation_schedules', userId)).resolves.toBe(0);
    await expect(rowCount('schedule_occurrences', userId)).resolves.toBe(0);
    await expect(transactionCount(userId, 'OBLIGATION_RESERVATION')).resolves.toBe(0);
  });

  test('validates inputs, scopes tenant reads and uses the canonical cursor codec', async () => {
    const owner = await createProfile();
    const stranger = await createProfile();
    const service = obligationService(() => PROFILE_NOW);
    const schedule = await service.create({
      userId: owner, amountMinor: 1, startsOn: '2026-01-15', cadence: 'MONTHLY', name: 'One',
    });

    await expect(service.get(stranger, schedule.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.list(owner, 'not-a-cursor')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.listOccurrences(owner, schedule.id, 'not-a-cursor'))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create({
      userId: owner, amountMinor: 0, startsOn: '2026-01-15', cadence: 'MONTHLY', name: 'Bad',
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateFuture(owner, schedule.id, {}))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

function obligationService(clock?: () => Date): ObligationService {
  return new ObligationService(database(), clock);
}

async function createProfile(timezone = 'Europe/Moscow'): Promise<string> {
  const userId = randomUUID();
  await new ProfileService(new ProfileRepository(database()), () => PROFILE_NOW).upsert({
    userId, timezone, cadence: 'MONTHLY', firstPeriodEndsOn: '2026-01-31',
  });
  return userId;
}

async function currentPeriodId(userId: string): Promise<string> {
  return (await database().selectFrom('calculation_periods').select('id')
    .where('user_id', '=', userId).where('status', '=', 'OPEN').orderBy('starts_at').executeTakeFirstOrThrow()).id;
}

async function openPeriodIds(userId: string): Promise<string[]> {
  return (await database().selectFrom('calculation_periods').select('id')
    .where('user_id', '=', userId).where('status', '=', 'OPEN').orderBy('starts_at').execute()).map(({ id }) => id);
}

async function insertOpenPeriod(userId: string, startsAt: string, endsAt: string, endsOn: string): Promise<void> {
  await database().insertInto('calculation_periods').values({
    id: randomUUID(), user_id: userId, starts_at: new Date(startsAt),
    ends_at_exclusive: new Date(endsAt), ends_on_local: endsOn,
    timezone: 'Europe/Moscow', status: 'OPEN', closed_at: null,
  }).execute();
}

async function balanceByKind(userId: string, kind: AccountKind): Promise<number> {
  const row = await database().selectFrom('financial_accounts')
    .leftJoin('ledger_postings', (join) => join
      .onRef('ledger_postings.account_id', '=', 'financial_accounts.id')
      .onRef('ledger_postings.user_id', '=', 'financial_accounts.user_id'))
    .select(sql<string>`coalesce(sum(ledger_postings.amount_minor), 0)`.as('balance'))
    .where('financial_accounts.user_id', '=', userId)
    .where('financial_accounts.kind', '=', kind)
    .executeTakeFirstOrThrow();
  return Number(row.balance);
}

async function transactionCount(userId: string, type: string): Promise<number> {
  const row = await database().selectFrom('ledger_transactions')
    .select(sql<string>`count(*)`.as('count')).where('user_id', '=', userId)
    .where('type', '=', type).executeTakeFirstOrThrow();
  return Number(row.count);
}

async function postingAmount(userId: string, type: string, kind: AccountKind): Promise<number> {
  const row = await database().selectFrom('ledger_transactions')
    .innerJoin('ledger_postings', 'ledger_postings.transaction_id', 'ledger_transactions.id')
    .innerJoin('financial_accounts', 'financial_accounts.id', 'ledger_postings.account_id')
    .select('ledger_postings.amount_minor').where('ledger_transactions.user_id', '=', userId)
    .where('ledger_transactions.type', '=', type).where('financial_accounts.kind', '=', kind)
    .executeTakeFirstOrThrow();
  return Number(row.amount_minor);
}

async function reservedAmountForOccurrence(
  userId: string,
  scheduleId: string,
  occurrenceOn: string,
): Promise<number> {
  const row = await database().selectFrom('schedule_occurrences')
    .innerJoin('ledger_transactions', (join) => join
      .onRef('ledger_transactions.id', '=', 'schedule_occurrences.reservation_transaction_id')
      .onRef('ledger_transactions.source_occurrence_id', '=', 'schedule_occurrences.id'))
    .innerJoin('ledger_postings', 'ledger_postings.transaction_id', 'ledger_transactions.id')
    .innerJoin('financial_accounts', 'financial_accounts.id', 'ledger_postings.account_id')
    .select('ledger_postings.amount_minor')
    .where('schedule_occurrences.user_id', '=', userId)
    .where('schedule_occurrences.schedule_id', '=', scheduleId)
    .where(sql<boolean>`ledger_transactions.metadata ->> 'occurrenceOn' = ${occurrenceOn}`)
    .where('financial_accounts.kind', '=', 'OBLIGATION_RESERVE')
    .where('ledger_postings.amount_minor', '>', sql<never>`0`)
    .executeTakeFirstOrThrow();
  return Number(row.amount_minor);
}

async function accountBalanceBigInt(userId: string, accountId: string): Promise<bigint> {
  const row = await database().selectFrom('ledger_postings')
    .select(sql<string>`coalesce(sum(amount_minor), 0)`.as('balance'))
    .where('user_id', '=', userId).where('account_id', '=', accountId)
    .executeTakeFirstOrThrow();
  return BigInt(row.balance);
}

async function rowCount(table: 'obligation_schedules' | 'schedule_occurrences', userId: string): Promise<number> {
  const row = await database().selectFrom(table).select(sql<string>`count(*)`.as('count'))
    .where('user_id', '=', userId).executeTakeFirstOrThrow();
  return Number(row.count);
}

async function installReservationFailureTrigger(): Promise<void> {
  await sql`
    create function fail_obligation_reservation() returns trigger as $$
    begin
      if new.type = 'OBLIGATION_RESERVATION' then
        raise exception 'injected obligation reservation failure';
      end if;
      return new;
    end;
    $$ language plpgsql;
    create trigger fail_obligation_reservation_trigger before insert on ledger_transactions
      for each row execute function fail_obligation_reservation()
  `.execute(database());
}

async function dropReservationFailureTrigger(): Promise<void> {
  await sql`drop trigger if exists fail_obligation_reservation_trigger on ledger_transactions`.execute(database());
  await sql`drop function if exists fail_obligation_reservation()`.execute(database());
}

function database(): Kysely<Database> {
  if (!context) throw new Error('Database test context was not created');
  return context.db;
}
