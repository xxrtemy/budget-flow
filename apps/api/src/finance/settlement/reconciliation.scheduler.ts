import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { sql, type Kysely } from 'kysely';

import { DATABASE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { FINANCE_CLOCK, type FinanceClock } from '../finance.constants';
import { ReconciliationService } from './reconciliation.service';

@Injectable()
export class ReconciliationScheduler {
  private readonly logger = new Logger(ReconciliationScheduler.name);

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    private readonly reconciliation: ReconciliationService,
    @Inject(FINANCE_CLOCK) private readonly clock: FinanceClock,
  ) {}

  @Cron(process.env.RECONCILIATION_CRON ?? '* * * * *')
  async reconcileDueUsers(): Promise<void> {
    const now = this.clock();
    const candidates = await sql<{ user_id: string }>`
      select candidate.user_id
      from (
        select user_id from calculation_periods
          where status = 'OPEN' and ends_at_exclusive <= ${now}
        union
        select user_id from schedule_occurrences
          where status in ('PENDING', 'RESERVED') and due_at <= ${now}
        union
        select user_id from income_schedules where archived_at is null
        union
        select user_id from obligation_schedules
        union
        select user_id from budget_plans where archived_at is null
      ) candidate
      order by candidate.user_id
    `.execute(this.db);
    for (const { user_id: userId } of candidates.rows) {
      try {
        await this.reconciliation.reconcileUser(userId, now);
      } catch (error) {
        this.logger.error(`Reconciliation failed for user ${userId}`, error);
      }
    }
  }
}
