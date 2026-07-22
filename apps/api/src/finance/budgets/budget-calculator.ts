import type { ScheduleCadence } from '../../database/database.types';
import {
  occurrencesWithin,
  type LocalDateRange,
} from '../domain/recurrence';

export interface BudgetOccurrencePlan {
  amountMinor: number;
  startsOn: string;
  cadence: ScheduleCadence;
}

export interface BudgetOccurrenceCalculation {
  occurrenceDates: string[];
  totalMinor: number;
}

export function calculateBudgetOccurrences(
  plan: BudgetOccurrencePlan,
  period: LocalDateRange,
  notBefore?: string,
): BudgetOccurrenceCalculation {
  const occurrenceDates = occurrencesWithin(plan, period)
    .filter((date) => notBefore === undefined || date >= notBefore);
  const totalMinor = plan.amountMinor * occurrenceDates.length;
  if (!Number.isSafeInteger(totalMinor)) {
    throw new Error('Budget allocation total must be a safe integer');
  }

  return { occurrenceDates, totalMinor };
}
