import { randomUUID } from 'node:crypto';

import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';

import type {
  CalculationPeriodsTable,
  Database,
  ObligationSchedulesTable,
  ScheduleCadence,
  ScheduleOccurrencesTable,
} from '../../database/database.types';
import type { ListCursor } from '../shared/list-cursor';
import { listCursorTimestamp } from '../shared/list-cursor';

export type ObligationScheduleRow = Selectable<ObligationSchedulesTable>;
export type ObligationOccurrenceRow = Selectable<ScheduleOccurrencesTable>;
export type ObligationPeriodRow = Selectable<CalculationPeriodsTable>;

type Executor = Kysely<Database> | Transaction<Database>;

export class ObligationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  findProfileForUpdate(userId: string, trx: Transaction<Database>) {
    return trx.selectFrom('financial_profiles').select(['user_id', 'timezone'])
      .where('user_id', '=', userId).forUpdate().executeTakeFirst();
  }

  createSchedule(input: {
    userId: string;
    name: string;
    amountMinor: number;
    startsOn: string;
    cadence: ScheduleCadence;
    commandTime: Date;
  }, trx: Transaction<Database>): Promise<ObligationScheduleRow> {
    return trx.insertInto('obligation_schedules').values({
      id: randomUUID(),
      user_id: input.userId,
      name: input.name,
      amount_minor: input.amountMinor,
      starts_on: input.startsOn,
      cadence: input.cadence,
      created_at: input.commandTime,
      updated_at: input.commandTime,
    }).returningAll().executeTakeFirstOrThrow();
  }

  findSchedule(userId: string, id: string, executor: Executor = this.db) {
    return executor.selectFrom('obligation_schedules').selectAll()
      .where('user_id', '=', userId).where('id', '=', id).executeTakeFirst();
  }

  lockSchedule(userId: string, id: string, trx: Transaction<Database>) {
    return trx.selectFrom('obligation_schedules').selectAll()
      .where('user_id', '=', userId).where('id', '=', id)
      .forUpdate().executeTakeFirst();
  }

  lockSchedules(userId: string, trx: Transaction<Database>) {
    return trx.selectFrom('obligation_schedules').selectAll()
      .where('user_id', '=', userId).orderBy('id').forUpdate().execute();
  }

  async listSchedules(userId: string, cursor: ListCursor | undefined, limit: number) {
    let query = this.db.selectFrom('obligation_schedules').selectAll()
      .select(sql<string>`((extract(epoch from created_at) * 1000000)::bigint)::text`
        .as('cursor_created_at_micros'))
      .where('user_id', '=', userId);
    if (cursor) {
      const at = listCursorTimestamp(cursor.createdAtMicros);
      query = query.where(({ and, eb, or }) => or([
        eb('created_at', '<', at),
        and([eb('created_at', '=', at), eb('id', '<', cursor.id)]),
      ]));
    }
    return query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
  }

  updateSchedule(userId: string, id: string, patch: {
    name?: string;
    amountMinor?: number;
    startsOn?: string;
    cadence?: ScheduleCadence;
    updatedAt: Date;
  }, trx: Transaction<Database>): Promise<ObligationScheduleRow> {
    return trx.updateTable('obligation_schedules').set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.amountMinor === undefined ? {} : { amount_minor: sql<never>`${patch.amountMinor}::bigint` }),
      ...(patch.startsOn === undefined ? {} : { starts_on: patch.startsOn }),
      ...(patch.cadence === undefined ? {} : { cadence: patch.cadence }),
      updated_at: patch.updatedAt,
    }).where('user_id', '=', userId).where('id', '=', id)
      .returningAll().executeTakeFirstOrThrow();
  }

  lockOpenPeriods(userId: string, trx: Transaction<Database>): Promise<ObligationPeriodRow[]> {
    return trx.selectFrom('calculation_periods').selectAll()
      .where('user_id', '=', userId).where('status', '=', 'OPEN')
      .orderBy('id').forUpdate().execute();
  }

  lockPeriod(userId: string, periodId: string, trx: Transaction<Database>) {
    return trx.selectFrom('calculation_periods').selectAll()
      .where('user_id', '=', userId).where('id', '=', periodId)
      .where('status', '=', 'OPEN').forUpdate().executeTakeFirst();
  }

  lockOccurrences(userId: string, scheduleIds: readonly string[], trx: Transaction<Database>) {
    if (scheduleIds.length === 0) return Promise.resolve([]);
    return trx.selectFrom('schedule_occurrences').selectAll()
      .where('user_id', '=', userId).where('schedule_type', '=', 'OBLIGATION')
      .where('schedule_id', 'in', [...scheduleIds]).orderBy('id').forUpdate().execute();
  }

  async loadOccurrenceOns(
    userId: string,
    scheduleIds: readonly string[],
    executor: Executor,
  ): Promise<Map<string, Set<string>>> {
    if (scheduleIds.length === 0) return new Map();
    const rows = await executor.selectFrom('schedule_occurrences')
      .innerJoin('ledger_transactions', (join) => join
        .onRef('ledger_transactions.id', '=', 'schedule_occurrences.reservation_transaction_id')
        .onRef('ledger_transactions.source_occurrence_id', '=', 'schedule_occurrences.id')
        .onRef('ledger_transactions.user_id', '=', 'schedule_occurrences.user_id'))
      .select([
        'schedule_occurrences.schedule_id',
        sql<string>`ledger_transactions.metadata ->> 'occurrenceOn'`.as('occurrence_on'),
      ])
      .where('schedule_occurrences.user_id', '=', userId)
      .where('schedule_occurrences.schedule_type', '=', 'OBLIGATION')
      .where('schedule_occurrences.schedule_id', 'in', [...scheduleIds])
      .where('ledger_transactions.type', '=', 'OBLIGATION_RESERVATION')
      .execute();
    const result = new Map<string, Set<string>>();
    for (const row of rows) {
      const dates = result.get(row.schedule_id) ?? new Set<string>();
      if (!row.occurrence_on) throw new Error('Obligation reservation metadata is missing occurrenceOn');
      dates.add(row.occurrence_on);
      result.set(row.schedule_id, dates);
    }
    return result;
  }

  async listOccurrences(
    userId: string,
    scheduleId: string,
    cursor: ListCursor | undefined,
    limit: number,
  ) {
    let query = this.db.selectFrom('schedule_occurrences')
      .innerJoin('ledger_transactions', (join) => join
        .onRef('ledger_transactions.id', '=', 'schedule_occurrences.reservation_transaction_id')
        .onRef('ledger_transactions.source_occurrence_id', '=', 'schedule_occurrences.id')
        .onRef('ledger_transactions.user_id', '=', 'schedule_occurrences.user_id'))
      .selectAll('schedule_occurrences')
      .select([
        sql<string>`ledger_transactions.metadata ->> 'occurrenceOn'`.as('occurrence_on'),
        sql<string>`((extract(epoch from schedule_occurrences.created_at) * 1000000)::bigint)::text`
          .as('cursor_created_at_micros'),
      ])
      .where('schedule_occurrences.user_id', '=', userId)
      .where('schedule_occurrences.schedule_type', '=', 'OBLIGATION')
      .where('schedule_occurrences.schedule_id', '=', scheduleId)
      .where('ledger_transactions.type', '=', 'OBLIGATION_RESERVATION');
    if (cursor) {
      const at = listCursorTimestamp(cursor.createdAtMicros);
      query = query.where(({ and, eb, or }) => or([
        eb('schedule_occurrences.created_at', '<', at),
        and([
          eb('schedule_occurrences.created_at', '=', at),
          eb('schedule_occurrences.id', '<', cursor.id),
        ]),
      ]));
    }
    return query.orderBy('schedule_occurrences.created_at', 'desc')
      .orderBy('schedule_occurrences.id', 'desc').limit(limit).execute();
  }

  async reservationDetails(
    userId: string,
    occurrences: readonly ObligationOccurrenceRow[],
    executor: Executor,
  ): Promise<Map<string, { amountMinor: number; occurrenceOn: string }>> {
    const transactionIds = occurrences.map(({ reservation_transaction_id }) => reservation_transaction_id)
      .filter((id): id is string => id !== null);
    if (transactionIds.length === 0) return new Map();
    const rows = await executor.selectFrom('ledger_transactions')
      .innerJoin('ledger_postings', (join) => join
        .onRef('ledger_postings.transaction_id', '=', 'ledger_transactions.id')
        .onRef('ledger_postings.user_id', '=', 'ledger_transactions.user_id'))
      .innerJoin('financial_accounts', (join) => join
        .onRef('financial_accounts.id', '=', 'ledger_postings.account_id')
        .onRef('financial_accounts.user_id', '=', 'ledger_postings.user_id'))
      .select([
        'ledger_transactions.source_occurrence_id',
        'ledger_transactions.metadata',
        'ledger_postings.amount_minor',
      ])
      .where('ledger_transactions.user_id', '=', userId)
      .where('ledger_transactions.id', 'in', transactionIds)
      .where('ledger_transactions.type', '=', 'OBLIGATION_RESERVATION')
      .where('financial_accounts.kind', '=', 'OBLIGATION_RESERVE')
      .where('ledger_postings.amount_minor', '>', sql<never>`0`)
      .execute();
    return new Map(rows.map((row) => {
      if (!row.source_occurrence_id) throw new Error('Reservation is not linked to an occurrence');
      const amount = Number(row.amount_minor);
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Invalid reserved amount');
      const occurrenceOn = (row.metadata as Record<string, unknown>).occurrenceOn;
      if (typeof occurrenceOn !== 'string') throw new Error('Reservation metadata is missing occurrenceOn');
      return [row.source_occurrence_id, { amountMinor: amount, occurrenceOn }];
    }));
  }
}
