import { randomUUID } from 'node:crypto';

import type { Kysely, Selectable } from 'kysely';

import type {
  AccountKind,
  CalculationPeriodsTable,
  CycleCadence,
  Database,
  FinancialProfilesTable,
} from '../../database/database.types';

export type ProfileRow = Selectable<FinancialProfilesTable>;
export type PeriodRow = Selectable<CalculationPeriodsTable>;

const SYSTEM_ACCOUNT_KINDS = [
  'FREE',
  'OBLIGATION_RESERVE',
  'SAVINGS_GENERAL',
  'OPENING_EQUITY',
  'INCOME_SOURCE',
  'EXPENSE_SINK',
] as const satisfies readonly AccountKind[];

interface CreateProfileData {
  userId: string;
  timezone: string;
  cadence: CycleCadence;
  firstPeriodEndsOn: string;
  nextPeriodEndsOn: string;
  anchorDay: number;
  startsAt: Date;
  endsAtExclusive: Date;
}

interface UpdateProfileData {
  userId: string;
  timezone: string;
  cadence: CycleCadence;
  nextPeriodEndsOn: string;
  anchorDay: number;
  updatedAt: Date;
}

export class ProfileRepository {
  constructor(private readonly db: Kysely<Database>) {}

  findProfile(userId: string): Promise<ProfileRow | undefined> {
    return this.db
      .selectFrom('financial_profiles')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
  }

  findCurrentPeriod(userId: string): Promise<PeriodRow | undefined> {
    return this.db
      .selectFrom('calculation_periods')
      .selectAll()
      .where('user_id', '=', userId)
      .where('status', '=', 'OPEN')
      .orderBy('starts_at', 'desc')
      .executeTakeFirst();
  }

  createProfile(data: CreateProfileData): Promise<ProfileRow> {
    return this.db.transaction().execute(async (transaction) => {
      const profile = await transaction
        .insertInto('financial_profiles')
        .values({
          user_id: data.userId,
          currency: 'RUB',
          timezone: data.timezone,
          cadence: data.cadence,
          next_period_ends_on: data.nextPeriodEndsOn,
          cycle_anchor_day: data.anchorDay,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await transaction
        .insertInto('financial_accounts')
        .values(SYSTEM_ACCOUNT_KINDS.map((kind) => ({
          id: randomUUID(),
          user_id: data.userId,
          kind,
          reference_id: null,
          name: null,
          target_amount_minor: null,
          archived_at: null,
        })))
        .execute();

      await transaction
        .insertInto('calculation_periods')
        .values({
          id: randomUUID(),
          user_id: data.userId,
          starts_at: data.startsAt,
          ends_at_exclusive: data.endsAtExclusive,
          ends_on_local: data.firstPeriodEndsOn,
          timezone: data.timezone,
          status: 'OPEN',
          closed_at: null,
        })
        .execute();

      return profile;
    });
  }

  updateProfile(data: UpdateProfileData): Promise<ProfileRow> {
    return this.db
      .updateTable('financial_profiles')
      .set({
        timezone: data.timezone,
        cadence: data.cadence,
        next_period_ends_on: data.nextPeriodEndsOn,
        cycle_anchor_day: data.anchorDay,
        updated_at: data.updatedAt,
      })
      .where('user_id', '=', data.userId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
