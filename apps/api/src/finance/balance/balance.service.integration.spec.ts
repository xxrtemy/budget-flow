import { randomUUID } from 'node:crypto';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Database } from '../../database/database.types';
import { BudgetService } from '../budgets/budget.service';
import { IncomeService } from '../income/income.service';
import { LedgerService } from '../ledger/ledger.service';
import { ObligationService } from '../obligations/obligation.service';
import { ProfileRepository } from '../profile/profile.repository';
import { ProfileService } from '../profile/profile.service';
import { ReconciliationService } from '../settlement/reconciliation.service';
import { SettlementService } from '../settlement/settlement.service';
import {
  createFinanceDatabaseTestContext,
  type FinanceDatabaseTestContext,
} from '../test/database-test-context';
import { BalanceService } from './balance.service';

const NOW = new Date('2026-01-15T12:00:00.000Z');
let context: FinanceDatabaseTestContext | undefined;

beforeAll(async () => { context = await createFinanceDatabaseTestContext(); });
beforeEach(async () => { await context?.reset(); });
afterAll(async () => { await context?.close(); });

describe('BalanceService', () => {
  test('returns an exact mixed asset projection, active goals, current period, and pending offers', async () => {
    const userId = await createProfile();
    const ids = await accountIds(userId);
    const goalId = randomUUID();
    await database().insertInto('financial_accounts').values({
      id: goalId, user_id: userId, kind: 'SAVINGS_GOAL', reference_id: goalId,
      name: 'Подушка', target_amount_minor: 100_000, archived_at: null,
    }).execute();
    await move(userId, ids.OPENING_EQUITY, ids.FREE, 100_000, 'OPENING_BALANCE');
    await move(userId, ids.FREE, ids.OBLIGATION_RESERVE, 10_000, 'OBLIGATION_RESERVATION');
    const budgetId = randomUUID();
    await database().insertInto('financial_accounts').values({
      id: budgetId, user_id: userId, kind: 'BUDGET_RESERVE', reference_id: randomUUID(),
      name: null, target_amount_minor: null, archived_at: null,
    }).execute();
    await move(userId, ids.FREE, budgetId, 15_000, 'BUDGET_RESERVATION');
    await move(userId, ids.FREE, ids.SAVINGS_GENERAL, 25_000, 'SAVINGS_TRANSFER');
    await move(userId, ids.FREE, goalId, 15_000, 'SAVINGS_TRANSFER');
    const period = await currentPeriod(userId);
    await database().insertInto('settlement_offers').values({
      id: randomUUID(), user_id: userId, period_id: period.id, offered_amount_minor: 5_000,
      accepted_amount_minor: null, status: 'PENDING', accepted_at: null,
      transfer_transaction_id: null,
    }).execute();

    const result = await balanceService().getWithoutReconciliation(userId, NOW);

    expect(result).toEqual({
      asOf: NOW, currency: 'RUB', actualMinor: 100_000, freeMinor: 35_000,
      obligationReserveMinor: 10_000, budgetReserveMinor: 15_000,
      savingsMinor: 40_000, savingsGeneralMinor: 25_000,
      goals: [{ id: goalId, name: 'Подушка', balanceMinor: 15_000, targetMinor: 100_000 }],
      deficitMinor: 0,
      currentPeriod: expect.objectContaining({ id: period.id, status: 'OPEN' }),
      pendingSettlementOffers: [expect.objectContaining({ offeredAmountMinor: 5_000, status: 'PENDING' })],
    });
  });

  test('reports negative FREE as an exact deficit without changing actual assets', async () => {
    const userId = await createProfile();
    const ids = await accountIds(userId);
    await move(userId, ids.FREE, ids.EXPENSE_SINK, 12_345, 'ORDINARY_EXPENSE');

    const result = await balanceService().getWithoutReconciliation(userId, NOW);
    expect(result.freeMinor).toBe(-12_345);
    expect(result.actualMinor).toBe(-12_345);
    expect(result.deficitMinor).toBe(12_345);
  });

  test('get reconciles exactly once before projecting while the internal method does not', async () => {
    const userId = await createProfile();
    const reconcileUser = vi.fn(async () => undefined);
    const service = new BalanceService(database(), { reconcileUser } as unknown as ReconciliationService);

    await service.get(userId, NOW);
    await service.getWithoutReconciliation(userId, NOW);

    expect(reconcileUser).toHaveBeenCalledTimes(1);
    expect(reconcileUser).toHaveBeenCalledWith(userId, NOW);
  });

  test('get performs real reconciliation, closes a due period, and projects its pending offer', async () => {
    const userId = randomUUID();
    await new ProfileService(new ProfileRepository(database()), () => new Date('2026-01-01T09:00:00Z'))
      .upsert({
        userId, timezone: 'Europe/Moscow', cadence: 'WEEKLY', firstPeriodEndsOn: '2026-01-02',
      });
    await new IncomeService(database()).createSchedule({
      userId, name: 'Income', amountMinor: 10_000, startsOn: '2026-01-02', cadence: 'WEEKLY',
    });
    const budgets = new BudgetService(database());
    const reconciliation = new ReconciliationService(
      database(), budgets, new ObligationService(database()), new IncomeService(database()),
      new SettlementService(database(), budgets),
    );
    const now = new Date('2026-01-03T12:00:00Z');

    const result = await new BalanceService(database(), reconciliation).get(userId, now);

    expect(result.freeMinor).toBe(10_000);
    expect(result.currentPeriod.startsAt).toEqual(new Date('2026-01-02T21:00:00.000Z'));
    expect(result.pendingSettlementOffers).toEqual([
      expect.objectContaining({ offeredAmountMinor: 10_000, status: 'PENDING' }),
    ]);
  });

  test('tenant-hides a missing profile or current open period', async () => {
    await expect(balanceService().getWithoutReconciliation(randomUUID(), NOW))
      .rejects.toBeInstanceOf(NotFoundException);
    const userId = await createProfile();
    await database().updateTable('calculation_periods').set({ status: 'CLOSED', closed_at: NOW })
      .where('user_id', '=', userId).execute();
    await expect(balanceService().getWithoutReconciliation(userId, NOW))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  test('rejects malformed tenant ids and timestamps before querying PostgreSQL', async () => {
    await expect(balanceService().getWithoutReconciliation('bad', NOW))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(balanceService().getWithoutReconciliation(randomUUID(), new Date('bad')))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

function balanceService(): BalanceService {
  return new BalanceService(
    database(),
    { async reconcileUser() {} } as unknown as ReconciliationService,
  );
}

async function createProfile(): Promise<string> {
  const userId = randomUUID();
  await new ProfileService(new ProfileRepository(database()), () => NOW).upsert({
    userId, timezone: 'Europe/Moscow', cadence: 'MONTHLY', firstPeriodEndsOn: '2026-01-31',
  });
  return userId;
}

async function accountIds(userId: string): Promise<Record<string, string>> {
  const rows = await database().selectFrom('financial_accounts').select(['id', 'kind'])
    .where('user_id', '=', userId).execute();
  return Object.fromEntries(rows.map(({ kind, id }) => [kind, id]));
}

function currentPeriod(userId: string) {
  return database().selectFrom('calculation_periods').selectAll()
    .where('user_id', '=', userId).where('status', '=', 'OPEN').executeTakeFirstOrThrow();
}

async function move(userId: string, from: string, to: string, amountMinor: number, type: Parameters<LedgerService['post']>[0]['type']) {
  await new LedgerService(database()).post({
    userId, type, effectiveAt: NOW,
    postings: [{ accountId: from, amountMinor: -amountMinor }, { accountId: to, amountMinor }],
  });
}

function database(): Kysely<Database> {
  if (!context) throw new Error('Database test context was not created');
  return context.db;
}
