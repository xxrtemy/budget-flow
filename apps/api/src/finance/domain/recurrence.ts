import { DateTime } from 'luxon';

import type { CycleCadence, ScheduleCadence } from '../../database/database.types';

export interface RecurrenceRule {
  startsOn: string;
  cadence: ScheduleCadence;
}

export interface LocalDateRange {
  startsOn: string;
  endsOnExclusive: string;
}

const MONTHS_BY_CADENCE: Partial<Record<ScheduleCadence, number>> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMIANNUAL: 6,
  ANNUAL: 12,
};

export function occurrencesWithin(
  rule: RecurrenceRule,
  range: LocalDateRange,
): string[] {
  const startsOn = localDate(rule.startsOn, 'UTC');
  const rangeStart = localDate(range.startsOn, 'UTC');
  const rangeEnd = localDate(range.endsOnExclusive, 'UTC');
  const occurrences: string[] = [];

  for (let index = 0; ; index += 1) {
    const occurrence = occurrenceAt(startsOn, rule.cadence, index);
    if (occurrence >= rangeEnd) {
      return occurrences;
    }
    if (occurrence >= rangeStart) {
      occurrences.push(occurrence.toISODate()!);
    }
  }
}

export function nextPeriodEnd(
  previousEndOn: string,
  cadence: CycleCadence,
  anchorDay: number,
): string {
  const previous = localDate(previousEndOn, 'UTC');

  if (cadence === 'WEEKLY') {
    return previous.plus({ weeks: 1 }).toISODate()!;
  }

  const months = MONTHS_BY_CADENCE[cadence]!;
  const targetMonth = previous.startOf('month').plus({ months });
  return targetMonth
    .set({ day: Math.min(anchorDay, targetMonth.daysInMonth) })
    .toISODate()!;
}

export function localDateToInstant(localDateValue: string, zone: string): Date {
  return localDate(localDateValue, zone).toJSDate();
}

function occurrenceAt(
  startsOn: DateTime<true>,
  cadence: ScheduleCadence,
  index: number,
): DateTime<true> {
  if (cadence === 'DAILY') {
    return startsOn.plus({ days: index });
  }
  if (cadence === 'WEEKLY') {
    return startsOn.plus({ weeks: index });
  }

  const targetMonth = startsOn.startOf('month').plus({
    months: MONTHS_BY_CADENCE[cadence]! * index,
  });
  return targetMonth.set({ day: Math.min(startsOn.day, targetMonth.daysInMonth) });
}

function localDate(value: string, zone: string): DateTime<true> {
  const date = DateTime.fromISO(value, { zone }).startOf('day');
  if (!date.isValid) {
    throw new Error(`Invalid local date or timezone: ${value} (${zone})`);
  }
  return date;
}
