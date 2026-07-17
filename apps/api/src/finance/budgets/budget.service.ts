import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { sql, type Kysely, type Transaction } from 'kysely';

import { DATABASE } from '../../database/database.constants';
import type {
  Database,
  ScheduleCadence,
} from '../../database/database.types';
import { assertMoneyMinor } from '../domain/money';
import { FinanceTransactionContext } from '../transaction/finance-transaction-context';
import { AccountRepository } from '../ledger/account.repository';
import { LedgerService } from '../ledger/ledger.service';
import {
  decodeListCursor,
  encodeListCursor,
  listCursorTimestamp,
} from '../shared/list-cursor';
import { calculateBudgetOccurrences } from './budget-calculator';
import {
  lockActiveBudgetPlan,
  lockActiveCategory,
  lockAllActiveBudgetPlans,
  releaseAndArchiveBudgetPlans,
  type LockedBudgetPlan,
} from './budget-locking';

const PAGE_SIZE = 50;
const SCHEDULE_CADENCES = new Set<ScheduleCadence>([
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'SEMIANNUAL',
  'ANNUAL',
]);

export interface CreateBudgetPlanInput {
  userId: string;
  categoryId: string;
  amountMinor: number;
  startsOn: string;
  cadence: ScheduleCadence;
}

export interface BudgetPlanPatch {
  amountMinor?: number;
  startsOn?: string;
  cadence?: ScheduleCadence;
}

export interface BudgetPlan {
  id: string;
  userId: string;
  categoryId: string;
  reserveAccountId: string;
  amountMinor: number;
  startsOn: string;
  cadence: ScheduleCadence;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

@Injectable()
export class BudgetService {
  private readonly ledger: LedgerService;
  private readonly accounts: AccountRepository;
  private readonly transactions: FinanceTransactionContext;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    @Optional() transactions?: FinanceTransactionContext,
  ) {
    this.ledger = new LedgerService(db);
    this.accounts = new AccountRepository(db);
    this.transactions = transactions ?? new FinanceTransactionContext();
  }

  async create(input: CreateBudgetPlanInput): Promise<BudgetPlan> {
    validateAmount(input.amountMinor);
    validateLocalDate(input.startsOn);
    validateCadence(input.cadence);

    return this.transactions.inTransaction(this.db, async (trx) => {
      const profile = await trx.selectFrom('financial_profiles').select('user_id')
        .where('user_id', '=', input.userId).forUpdate().executeTakeFirst();
      if (!profile) throw new NotFoundException('Financial profile not found');
      await lockActiveCategory(input.userId, input.categoryId, trx);
      const id = randomUUID();
      const reserveAccountId = randomUUID();
      const row = await trx.insertInto('budget_plans').values({
        id,
        user_id: input.userId,
        category_id: input.categoryId,
        amount_minor: input.amountMinor,
        starts_on: input.startsOn,
        cadence: input.cadence,
        archived_at: null,
      }).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto('financial_accounts').values({
        id: reserveAccountId,
        user_id: input.userId,
        kind: 'BUDGET_RESERVE',
        reference_id: id,
        name: null,
        target_amount_minor: null,
        archived_at: null,
      }).execute();
      return toBudgetPlan(row, reserveAccountId);
    });
  }

  async get(userId: string, id: string): Promise<BudgetPlan> {
    const row = await budgetPlanQuery(this.db, userId)
      .where('budget_plans.id', '=', id)
      .where('budget_plans.archived_at', 'is', null)
      .executeTakeFirst();
    if (!row) {
      throw new NotFoundException('Budget plan not found');
    }
    return toBudgetPlan(row, row.reserve_account_id);
  }

