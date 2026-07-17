import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import type { Kysely, Transaction } from 'kysely';

import { DATABASE } from '../../database/database.constants';
import type { Database, ScheduleCadence } from '../../database/database.types';
import { assertMoneyMinor } from '../domain/money';
import { localDateToInstant, occurrencesWithin } from '../domain/recurrence';
import { AccountRepository } from '../ledger/account.repository';
import { LedgerService } from '../ledger/ledger.service';
import { FinanceTransactionContext } from '../transaction/finance-transaction-context';
import { decodeListCursor, encodeListCursor } from '../shared/list-cursor';
import {
  ObligationRepository,
  type ObligationOccurrenceRow,
  type ObligationPeriodRow,
  type ObligationScheduleRow,
} from './obligation.repository';

const PAGE_SIZE = 50;
const CADENCES = new Set<ScheduleCadence>([
  'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL',
]);

export interface ObligationScheduleInput {
  userId: string;
  amountMinor: number;
  startsOn: string;
  cadence: ScheduleCadence;
  name: string;
}

export interface ObligationSchedulePatch {
  amountMinor?: number;
  startsOn?: string;
  cadence?: ScheduleCadence;
  name?: string;
}

export interface ObligationSchedule {
  id: string;
  userId: string;
  amountMinor: number;
  startsOn: string;
  cadence: ScheduleCadence;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ObligationOccurrence {
  id: string;
  userId: string;
  scheduleId: string;
  occurrenceOn: string;
  dueAt: Date;
  status: 'PENDING' | 'RESERVED' | 'APPLIED' | 'CANCELLED';
  reservationTransactionId: string | null;
  appliedTransactionId: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
}

export type ObligationClock = () => Date;

interface ReservationCandidate {
  occurrenceId: string;
  scheduleId: string;
  name: string;
  amountMinor: number;
  occurrenceOn: string;
  dueAt: Date;
}

interface CandidateWindow {
  lowerAt: Date;
  lowerInclusive: boolean;
  upperInclusive?: Date;
}

@Injectable()
export class ObligationService {
  private readonly repository: ObligationRepository;
  private readonly accounts: AccountRepository;
  private readonly ledger: LedgerService;
  private readonly transactions: FinanceTransactionContext;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    private readonly clock: ObligationClock = () => new Date(),
    @Optional() transactions?: FinanceTransactionContext,
  ) {
    this.repository = new ObligationRepository(db);
    this.accounts = new AccountRepository(db);
    this.ledger = new LedgerService(db);
    this.transactions = transactions ?? new FinanceTransactionContext();
  }

  async create(input: ObligationScheduleInput): Promise<ObligationSchedule> {
    validateAmount(input.amountMinor);
    validateLocalDate(input.startsOn);
    validateCadence(input.cadence);
    const name = validateName(input.name);

    return this.transactions.inTransaction(this.db, async (trx) => {
      await this.requireProfileLock(input.userId, trx);
      const commandTime = validClock(this.clock());
      const schedule = await this.repository.createSchedule({
        ...input,
        name,
        commandTime,
      }, trx);
      const periods = await this.repository.lockOpenPeriods(input.userId, trx);
      await this.repository.lockOccurrences(input.userId, [schedule.id], trx);
      const occurrenceOns = new Map([[schedule.id, new Set<string>()]]);
      const candidates = await this.createCandidates(
        input.userId,
        [schedule],
        periods,
        occurrenceOns,
        trx,
      );
      await this.reserveCandidates(input.userId, candidates, commandTime, trx);
      return toSchedule(schedule);
    });
  }

  async get(userId: string, id: string): Promise<ObligationSchedule> {
    const row = await this.repository.findSchedule(userId, id);
    if (!row) throw new NotFoundException('Obligation schedule not found');
    return toSchedule(row);
  }

