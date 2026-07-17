import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import type { Kysely, Transaction } from 'kysely';

import { DATABASE } from '../../database/database.constants';
import type { Database, ScheduleCadence } from '../../database/database.types';
import { assertMoneyMinor } from '../domain/money';
import { localDateToInstant, occurrencesWithin } from '../domain/recurrence';
import { AccountRepository } from '../ledger/account.repository';
import { LedgerService } from '../ledger/ledger.service';
import type {
  LedgerPosting,
  LedgerTransaction,
  LedgerTransactionType,
} from '../ledger/ledger.types';
import {
  decodeListCursor,
  encodeListCursor,
} from '../shared/list-cursor';
import {
  IncomeRepository,
  type IncomeScheduleRow,
  type IncomeTransactionRow,
} from './income.repository';

const PAGE_SIZE = 50;
const SCHEDULE_CADENCES = new Set<ScheduleCadence>([
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'SEMIANNUAL',
  'ANNUAL',
]);

export interface OneOffIncomeInput {
  userId: string;
  amountMinor: number;
  effectiveAt: Date;
  name?: string;
}

export interface IncomeScheduleInput {
  userId: string;
  amountMinor: number;
  startsOn: string;
  cadence: ScheduleCadence;
  name: string;
}

export interface IncomeSchedulePatch {
  amountMinor?: number;
  startsOn?: string;
  cadence?: ScheduleCadence;
  name?: string;
}

export interface IncomeSchedule {
  id: string;
  userId: string;
  amountMinor: number;
  startsOn: string;
  cadence: ScheduleCadence;
  name: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type IncomeClock = () => Date;

@Injectable()
export class IncomeService {
  private readonly repository: IncomeRepository;
  private readonly ledger: LedgerService;
  private readonly accounts: AccountRepository;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    private readonly clock: IncomeClock = () => new Date(),
  ) {
    this.repository = new IncomeRepository(db);
    this.ledger = new LedgerService(db);
    this.accounts = new AccountRepository(db);
  }

  async createOneOff(input: OneOffIncomeInput): Promise<LedgerTransaction> {
    validateAmount(input.amountMinor);
    validateDate(input.effectiveAt, 'effectiveAt');
    const name = input.name === undefined ? undefined : validateName(input.name);

    return this.db.transaction().execute(async (trx) => {
      const accounts = await this.accounts.findByKinds(
        input.userId,
        ['INCOME_SOURCE', 'FREE'],
        trx,
      );
      const sourceId = accounts.find(({ kind }) => kind === 'INCOME_SOURCE')?.id;
      const freeId = accounts.find(({ kind }) => kind === 'FREE')?.id;
      if (!sourceId || !freeId) {
        throw new NotFoundException('Financial profile not found');
      }

      return this.ledger.post({
        userId: input.userId,
        type: 'INCOME',
        effectiveAt: input.effectiveAt,
        metadata: name === undefined ? {} : { name },
        postings: [
          { accountId: sourceId, amountMinor: -input.amountMinor },
          { accountId: freeId, amountMinor: input.amountMinor },
        ],
      }, trx);
    });
  }

  async listOneOff(userId: string, cursor?: string): Promise<{
    items: LedgerTransaction[];
    nextCursor: string | null;
  }> {
    const decoded = cursor ? decodeListCursor(cursor) : undefined;
    const rows = await this.repository.listOneOffTransactions(
      userId,
      decoded,
      PAGE_SIZE + 1,
    );
    const pageRows = rows.slice(0, PAGE_SIZE);
    const items = await this.loadTransactions(userId, pageRows);
    const last = pageRows.at(-1);
    return {
      items,
      nextCursor: rows.length > PAGE_SIZE && last
        ? encodeListCursor({
            createdAtMicros: last.cursor_created_at_micros,
            id: last.id,
          })
        : null,
    };
  }

  async createSchedule(input: IncomeScheduleInput): Promise<IncomeSchedule> {
    validateAmount(input.amountMinor);
    validateLocalDate(input.startsOn);
    validateCadence(input.cadence);
    const name = validateName(input.name);

    return this.db.transaction().execute(async (trx) => {
      await this.requireProfileLock(input.userId, trx);
      const row = await this.repository.createSchedule({
        userId: input.userId,
        amountMinor: input.amountMinor,
        startsOn: input.startsOn,
        cadence: input.cadence,
        name,
      }, trx);
      return toIncomeSchedule(row);
    });
  }

  async getSchedule(userId: string, id: string): Promise<IncomeSchedule> {
    const row = await this.repository.findActiveSchedule(userId, id);
    if (!row) {
      throw new NotFoundException('Income schedule not found');
    }
    return toIncomeSchedule(row);
  }