  async list(userId: string, cursor?: string): Promise<{
    items: BudgetPlan[];
    nextCursor: string | null;
  }> {
    const decoded = cursor ? decodeListCursor(cursor) : undefined;
    let query = budgetPlanQuery(this.db, userId)
      .select(
        sql<string>`((extract(epoch from budget_plans.created_at) * 1000000)::bigint)::text`
          .as('cursor_created_at_micros'),
      )
      .where('budget_plans.archived_at', 'is', null);
    if (decoded) {
      const createdAt = listCursorTimestamp(decoded.createdAtMicros);
      query = query.where(({ and, eb, or }) => or([
        eb('budget_plans.created_at', '<', createdAt),
        and([
          eb('budget_plans.created_at', '=', createdAt),
          eb('budget_plans.id', '<', decoded.id),
        ]),
      ]));
    }
    const rows = await query.orderBy('budget_plans.created_at', 'desc')
      .orderBy('budget_plans.id', 'desc')
      .limit(PAGE_SIZE + 1)
      .execute();
    const pageRows = rows.slice(0, PAGE_SIZE);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => toBudgetPlan(row, row.reserve_account_id)),
      nextCursor: rows.length > PAGE_SIZE && last
        ? encodeListCursor({
            createdAtMicros: last.cursor_created_at_micros,
            id: last.id,
          })
        : null,
    };
  }

  async update(
    userId: string,
    id: string,
    patch: BudgetPlanPatch,
    now: Date,
  ): Promise<BudgetPlan> {
    validateDate(now, 'now');
    if (patch.amountMinor !== undefined) {
      validateAmount(patch.amountMinor);
    }
    if (patch.startsOn !== undefined) {
      validateLocalDate(patch.startsOn);
    }
    if (patch.cadence !== undefined) {
      validateCadence(patch.cadence);
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('Budget plan patch must not be empty');
    }
    if (Object.keys(patch).some((key) => !['amountMinor', 'startsOn', 'cadence'].includes(key))) {
      throw new BadRequestException('Budget plan patch contains an unsupported field');
    }

    return this.transactions.inTransaction(this.db, async (trx) => {
      await lockActiveBudgetPlan(userId, id, trx);
      const row = await trx.updateTable('budget_plans').set({
        ...(patch.amountMinor === undefined
          ? {}
          : { amount_minor: sql<never>`${patch.amountMinor}::bigint` }),
        ...(patch.startsOn === undefined ? {} : { starts_on: patch.startsOn }),
        ...(patch.cadence === undefined ? {} : { cadence: patch.cadence }),
        updated_at: now,
      }).where('user_id', '=', userId)
        .where('id', '=', id)
        .where('archived_at', 'is', null)
        .returningAll()
        .executeTakeFirstOrThrow();
      const account = await trx.selectFrom('financial_accounts')
        .select('id')
        .where('user_id', '=', userId)
        .where('kind', '=', 'BUDGET_RESERVE')
        .where('reference_id', '=', id)
        .where('archived_at', 'is', null)
        .executeTakeFirstOrThrow();
      return toBudgetPlan(row, account.id);
    });
  }

  async archive(userId: string, id: string, now: Date = new Date()): Promise<void> {
    validateDate(now, 'now');
    await this.transactions.inTransaction(this.db, async (trx) => {
      const plan = await lockActiveBudgetPlan(userId, id, trx);
      await releaseAndArchiveBudgetPlans(userId, [plan], now, trx);
    });
  }

  async reconcilePeriod(
    userId: string,
    periodId: string,
    now: Date,
    trx?: Transaction<Database>,
  ): Promise<void> {
    validateDate(now, 'now');
    if (trx) {
      await this.reconcileInTransaction(userId, periodId, now, trx);
      return;
    }
    await this.transactions.inTransaction(this.db, (transaction) =>
      this.reconcileInTransaction(userId, periodId, now, transaction));
  }

  async reconcileOpenPeriods(
    userId: string,
    now: Date,
    trx?: Transaction<Database>,
  ): Promise<void> {
    validateDate(now, 'now');
    const work = async (transaction: Transaction<Database>) => {
      const profile = await transaction.selectFrom('financial_profiles')
        .select('user_id').where('user_id', '=', userId).forUpdate().executeTakeFirst();
      if (!profile) throw new NotFoundException('Financial profile not found');
      const periods = await transaction.selectFrom('calculation_periods')
        .selectAll().where('user_id', '=', userId).where('status', '=', 'OPEN')
        .orderBy('id').forUpdate().execute();
      await this.reconcileLockedPeriods(userId, periods, now, transaction);
    };
    if (trx) {
      await work(trx);
      return;
    }
    await this.transactions.inTransaction(this.db, work);
  }

  async releasePeriodRemainders(
    userId: string,
    periodId: string,
    releasedAt: Date,
    trx: Transaction<Database>,
    plans: readonly LockedBudgetPlan[],
  ): Promise<void> {
    validateDate(releasedAt, 'releasedAt');
    if (plans.length === 0) return;

    const planIds = plans.map(({ id }) => id);

    const reserveAccounts = await trx.selectFrom('financial_accounts')
      .select(['id', 'reference_id'])
      .where('user_id', '=', userId)
      .where('kind', '=', 'BUDGET_RESERVE')
      .where('reference_id', 'in', planIds)
      .where('archived_at', 'is', null)
      .orderBy('id')
      .execute();
    if (reserveAccounts.length !== planIds.length) {
      throw new NotFoundException('Budget reserve account not found');
    }
    const freeAccount = await trx.selectFrom('financial_accounts').select('id')
      .where('user_id', '=', userId).where('kind', '=', 'FREE')
      .where('archived_at', 'is', null).executeTakeFirst();
    if (!freeAccount) throw new NotFoundException('Financial profile not found');

    const locked = await this.accounts.lockPostingAccounts(
      userId,
      [freeAccount.id, ...reserveAccounts.map(({ id }) => id)],
      trx,
    );
    const balanceById = new Map(locked.map(({ id, balanceMinor }) => [id, balanceMinor]));
    const reserveByPlan = new Map(reserveAccounts.map(({ id, reference_id }) => [reference_id!, id]));
    for (const planId of planIds) {
      const reserveId = reserveByPlan.get(planId)!;
      const remainder = balanceById.get(reserveId) ?? 0n;
      if (remainder <= 0n) continue;
      const amountMinor = parseSafeBigInt(remainder, 'budget remainder');
      const release = await this.ledger.post({
        userId,
        type: 'BUDGET_RELEASE',
        effectiveAt: releasedAt,
        metadata: { budgetPlanId: planId, periodId },
        postings: [
          { accountId: reserveId, amountMinor: -amountMinor },
          { accountId: freeAccount.id, amountMinor },
        ],
      }, trx);
      await trx.updateTable('budget_allocations')
        .set({ released_transaction_id: release.id })
        .where('user_id', '=', userId)
        .where('period_id', '=', periodId)
        .where('budget_plan_id', '=', planId)
        .where('released_transaction_id', 'is', null)
        .execute();
    }
  }

  lockActivePlansForSettlement(
    userId: string,
    trx: Transaction<Database>,
  ): Promise<LockedBudgetPlan[]> {
    return lockAllActiveBudgetPlans(userId, trx);
  }

  private async reconcileInTransaction(
    userId: string,
    periodId: string,
    now: Date,
    trx: Transaction<Database>,
  ): Promise<void> {
    const period = await trx.selectFrom('calculation_periods')
      .selectAll()
      .where('user_id', '=', userId)
      .where('id', '=', periodId)
      .where('status', '=', 'OPEN')
      .forUpdate()
      .executeTakeFirst();
    if (!period) {
      throw new NotFoundException('Calculation period not found');
    }
    await this.reconcileLockedPeriods(userId, [period], now, trx);
  }

  private async reconcileLockedPeriods(
    userId: string,
    periods: ReadonlyArray<{
      id: string;
      starts_at: Date;
      ends_at_exclusive: Date;
      timezone: string;
    }>,
    now: Date,
    trx: Transaction<Database>,
  ): Promise<void> {
    if (periods.length === 0) return;
    const plans = await lockAllActiveBudgetPlans(userId, trx);
    if (plans.length === 0) {
      return;
    }
    const reserveAccounts = await trx.selectFrom('financial_accounts')
      .select(['id', 'reference_id'])
      .where('user_id', '=', userId)
      .where('kind', '=', 'BUDGET_RESERVE')
      .where('reference_id', 'in', plans.map(({ id }) => id))
      .where('archived_at', 'is', null)
      .orderBy('id')
      .execute();
    const reserveByPlan = new Map(reserveAccounts.map((account) => [
      account.reference_id!,
      account.id,
    ]));
    if (reserveByPlan.size !== plans.length) {
      throw new NotFoundException('Budget reserve account not found');
    }
    const freeAccount = await trx.selectFrom('financial_accounts')
      .select('id')
      .where('user_id', '=', userId)
      .where('kind', '=', 'FREE')
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (!freeAccount) {
      throw new NotFoundException('Financial profile not found');
    }
    await this.accounts.lockAccounts(
      userId,
      [freeAccount.id, ...reserveAccounts.map(({ id }) => id)],
      trx,
    );

    for (const period of periods) {
      const range = {
        startsOn: localDate(period.starts_at, period.timezone),
        endsOnExclusive: localDate(period.ends_at_exclusive, period.timezone),
      };
      for (const plan of plans) {
        const effectiveAt = plan.updated_at > period.starts_at
          ? plan.updated_at
          : period.starts_at;
        const notBefore = localDate(effectiveAt, period.timezone);
        const { occurrenceDates } = calculateBudgetOccurrences({
          amountMinor: parseMoney(plan.amount_minor),
          startsOn: plan.starts_on,
          cadence: plan.cadence,
        }, range, notBefore);
        if (occurrenceDates.length === 0) {
          continue;
        }
        const existing = await trx.selectFrom('budget_allocations')
          .select('occurrence_on')
          .where('user_id', '=', userId)
          .where('budget_plan_id', '=', plan.id)
          .where('period_id', '=', period.id)
          .where('occurrence_on', 'in', occurrenceDates)
          .execute();
        const existingDates = new Set(existing.map(({ occurrence_on }) => occurrence_on));
        for (const occurrenceOn of occurrenceDates) {
          if (existingDates.has(occurrenceOn)) {
            continue;
          }
          const amountMinor = parseMoney(plan.amount_minor);
          const reservation = await this.ledger.post({
            userId,
            type: 'BUDGET_RESERVATION',
            effectiveAt: now,
            metadata: { budgetPlanId: plan.id, periodId: period.id, occurrenceOn },
            postings: [
              { accountId: freeAccount.id, amountMinor: -amountMinor },
              { accountId: reserveByPlan.get(plan.id)!, amountMinor },
            ],
          }, trx);
          await trx.insertInto('budget_allocations').values({
            id: randomUUID(),
            user_id: userId,
            budget_plan_id: plan.id,
            period_id: period.id,
            occurrence_on: occurrenceOn,
            amount_minor: amountMinor,
            reservation_transaction_id: reservation.id,
            released_transaction_id: null,
          }).execute();
        }
      }
    }
  }
}