  async list(userId: string, cursor?: string): Promise<{
    items: ObligationSchedule[];
    nextCursor: string | null;
  }> {
    const decoded = cursor ? decodeListCursor(cursor) : undefined;
    const rows = await this.repository.listSchedules(userId, decoded, PAGE_SIZE + 1);
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: page.map(toSchedule),
      nextCursor: rows.length > PAGE_SIZE && last
        ? encodeListCursor({ createdAtMicros: last.cursor_created_at_micros, id: last.id })
        : null,
    };
  }

  async updateFuture(
    userId: string,
    id: string,
    patch: ObligationSchedulePatch,
  ): Promise<ObligationSchedule> {
    const normalized = validatePatch(patch);
    return this.transactions.inTransaction(this.db, async (trx) => {
      await this.requireProfileLock(userId, trx);
      const existing = await this.repository.lockSchedule(userId, id, trx);
      if (!existing) throw new NotFoundException('Obligation schedule not found');
      const periods = await this.repository.lockOpenPeriods(userId, trx);
      await this.repository.lockOccurrences(userId, [id], trx);
      const existingOns = await this.repository.loadOccurrenceOns(userId, [id], trx);
      const dates = existingOns.get(id) ?? new Set<string>();
      existingOns.set(id, dates);
      const commandTime = validClock(this.clock());
      const boundary = new Date(Math.max(commandTime.getTime(), existing.updated_at.getTime() + 1));
      const oldCandidates = await this.createCandidates(
        userId,
        [existing],
        periods,
        existingOns,
        trx,
        {
          ...currentVersionWindow(existing),
          upperInclusive: boundary,
        },
      );
      const updated = await this.repository.updateSchedule(userId, id, {
        ...normalized,
        updatedAt: boundary,
      }, trx);
      const newCandidates = await this.createCandidates(
        userId,
        [updated],
        periods,
        existingOns,
        trx,
        { lowerAt: boundary, lowerInclusive: false },
      );
      await this.reserveCandidates(
        userId,
        [...oldCandidates, ...newCandidates],
        boundary,
        trx,
      );
      return toSchedule(updated);
    });
  }

  async listOccurrences(userId: string, id: string, cursor?: string): Promise<{
    items: ObligationOccurrence[];
    nextCursor: string | null;
  }> {
    if (!await this.repository.findSchedule(userId, id)) {
      throw new NotFoundException('Obligation schedule not found');
    }
    const decoded = cursor ? decodeListCursor(cursor) : undefined;
    const rows = await this.repository.listOccurrences(userId, id, decoded, PAGE_SIZE + 1);
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: page.map((row) => toOccurrence(row, row.occurrence_on)),
      nextCursor: rows.length > PAGE_SIZE && last
        ? encodeListCursor({ createdAtMicros: last.cursor_created_at_micros, id: last.id })
        : null,
    };
  }

  async cancelOccurrence(
    userId: string,
    occurrenceId: string,
    now: Date,
  ): Promise<ObligationOccurrence> {
    validateDate(now, 'now');
    return this.transactions.inTransaction(this.db, async (trx) => {
      await this.requireProfileLock(userId, trx);
      const identity = await trx.selectFrom('schedule_occurrences')
        .select('schedule_id').where('user_id', '=', userId)
        .where('schedule_type', '=', 'OBLIGATION').where('id', '=', occurrenceId)
        .executeTakeFirst();
      if (!identity) throw new NotFoundException('Obligation occurrence not found');
      if (!await this.repository.lockSchedule(userId, identity.schedule_id, trx)) {
        throw new NotFoundException('Obligation occurrence not found');
      }
      const occurrence = (await this.repository.lockOccurrences(
        userId, [identity.schedule_id], trx,
      )).find(({ id }) => id === occurrenceId);
      if (!occurrence) throw new NotFoundException('Obligation occurrence not found');
      if (occurrence.status !== 'RESERVED') {
        throw new ConflictException('Only a reserved obligation occurrence can be cancelled');
      }
      const details = await this.repository.reservationDetails(userId, [occurrence], trx);
      const detail = details.get(occurrence.id);
      if (!detail) throw new Error('Obligation reservation is missing');
      const { freeId, reserveId } = await this.lockAccountSet(userId, trx);
      await this.ledger.post({
        userId,
        type: 'OBLIGATION_RELEASE',
        effectiveAt: now,
        sourceOccurrenceId: occurrence.id,
        metadata: {
          obligationScheduleId: occurrence.schedule_id,
          occurrenceOn: detail.occurrenceOn,
        },
        postings: [
          { accountId: reserveId, amountMinor: -detail.amountMinor },
          { accountId: freeId, amountMinor: detail.amountMinor },
        ],
      }, trx);
      const row = await trx.updateTable('schedule_occurrences').set({
        status: 'CANCELLED',
        cancelled_at: now,
      }).where('user_id', '=', userId).where('id', '=', occurrence.id)
        .where('status', '=', 'RESERVED').returningAll().executeTakeFirstOrThrow();
      return toOccurrence(row, detail.occurrenceOn);
    });
  }

  async reservePeriod(
    userId: string,
    periodId: string,
    now: Date,
    trx?: Transaction<Database>,
  ): Promise<void> {
    validateDate(now, 'now');
    await this.inTransaction(trx, async (transaction) => {
      await this.requireProfileLock(userId, transaction);
      const period = await this.repository.lockPeriod(userId, periodId, transaction);
      if (!period) throw new NotFoundException('Calculation period not found');
      const schedules = await this.repository.lockSchedules(userId, transaction);
      await this.repository.lockOccurrences(userId, schedules.map(({ id }) => id), transaction);
      const existing = await this.repository.loadOccurrenceOns(
        userId, schedules.map(({ id }) => id), transaction,
      );
      const candidates = await this.createCandidates(
        userId, schedules, [period], existing, transaction,
      );
      await this.reserveCandidates(userId, candidates, now, transaction);
    });
  }

  async reserveOpenPeriods(
    userId: string,
    now: Date,
    trx?: Transaction<Database>,
  ): Promise<void> {
    validateDate(now, 'now');
    await this.inTransaction(trx, async (transaction) => {
      await this.requireProfileLock(userId, transaction);
      const periods = await this.repository.lockOpenPeriods(userId, transaction);
      const schedules = await this.repository.lockSchedules(userId, transaction);
      await this.repository.lockOccurrences(userId, schedules.map(({ id }) => id), transaction);
      const existing = await this.repository.loadOccurrenceOns(
        userId, schedules.map(({ id }) => id), transaction,
      );
      const candidates = await this.createCandidates(
        userId, schedules, periods, existing, transaction,
      );
      await this.reserveCandidates(userId, candidates, now, transaction);
    });
  }

  async applyDue(
    userId: string,
    through: Date,
    trx?: Transaction<Database>,
  ): Promise<void> {
    validateDate(through, 'through');
    await this.inTransaction(trx, async (transaction) => {
      await this.requireProfileLock(userId, transaction);
      const schedules = await this.repository.lockSchedules(userId, transaction);
      const occurrences = (await this.repository.lockOccurrences(
        userId, schedules.map(({ id }) => id), transaction,
      )).filter(({ status, due_at }) => status === 'RESERVED' && due_at <= through);
      if (occurrences.length === 0) return;
      const details = await this.repository.reservationDetails(userId, occurrences, transaction);
      const { reserveId, sinkId } = await this.lockAccountSet(userId, transaction);
      for (const occurrence of occurrences) {
        const detail = details.get(occurrence.id);
        if (!detail) throw new Error('Obligation reservation is missing');
        const payment = await this.ledger.post({
          userId,
          type: 'OBLIGATION_PAYMENT',
          effectiveAt: occurrence.due_at,
          sourceOccurrenceId: occurrence.id,
          metadata: {
            obligationScheduleId: occurrence.schedule_id,
            occurrenceOn: detail.occurrenceOn,
          },
          postings: [
            { accountId: reserveId, amountMinor: -detail.amountMinor },
            { accountId: sinkId, amountMinor: detail.amountMinor },
          ],
        }, transaction);
        await transaction.updateTable('schedule_occurrences').set({
          status: 'APPLIED',
          applied_transaction_id: payment.id,
        }).where('user_id', '=', userId).where('id', '=', occurrence.id)
          .where('status', '=', 'RESERVED').executeTakeFirstOrThrow();
      }
    });
  }

  private async createCandidates(
    userId: string,
    schedules: readonly ObligationScheduleRow[],
    periods: readonly ObligationPeriodRow[],
    existingOns: Map<string, Set<string>>,
    trx: Transaction<Database>,
    explicitWindow?: CandidateWindow,
  ): Promise<ReservationCandidate[]> {
    const candidates: ReservationCandidate[] = [];
    for (const schedule of schedules) {
      const window = explicitWindow ?? currentVersionWindow(schedule);
      const known = existingOns.get(schedule.id) ?? new Set<string>();
      existingOns.set(schedule.id, known);
      for (const period of periods) {
        const range = periodRange(period);
        for (const occurrenceOn of occurrencesWithin({
          startsOn: schedule.starts_on,
          cadence: schedule.cadence,
        }, range)) {
          if (known.has(occurrenceOn)) continue;
          const dueAt = localDateToInstant(occurrenceOn, period.timezone);
          if (dueAt < period.starts_at || dueAt >= period.ends_at_exclusive) continue;
          if (dueAt < window.lowerAt || (!window.lowerInclusive && dueAt <= window.lowerAt)) {
            continue;
          }
          if (window.upperInclusive && dueAt > window.upperInclusive) continue;
          const occurrenceId = randomUUID();
          const inserted = await trx.insertInto('schedule_occurrences').values({
            id: occurrenceId,
            user_id: userId,
            schedule_type: 'OBLIGATION',
            schedule_id: schedule.id,
            due_at: dueAt,
            status: 'PENDING',
            reservation_transaction_id: null,
            applied_transaction_id: null,
            cancelled_at: null,
          }).onConflict((conflict) => conflict
            .columns(['user_id', 'schedule_type', 'schedule_id', 'due_at']).doNothing())
            .returning('id').executeTakeFirst();
          if (!inserted) continue;
          known.add(occurrenceOn);
          candidates.push({
            occurrenceId,
            scheduleId: schedule.id,
            name: schedule.name,
            amountMinor: parseMoney(schedule.amount_minor),
            occurrenceOn,
            dueAt,
          });
        }
      }
    }
    return candidates;
  }

  private async reserveCandidates(
    userId: string,
    candidates: readonly ReservationCandidate[],
    effectiveAt: Date,
    trx: Transaction<Database>,
  ): Promise<void> {
    if (candidates.length === 0) return;
    const { freeId, reserveId } = await this.lockAccountSet(userId, trx);
    for (const candidate of candidates) {
      const reservation = await this.ledger.post({
        userId,
        type: 'OBLIGATION_RESERVATION',
        effectiveAt,
        sourceOccurrenceId: candidate.occurrenceId,
        metadata: {
          obligationScheduleId: candidate.scheduleId,
          occurrenceOn: candidate.occurrenceOn,
          dueAt: candidate.dueAt.toISOString(),
          name: candidate.name,
        },
        postings: [
          { accountId: freeId, amountMinor: -candidate.amountMinor },
          { accountId: reserveId, amountMinor: candidate.amountMinor },
        ],
      }, trx);
      await trx.updateTable('schedule_occurrences').set({
        status: 'RESERVED',
        reservation_transaction_id: reservation.id,
      }).where('user_id', '=', userId).where('id', '=', candidate.occurrenceId)
        .where('status', '=', 'PENDING').executeTakeFirstOrThrow();
    }
  }

  private async lockAccountSet(
    userId: string,
    trx: Transaction<Database>,
  ): Promise<{ freeId: string; reserveId: string; sinkId: string }> {
    const identities = await this.accounts.findByKinds(
      userId,
      ['FREE', 'OBLIGATION_RESERVE', 'EXPENSE_SINK'],
      trx,
    );
    const freeId = identities.find(({ kind }) => kind === 'FREE')?.id;
    const reserveId = identities.find(({ kind }) => kind === 'OBLIGATION_RESERVE')?.id;
    const sinkId = identities.find(({ kind }) => kind === 'EXPENSE_SINK')?.id;
    if (!freeId || !reserveId || !sinkId) {
      throw new NotFoundException('Financial profile not found');
    }
    await this.accounts.lockPostingAccounts(userId, identities.map(({ id }) => id), trx);
    return { freeId, reserveId, sinkId };
  }

  private async requireProfileLock(userId: string, trx: Transaction<Database>): Promise<void> {
    if (!await this.repository.findProfileForUpdate(userId, trx)) {
      throw new NotFoundException('Financial profile not found');
    }
  }

  private async inTransaction(
    trx: Transaction<Database> | undefined,
    work: (trx: Transaction<Database>) => Promise<void>,
  ): Promise<void> {
    if (trx) return work(trx);
    await this.transactions.inTransaction(this.db, work);
  }
}