  async listSchedules(userId: string, cursor?: string): Promise<{
    items: IncomeSchedule[];
    nextCursor: string | null;
  }> {
    const decoded = cursor ? decodeListCursor(cursor) : undefined;
    const rows = await this.repository.listActiveSchedules(
      userId,
      decoded,
      PAGE_SIZE + 1,
    );
    const pageRows = rows.slice(0, PAGE_SIZE);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toIncomeSchedule),
      nextCursor: rows.length > PAGE_SIZE && last
        ? encodeListCursor({
            createdAtMicros: last.cursor_created_at_micros,
            id: last.id,
          })
        : null,
    };
  }

  async updateSchedule(
    userId: string,
    id: string,
    patch: IncomeSchedulePatch,
  ): Promise<IncomeSchedule> {
    const supportedFields = ['amountMinor', 'startsOn', 'cadence', 'name'];
    const keys = Object.keys(patch);
    if (keys.length === 0 || keys.some((key) => !supportedFields.includes(key))) {
      throw new BadRequestException('Income schedule patch is empty or unsupported');
    }
    if (keys.every((key) => patch[key as keyof IncomeSchedulePatch] === undefined)) {
      throw new BadRequestException('Income schedule patch must change a field');
    }
    if (patch.amountMinor !== undefined) {
      validateAmount(patch.amountMinor);
    }
    if (patch.startsOn !== undefined) {
      validateLocalDate(patch.startsOn);
    }
    if (patch.cadence !== undefined) {
      validateCadence(patch.cadence);
    }
    const name = patch.name === undefined ? undefined : validateName(patch.name);
    const commandTime = this.clock();
    validateDate(commandTime, 'clock');

    return this.db.transaction().execute(async (trx) => {
      const profile = await this.requireProfileLock(userId, trx);
      const existing = await this.repository.lockActiveSchedule(userId, id, trx);
      if (!existing) {
        throw new NotFoundException('Income schedule not found');
      }
      await this.applySchedulesDue(
        userId,
        profile.timezone,
        [existing],
        commandTime,
        trx,
      );
      const row = await this.repository.updateSchedule(userId, id, {
        amountMinor: patch.amountMinor,
        startsOn: patch.startsOn,
        cadence: patch.cadence,
        name,
        updatedAt: commandTime,
      }, trx);
      return toIncomeSchedule(row);
    });
  }

  async archiveSchedule(userId: string, id: string): Promise<void> {
    const commandTime = this.clock();
    validateDate(commandTime, 'clock');
    await this.db.transaction().execute(async (trx) => {
      const profile = await this.requireProfileLock(userId, trx);
      const existing = await this.repository.lockActiveSchedule(userId, id, trx);
      if (!existing) {
        throw new NotFoundException('Income schedule not found');
      }
      await this.applySchedulesDue(
        userId,
        profile.timezone,
        [existing],
        commandTime,
        trx,
      );
      const archived = await this.repository.archiveSchedule(
        userId,
        id,
        commandTime,
        trx,
      );
      if (!archived) {
        throw new NotFoundException('Income schedule not found');
      }
    });
  }

  async materializeAndApplyDue(
    userId: string,
    through: Date,
    trx?: Transaction<Database>,
  ): Promise<void> {
    validateDate(through, 'through');
    if (trx) {
      await this.materializeInTransaction(userId, through, trx);
      return;
    }
    await this.db.transaction().execute((transaction) =>
      this.materializeInTransaction(userId, through, transaction));
  }

  private async materializeInTransaction(
    userId: string,
    through: Date,
    trx: Transaction<Database>,
  ): Promise<void> {
    const profile = await this.requireProfileLock(userId, trx);
    const schedules = await this.repository.lockActiveSchedules(userId, trx);
    await this.applySchedulesDue(userId, profile.timezone, schedules, through, trx);
  }

  private async applySchedulesDue(
    userId: string,
    timezone: string,
    schedules: readonly IncomeScheduleRow[],
    through: Date,
    trx: Transaction<Database>,
  ): Promise<void> {
    if (schedules.length === 0) {
      return;
    }
    const throughLocal = DateTime.fromJSDate(through, { zone: timezone });
    if (!throughLocal.isValid) {
      throw new BadRequestException('Financial profile has an invalid timezone');
    }
    const accounts = await this.accounts.findByKinds(
      userId,
      ['INCOME_SOURCE', 'FREE'],
      trx,
    );
    const sourceId = accounts.find(({ kind }) => kind === 'INCOME_SOURCE')?.id;
    const freeId = accounts.find(({ kind }) => kind === 'FREE')?.id;
    if (!sourceId || !freeId) {
      throw new NotFoundException('Financial profile not found');
    }

    const endsOnExclusive = throughLocal.plus({ days: 1 }).toISODate()!;
    for (const schedule of schedules) {
      const occurrenceDates = occurrencesWithin({
        startsOn: schedule.starts_on,
        cadence: schedule.cadence,
      }, {
        startsOn: schedule.starts_on,
        endsOnExclusive,
      });
      const amountMinor = parseMoney(schedule.amount_minor);
      for (const occurrenceOn of occurrenceDates) {
        const dueAt = localDateToInstant(occurrenceOn, timezone);
        if (dueAt.getTime() > through.getTime()) {
          continue;
        }
        if (wasUpdated(schedule) && dueAt.getTime() <= schedule.updated_at.getTime()) {
          continue;
        }
        if (await this.repository.hasAppliedLocalOccurrence(
          userId,
          schedule.id,
          occurrenceOn,
          trx,
        )) {
          continue;
        }

        const occurrence = await trx.insertInto('schedule_occurrences').values({
          id: randomUUID(),
          user_id: userId,
          schedule_type: 'INCOME',
          schedule_id: schedule.id,
          due_at: dueAt,
          status: 'PENDING',
          reservation_transaction_id: null,
          applied_transaction_id: null,
          cancelled_at: null,
        }).onConflict((conflict) => conflict
          .columns(['user_id', 'schedule_type', 'schedule_id', 'due_at'])
          .doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!occurrence) {
          continue;
        }

        const transaction = await this.ledger.post({
          userId,
          type: 'INCOME',
          effectiveAt: dueAt,
          sourceOccurrenceId: occurrence.id,
          metadata: {
            incomeScheduleId: schedule.id,
            occurrenceOn,
            name: schedule.name,
          },
          postings: [
            { accountId: sourceId, amountMinor: -amountMinor },
            { accountId: freeId, amountMinor },
          ],
        }, trx);
        await trx.updateTable('schedule_occurrences').set({
          status: 'APPLIED',
          applied_transaction_id: transaction.id,
        }).where('user_id', '=', userId)
          .where('id', '=', occurrence.id)
          .where('status', '=', 'PENDING')
          .executeTakeFirstOrThrow();
      }
    }
  }

  private async requireProfileLock(
    userId: string,
    trx: Transaction<Database>,
  ): Promise<{ timezone: string }> {
    const profile = await this.repository.findProfileForUpdate(userId, trx);
    if (!profile) {
      throw new NotFoundException('Financial profile not found');
    }
    return profile;
  }

  private async loadTransactions(
    userId: string,
    rows: readonly IncomeTransactionRow[],
  ): Promise<LedgerTransaction[]> {
    if (rows.length === 0) {
      return [];
    }
    const transactionIds = rows.map(({ id }) => id);
    const postingRows = await this.db.selectFrom('ledger_postings')
      .selectAll()
      .where('user_id', '=', userId)
      .where('transaction_id', 'in', transactionIds)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const postingsByTransaction = new Map<string, LedgerPosting[]>();
    for (const row of postingRows) {
      const postings = postingsByTransaction.get(row.transaction_id) ?? [];
      postings.push({
        id: row.id,
        transactionId: row.transaction_id,
        userId: row.user_id,
        accountId: row.account_id,
        amountMinor: parseMoney(row.amount_minor, true),
        createdAt: row.created_at,
      });
      postingsByTransaction.set(row.transaction_id, postings);
    }
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      type: row.type as LedgerTransactionType,
      effectiveAt: row.effective_at,
      reversalOf: row.reversal_of,
      sourceOccurrenceId: row.source_occurrence_id,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: row.created_at,
      postings: postingsByTransaction.get(row.id) ?? [],
    }));
  }
}

