import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { createDatabase } from '../../database/database.factory';
import type { Database } from '../../database/database.types';
import { migrateToLatest } from '../../database/migrator';
import { ProfileRepository } from './profile.repository';
import { ProfileService } from './profile.service';

const NOW = new Date('2026-07-10T11:42:13.456Z');

interface ProfileDatabaseTestContext {
  db: Kysely<Database>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

let context: ProfileDatabaseTestContext | undefined;

beforeAll(async () => { context = await createDatabaseTestContext(); });
beforeEach(async () => { await context?.reset(); });
afterAll(async () => { await context?.close(); });

describe('ProfileService', () => {
  test('atomically creates a profile, its system accounts, and its first open period', async () => {
    const userId = randomUUID();
    const service = profileService();

    const profile = await service.upsert({
      userId,
      cadence: 'MONTHLY',
      firstPeriodEndsOn: '2026-07-25',
    });

    expect(profile).toEqual({
      userId,
      currency: 'RUB',
      timezone: 'Europe/Moscow',
      cadence: 'MONTHLY',
      createdAt: expect.any(Date),
    });
    await expect(service.get(userId)).resolves.toEqual(profile);

    const period = await service.getCurrentPeriod(userId);
    expect(period).toMatchObject({
      userId,
      startsAt: NOW,
      endsAtExclusive: new Date('2026-07-25T21:00:00.000Z'),
      endsOnLocal: '2026-07-25',
      timezone: 'Europe/Moscow',
      status: 'OPEN',
      closedAt: null,
    });

    const accounts = await database()
      .selectFrom('financial_accounts')
      .select(['kind', 'reference_id', 'name'])
      .where('user_id', '=', userId)
      .orderBy('kind')
      .execute();
    expect(accounts).toEqual([
      { kind: 'EXPENSE_SINK', reference_id: null, name: null },
      { kind: 'FREE', reference_id: null, name: null },
      { kind: 'INCOME_SOURCE', reference_id: null, name: null },
      { kind: 'OBLIGATION_RESERVE', reference_id: null, name: null },
      { kind: 'OPENING_EQUITY', reference_id: null, name: null },
      { kind: 'SAVINGS_GENERAL', reference_id: null, name: null },
    ]);

    const storedProfile = await database()
      .selectFrom('financial_profiles')
      .select([
        sql<string>`next_period_ends_on::text`.as('next_period_ends_on'),
        'cycle_anchor_day',
      ])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(storedProfile).toEqual({
      next_period_ends_on: '2026-08-25',
      cycle_anchor_day: 25,
    });
  });

  test('updates the future cadence without changing the open period', async () => {
    const userId = randomUUID();
    const service = profileService();
    await service.upsert({
      userId,
      timezone: 'Europe/Moscow',
      cadence: 'MONTHLY',
      firstPeriodEndsOn: '2026-07-31',
    });
    const periodBefore = await service.getCurrentPeriod(userId);

    const updated = await service.upsert({
      userId,
      timezone: 'America/New_York',
      cadence: 'ANNUAL',
      firstPeriodEndsOn: '2027-02-28',
    });

    expect(updated).toMatchObject({
      userId,
      timezone: 'America/New_York',
      cadence: 'ANNUAL',
    });
    await expect(service.getCurrentPeriod(userId)).resolves.toEqual(periodBefore);

    const storedProfile = await database()
      .selectFrom('financial_profiles')
      .select([
        sql<string>`next_period_ends_on::text`.as('next_period_ends_on'),
        'cycle_anchor_day',
      ])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(storedProfile).toEqual({
      next_period_ends_on: '2027-02-28',
      cycle_anchor_day: 28,
    });
  });

  test('preserves a date-only period label outside the process timezone', async () => {
    const userId = randomUUID();
    const service = profileService();

    await service.upsert({
      userId,
      timezone: 'America/New_York',
      cadence: 'MONTHLY',
      firstPeriodEndsOn: '2026-11-01',
    });

    await expect(service.getCurrentPeriod(userId)).resolves.toMatchObject({
      endsOnLocal: '2026-11-01',
      endsAtExclusive: new Date('2026-11-02T05:00:00.000Z'),
      timezone: 'America/New_York',
    });
  });

  test('returns undefined when a profile or open period does not exist', async () => {
    const service = profileService();
    const userId = randomUUID();

    await expect(service.get(userId)).resolves.toBeUndefined();
    await expect(service.getCurrentPeriod(userId)).resolves.toBeUndefined();
  });
});

function profileService(): ProfileService {
  return new ProfileService(new ProfileRepository(database()), () => NOW);
}

function database(): Kysely<Database> {
  if (!context) {
    throw new Error('Database test context was not created');
  }
  return context.db;
}

async function createDatabaseTestContext(): Promise<ProfileDatabaseTestContext> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const db = createDatabase(container.getConnectionUri());
  await migrateToLatest(db);

  return {
    db,
    async reset(): Promise<void> {
      await sql`
        truncate table
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