function toSchedule(row: ObligationScheduleRow): ObligationSchedule {
  return {
    id: row.id,
    userId: row.user_id,
    amountMinor: parseMoney(row.amount_minor),
    startsOn: row.starts_on,
    cadence: row.cadence,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOccurrence(row: ObligationOccurrenceRow, occurrenceOn: string): ObligationOccurrence {
  return {
    id: row.id,
    userId: row.user_id,
    scheduleId: row.schedule_id,
    occurrenceOn,
    dueAt: row.due_at,
    status: row.status,
    reservationTransactionId: row.reservation_transaction_id,
    appliedTransactionId: row.applied_transaction_id,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
  };
}

function validatePatch(patch: ObligationSchedulePatch): ObligationSchedulePatch {
  const supported = ['amountMinor', 'startsOn', 'cadence', 'name'];
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.some((key) => !supported.includes(key))
    || keys.every((key) => patch[key as keyof ObligationSchedulePatch] === undefined)) {
    throw new BadRequestException('Obligation schedule patch is empty or unsupported');
  }
  if (patch.amountMinor !== undefined) validateAmount(patch.amountMinor);
  if (patch.startsOn !== undefined) validateLocalDate(patch.startsOn);
  if (patch.cadence !== undefined) validateCadence(patch.cadence);
  return { ...patch, ...(patch.name === undefined ? {} : { name: validateName(patch.name) }) };
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
  if (!CADENCES.has(value)) throw new BadRequestException('Invalid obligation cadence');
}

function validClock(value: Date): Date {
  validateDate(value, 'clock');
  return value;
}

function validateDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new BadRequestException(`${field} must be a valid Date`);
  }
}

function parseMoney(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('Stored obligation amount exceeds the safe integer range');
  }
  return parsed;
}

function currentVersionWindow(schedule: ObligationScheduleRow): CandidateWindow {
  const initialVersion = schedule.updated_at.getTime() === schedule.created_at.getTime();
  return {
    lowerAt: initialVersion ? schedule.created_at : schedule.updated_at,
    lowerInclusive: initialVersion,
  };
}

function periodRange(period: ObligationPeriodRow): { startsOn: string; endsOnExclusive: string } {
  const startsOn = DateTime.fromJSDate(period.starts_at, { zone: period.timezone }).toISODate();
  const endsOnExclusive = DateTime.fromJSDate(period.ends_at_exclusive, { zone: period.timezone }).toISODate();
  if (!startsOn || !endsOnExclusive) throw new Error('Calculation period has an invalid timezone');
  return { startsOn, endsOnExclusive };
}