function toIncomeSchedule(row: IncomeScheduleRow): IncomeSchedule {
  return {
    id: row.id,
    userId: row.user_id,
    amountMinor: parseMoney(row.amount_minor),
    startsOn: row.starts_on,
    cadence: row.cadence,
    name: row.name,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function wasUpdated(row: IncomeScheduleRow): boolean {
  return row.updated_at.getTime() !== row.created_at.getTime();
}

function validateAmount(value: number): void {
  try {
    assertMoneyMinor(value);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'Invalid amountMinor');
  }
}

function validateName(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException('name must be a non-empty string');
  }
  return value.trim();
}

function validateLocalDate(value: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException('startsOn must be a valid ISO local date');
  }
  const date = DateTime.fromISO(value, { zone: 'UTC' }).startOf('day');
  if (!date.isValid || date.toISODate() !== value) {
    throw new BadRequestException('startsOn must be a valid ISO local date');
  }
}

function validateCadence(value: ScheduleCadence): void {
  if (!SCHEDULE_CADENCES.has(value)) {
    throw new BadRequestException('Invalid income schedule cadence');
  }
}

function validateDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new BadRequestException(`${field} must be a valid Date`);
  }
}

function parseMoney(value: string, signed = false): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!signed && parsed <= 0)) {
    throw new Error('Stored income amount exceeds the safe integer range');
  }
  return parsed;
}