function budgetPlanQuery(executor: DatabaseExecutor, userId: string) {
  return executor.selectFrom('budget_plans')
    .innerJoin('financial_accounts', (join) => join
      .onRef('financial_accounts.reference_id', '=', 'budget_plans.id')
      .on('financial_accounts.kind', '=', 'BUDGET_RESERVE')
      .onRef('financial_accounts.user_id', '=', 'budget_plans.user_id'))
    .selectAll('budget_plans')
    .select('financial_accounts.id as reserve_account_id')
    .where('budget_plans.user_id', '=', userId);
}

function toBudgetPlan(row: {
  id: string;
  user_id: string;
  category_id: string;
  amount_minor: string;
  starts_on: string;
  cadence: ScheduleCadence;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}, reserveAccountId: string): BudgetPlan {
  return {
    id: row.id,
    userId: row.user_id,
    categoryId: row.category_id,
    reserveAccountId,
    amountMinor: parseMoney(row.amount_minor),
    startsOn: row.starts_on,
    cadence: row.cadence,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateAmount(value: number): void {
  try {
    assertMoneyMinor(value);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'Invalid amountMinor');
  }
}

function validateLocalDate(value: string): void {
  const date = DateTime.fromISO(value, { zone: 'UTC' }).startOf('day');
  if (!date.isValid || date.toISODate() !== value) {
    throw new BadRequestException('startsOn must be a valid ISO local date');
  }
}

function validateCadence(value: ScheduleCadence): void {
  if (!SCHEDULE_CADENCES.has(value)) {
    throw new BadRequestException('Invalid budget cadence');
  }
}

function validateDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new BadRequestException(`${field} must be a valid Date`);
  }
}

function localDate(value: Date, timezone: string): string {
  const date = DateTime.fromJSDate(value, { zone: timezone });
  if (!date.isValid) {
    throw new Error('Calculation period has an invalid timezone');
  }
  return date.toISODate()!;
}

function parseMoney(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('Stored budget amount exceeds the safe integer range');
  }
  return parsed;
}

function parseSafeBigInt(value: bigint, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Stored ${label} exceeds the safe integer range`);
  }
  return parsed;
}
