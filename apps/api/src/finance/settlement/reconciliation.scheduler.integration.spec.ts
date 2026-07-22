import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { createFinanceDatabaseTestContext, type FinanceDatabaseTestContext } from '../test/database-test-context';
import type { ReconciliationService } from './reconciliation.service';
import { ReconciliationScheduler } from './reconciliation.scheduler';

const NOW = new Date('2026-07-20T10:00:00.000Z');
let context: FinanceDatabaseTestContext | undefined;

beforeAll(async () => { context = await createFinanceDatabaseTestContext(); });
beforeEach(async () => { await context?.reset(); });
afterAll(async () => { await context?.close(); });

describe('ReconciliationScheduler', () => {
  test('selects candidate users deterministically once and isolates a failed user', async () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const first = '00000000-0000-4000-8000-000000000001';
    const second = '00000000-0000-4000-8000-000000000002';
    const third = '00000000-0000-4000-8000-000000000003';
    for (const userId of [third, first, second]) await insertProfile(userId);
    await database().updateTable('calculation_periods')
      .set({ ends_at_exclusive: new Date('2026-07-20T09:00:00.000Z') })
      .where('user_id', 'in', [first, second]).execute();
    await database().insertInto('income_schedules').values({
      id: randomUUID(), user_id: third, name: 'active', amount_minor: 1,
      starts_on: '2026-07-21', cadence: 'DAILY', archived_at: null,
    }).execute();

    const calls: Array<{ userId: string; now: Date }> = [];
    const reconciliation = {
      reconcileUser: vi.fn(async (userId: string, now: Date) => {
        calls.push({ userId, now });
        if (userId === first) throw new Error('isolated failure');
      }),
    } as unknown as ReconciliationService;
    const scheduler = new ReconciliationScheduler(database(), reconciliation, () => NOW);

    await scheduler.reconcileDueUsers();

    expect(calls.map(({ userId }) => userId)).toEqual([first, second, third]);
    expect(calls.every(({ now }) => now === NOW)).toBe(true);
    expect(new Set(calls.map(({ userId }) => userId)).size).toBe(calls.length);
    expect(errorLog).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });
});

async function insertProfile(userId: string): Promise<void> {
  await database().insertInto('financial_profiles').values({
    user_id: userId, currency: 'RUB', timezone: 'Europe/Moscow', cadence: 'WEEKLY',
    next_period_ends_on: '2026-07-26', cycle_anchor_day: 26,
  }).execute();
  await database().insertInto('calculation_periods').values({
    id: randomUUID(), user_id: userId, starts_at: new Date('2026-07-13T00:00:00.000Z'),
    ends_at_exclusive: new Date('2026-07-27T00:00:00.000Z'), ends_on_local: '2026-07-26',
    timezone: 'Europe/Moscow', status: 'OPEN', closed_at: null,
  }).execute();
}

function database() {
  if (!context) throw new Error('database context missing');
  return context.db;
}
