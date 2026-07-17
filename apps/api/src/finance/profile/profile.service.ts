import { DateTime } from 'luxon';

import { localDateToInstant, nextPeriodEnd } from '../domain/recurrence';
import { ProfileRepository, type PeriodRow, type ProfileRow } from './profile.repository';
import type { CalculationPeriod, FinancialProfile, UpsertProfileInput } from './profile.types';

export type Clock = () => Date;

export class ProfileService {
  constructor(
    private readonly repository: ProfileRepository,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async upsert(input: UpsertProfileInput): Promise<FinancialProfile> {
    const now = this.clock();
    const timezone = input.timezone ?? 'Europe/Moscow';
    const anchorDay = parseAnchorDay(input.firstPeriodEndsOn);
    const existing = await this.repository.findProfile(input.userId);

    const row = existing
      ? await this.repository.updateProfile({
          userId: input.userId,
          timezone,
          cadence: input.cadence,
          nextPeriodEndsOn: input.firstPeriodEndsOn,
          anchorDay,
          updatedAt: now,
        })
      : await this.repository.createProfile({
          userId: input.userId,
          timezone,
          cadence: input.cadence,
          firstPeriodEndsOn: input.firstPeriodEndsOn,
          nextPeriodEndsOn: nextPeriodEnd(
            input.firstPeriodEndsOn,
            input.cadence,
            anchorDay,
          ),
          anchorDay,
          startsAt: now,
          endsAtExclusive: localDateToInstant(
            nextLocalDate(input.firstPeriodEndsOn),
            timezone,
          ),
        });

    return toFinancialProfile(row);
  }

  async get(userId: string): Promise<FinancialProfile | undefined> {
    const row = await this.repository.findProfile(userId);
    return row && toFinancialProfile(row);
  }

  async getCurrentPeriod(userId: string): Promise<CalculationPeriod | undefined> {
    const row = await this.repository.findCurrentPeriod(userId);
    return row && toCalculationPeriod(row);
  }
}

function parseAnchorDay(value: string): number {
  const date = DateTime.fromISO(value, { zone: 'UTC' }).startOf('day');
  if (!date.isValid || date.toISODate() !== value) {
    throw new Error(`Invalid local date: ${value}`);
  }
  return date.day;
}

function nextLocalDate(value: string): string {
  return DateTime.fromISO(value, { zone: 'UTC' }).plus({ days: 1 }).toISODate()!;
}

function toFinancialProfile(row: ProfileRow): FinancialProfile {
  return {
    userId: row.user_id,
    currency: row.currency,
    timezone: row.timezone,
    cadence: row.cadence,
    createdAt: row.created_at,
  };
}

function toCalculationPeriod(row: PeriodRow): CalculationPeriod {
  return {
    id: row.id,
    userId: row.user_id,
    startsAt: row.starts_at,
    endsAtExclusive: row.ends_at_exclusive,
    endsOnLocal: row.ends_on_local,
    timezone: row.timezone,
    status: row.status,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}
