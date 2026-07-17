import { randomUUID } from 'node:crypto';

import type { Kysely, Selectable, Transaction } from 'kysely';
import { sql } from 'kysely';

import type {
  Database,
  IncomeSchedulesTable,
  LedgerTransactionsTable,
  ScheduleCadence,
} from '../../database/database.types';
import type { ListCursor } from '../shared/list-cursor';
import { listCursorTimestamp } from '../shared/list-cursor';

export type IncomeScheduleRow = Selectable<IncomeSchedulesTable>;
export type IncomeTransactionRow = Selectable<LedgerTransactionsTable> & {
  cursor_created_at_micros: string;
};
export type IncomeScheduleCursorRow = IncomeScheduleRow & {
  cursor_created_at_micros: string;
};

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

export interface CreateIncomeScheduleData {
  userId: string;
  name: string;
  amountMinor: number;
  startsOn: string;
  cadence: ScheduleCadence;
}

export interface UpdateIncomeScheduleData {
  name?: string;
  amountMinor?: number;
  startsOn?: string;
  cadence?: ScheduleCadence;
  updatedAt: Date;
}

export class IncomeRepository {
  constructor(private readonly db: Kysely<Database>) {}

  findProfileForUpdate(
    userId: string,
    trx: Transaction<Database>,
  ): Promise<{ timezone: string } | undefined> {
    return trx.selectFrom('financial_profiles')
      .select('timezone')
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
  }

  createSchedule(
    data: CreateIncomeScheduleData,
    executor: DatabaseExecutor = this.db,
  ): Promise<IncomeScheduleRow> {
    return executor.insertInto('income_schedules').values({
      id: randomUUID(),
      user_id: data.userId,
      name: data.name,
      amount_minor: data.amountMinor,
      starts_on: data.startsOn,
      cadence: data.cadence,
      archived_at: null,
    }).returningAll().executeTakeFirstOrThrow();
  }

  findActiveSchedule(
    userId: string,
    id: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<IncomeScheduleRow | undefined> {
    return executor.selectFrom('income_schedules')
      .selectAll()
      .where('user_id', '=', userId)
      .where('id', '=', id)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
  }

  lockActiveSchedule(
    userId: string,
    id: string,
    trx: Transaction<Database>,
  ): Promise<IncomeScheduleRow | undefined> {
    return trx.selectFrom('income_schedules')
      .selectAll()
      .where('user_id', '=', userId)
      .where('id', '=', id)
      .where('archived_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
  }

  lockActiveSchedules(
    userId: string,
    trx: Transaction<Database>,
  ): Promise<IncomeScheduleRow[]> {
    return trx.selectFrom('income_schedules')
      .selectAll()
      .where('user_id', '=', userId)
      .where('archived_at', 'is', null)
      .orderBy('id')
      .forUpdate()
      .execute();
  }

  updateSchedule(
    userId: string,
    id: string,
    data: UpdateIncomeScheduleData,
    trx: Transaction<Database>,
  ): Promise<IncomeScheduleRow> {
    return trx.updateTable('income_schedules').set({
      ...(data.name === undefined ? {} : { name: data.name }),
      ...(data.amountMinor === undefined
        ? {}
        : { amount_minor: sql<never>`${data.amountMinor}::bigint` }),
      ...(data.startsOn === undefined ? {} : { starts_on: data.startsOn }),
      ...(data.cadence === undefined ? {} : { cadence: data.cadence }),
      updated_at: data.updatedAt,
    }).where('user_id', '=', userId)
      .where('id', '=', id)
      .where('archived_at', 'is', null)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async archiveSchedule(
    userId: string,
    id: string,
    archivedAt: Date,
    trx: Transaction<Database>,
  ): Promise<boolean> {
    const row = await trx.updateTable('income_schedules').set({
      archived_at: archivedAt,
      updated_at: archivedAt,
    }).where('user_id', '=', userId)
      .where('id', '=', id)
      .where('archived_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    return Boolean(row);
  }

  async listActiveSchedules(
    userId: string,
    cursor: ListCursor | undefined,
    limit: number,
  ): Promise<IncomeScheduleCursorRow[]> {
    let query = this.db.selectFrom('income_schedules')
      .selectAll()
      .select(
        sql<string>`((extract(epoch from created_at) * 1000000)::bigint)::text`
          .as('cursor_created_at_micros'),
      )
      .where('user_id', '=', userId)
      .where('archived_at', 'is', null);
    if (cursor) {
      const createdAt = listCursorTimestamp(cursor.createdAtMicros);
      query = query.where(({ and, eb, or }) => or([
        eb('created_at', '<', createdAt),
        and([
          eb('created_at', '=', createdAt),
          eb('id', '<', cursor.id),
        ]),
      ]));
    }
    return query.orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  }

  async listOneOffTransactions(
    userId: string,
    cursor: ListCursor | undefined,
    limit: number,
  ): Promise<IncomeTransactionRow[]> {
    let query = this.db.selectFrom('ledger_transactions')
      .selectAll()
      .select(
        sql<string>`((extract(epoch from created_at) * 1000000)::bigint)::text`
          .as('cursor_created_at_micros'),
      )
      .where('user_id', '=', userId)
      .where('type', '=', 'INCOME')
      .where('source_occurrence_id', 'is', null);
    if (cursor) {
      const createdAt = listCursorTimestamp(cursor.createdAtMicros);
      query = query.where(({ and, eb, or }) => or([
        eb('created_at', '<', createdAt),
        and([
          eb('created_at', '=', createdAt),
          eb('id', '<', cursor.id),
        ]),
      ]));
    }
    return query.orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  }
}
