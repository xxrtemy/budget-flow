import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';

import { DATABASE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { BudgetService } from '../budgets/budget.service';
import { IncomeService } from '../income/income.service';
import { ObligationService } from '../obligations/obligation.service';

export const PERIOD_CLOSER = Symbol('PERIOD_CLOSER');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PeriodCloser {
  closeDuePeriods(userId: string, now: Date, trx: Transaction<Database>): Promise<void>;
}

@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    private readonly budgets: BudgetService,
    private readonly obligations: ObligationService,
    private readonly incomes: IncomeService,
    @Inject(PERIOD_CLOSER) private readonly periodCloser: PeriodCloser,
  ) {}

  async reconcileUser(userId: string, now: Date): Promise<void> {
    if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) {
      throw new BadRequestException('userId must be a valid UUID');
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new BadRequestException('now must be a valid Date');
    }
    await this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`.execute(trx);
      await this.ensureOpenPeriodsAndLockUserState(userId, trx);
      for (;;) {
        const beforePeriodId = await this.openPeriodId(userId, trx);
        await this.budgets.reconcileOpenPeriods(userId, now, trx);
        await this.obligations.reserveOpenPeriods(userId, now, trx);
        await this.incomes.materializeAndApplyDue(userId, now, trx);
        await this.obligations.applyDue(userId, now, trx);
        await this.periodCloser.closeDuePeriods(userId, now, trx);
        const afterPeriodId = await this.openPeriodId(userId, trx);
        if (beforePeriodId === afterPeriodId) break;
      }
    });
  }

  private async openPeriodId(userId: string, trx: Transaction<Database>): Promise<string> {
    const period = await trx.selectFrom('calculation_periods').select('id')
      .where('user_id', '=', userId).where('status', '=', 'OPEN')
      .orderBy('starts_at').orderBy('id').executeTakeFirst();
    if (!period) {
      throw new NotFoundException('Current calculation period not found');
    }
    return period.id;
  }

  private async ensureOpenPeriodsAndLockUserState(
    userId: string,
    trx: Transaction<Database>,
  ): Promise<void> {
    const profile = await trx.selectFrom('financial_profiles').select('user_id')
      .where('user_id', '=', userId).forUpdate().executeTakeFirst();
    if (!profile) throw new NotFoundException('Financial profile not found');

    const periods = await trx.selectFrom('calculation_periods').select('id')
      .where('user_id', '=', userId).where('status', '=', 'OPEN')
      .orderBy('id').forUpdate().execute();
    if (periods.length === 0) {
      throw new NotFoundException('Current calculation period not found');
    }

    // Reconciliation keeps this complete, deterministic lock prefix for the
    // whole transaction. Domain services may re-lock the same rows, but never
    // discover a larger set after ledger accounts have been locked.
    await trx.selectFrom('categories').select('id').where('user_id', '=', userId)
      .orderBy('id').forUpdate().execute();
    await trx.selectFrom('budget_plans').select('id').where('user_id', '=', userId)
      .orderBy('id').forUpdate().execute();
    await trx.selectFrom('income_schedules').select('id').where('user_id', '=', userId)
      .orderBy('id').forUpdate().execute();
    await trx.selectFrom('obligation_schedules').select('id').where('user_id', '=', userId)
      .orderBy('id').forUpdate().execute();
    await trx.selectFrom('schedule_occurrences').select('id').where('user_id', '=', userId)
      .orderBy('id').forUpdate().execute();
    await trx.selectFrom('financial_accounts').select('id').where('user_id', '=', userId)
      .orderBy('id').forUpdate().execute();
  }
}
