import type { CycleCadence } from '../../database/database.types';

export interface UpsertProfileInput {
  userId: string;
  timezone?: string;
  firstPeriodEndsOn: string;
  cadence: CycleCadence;
}

export interface FinancialProfile {
  userId: string;
  currency: 'RUB';
  timezone: string;
  cadence: CycleCadence;
  createdAt: Date;
}

export interface CalculationPeriod {
  id: string;
  userId: string;
  startsAt: Date;
  endsAtExclusive: Date;
  endsOnLocal: string;
  timezone: string;
  status: 'OPEN' | 'CLOSED';
  closedAt: Date | null;
  createdAt: Date;
}
