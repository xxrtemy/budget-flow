import { describe, expect, test } from 'vitest';

import { calculateBudgetOccurrences } from './budget-calculator';

describe('calculateBudgetOccurrences', () => {
  test('totals every weekly occurrence within the period', () => {
    expect(calculateBudgetOccurrences(
      { amountMinor: 3_000, startsOn: '2026-07-01', cadence: 'WEEKLY' },
      { startsOn: '2026-07-01', endsOnExclusive: '2026-07-29' },
    )).toEqual({
      occurrenceDates: ['2026-07-01', '2026-07-08', '2026-07-15', '2026-07-22'],
      totalMinor: 12_000,
    });
  });

  test('includes only intervals that have not started yet', () => {
    expect(calculateBudgetOccurrences(
      { amountMinor: 3_000, startsOn: '2026-07-01', cadence: 'WEEKLY' },
      { startsOn: '2026-07-01', endsOnExclusive: '2026-07-29' },
      '2026-07-15',
    )).toEqual({
      occurrenceDates: ['2026-07-15', '2026-07-22'],
      totalMinor: 6_000,
    });
  });

  test('finds quarterly occurrences throughout an annual period', () => {
    expect(calculateBudgetOccurrences(
      { amountMinor: 2_500, startsOn: '2026-01-31', cadence: 'QUARTERLY' },
      { startsOn: '2026-01-01', endsOnExclusive: '2027-01-01' },
    )).toEqual({
      occurrenceDates: ['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31'],
      totalMinor: 10_000,
    });
  });

  test('rejects totals outside the safe integer range', () => {
    expect(() => calculateBudgetOccurrences(
      {
        amountMinor: Number.MAX_SAFE_INTEGER,
        startsOn: '2026-07-01',
        cadence: 'DAILY',
      },
      { startsOn: '2026-07-01', endsOnExclusive: '2026-07-03' },
    )).toThrow(/safe integer/i);
  });
});
