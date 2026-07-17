import { describe, expect, test } from 'vitest';

import { localDateToInstant, nextPeriodEnd, occurrencesWithin } from './recurrence';

describe('nextPeriodEnd', () => {
  test.each([
    ['2028-02-29', 'ANNUAL', 29, '2029-02-28'],
    ['2029-02-28', 'ANNUAL', 29, '2030-02-28'],
    ['2026-01-31', 'MONTHLY', 31, '2026-02-28'],
    ['2026-02-28', 'MONTHLY', 31, '2026-03-31'],
    ['2026-01-31', 'QUARTERLY', 31, '2026-04-30'],
  ] as const)(
    'advances %s at %s cadence with anchor %i to %s',
    (previousEndOn, cadence, anchorDay, expected) => {
      expect(nextPeriodEnd(previousEndOn, cadence, anchorDay)).toBe(expected);
    },
  );
});

describe('occurrencesWithin', () => {
  test('includes weekly occurrences before the exclusive range end', () => {
    expect(occurrencesWithin(
      { startsOn: '2026-07-01', cadence: 'WEEKLY' },
      { startsOn: '2026-07-01', endsOnExclusive: '2026-07-22' },
    )).toEqual(['2026-07-01', '2026-07-08', '2026-07-15']);
  });

  test.each([
    ['DAILY', ['2026-07-02', '2026-07-03', '2026-07-04']],
    ['MONTHLY', ['2026-07-31', '2026-08-31', '2026-09-30']],
    ['SEMIANNUAL', ['2026-01-31', '2026-07-31', '2027-01-31']],
  ] as const)('supports %s cadence', (cadence, expected) => {
    const startsOn = cadence === 'DAILY' ? '2026-07-01' :
      cadence === 'MONTHLY' ? '2026-01-31' : '2025-07-31';
    const range = cadence === 'DAILY'
      ? { startsOn: '2026-07-02', endsOnExclusive: '2026-07-05' }
      : cadence === 'MONTHLY'
        ? { startsOn: '2026-07-01', endsOnExclusive: '2026-10-01' }
        : { startsOn: '2026-01-01', endsOnExclusive: '2027-02-01' };

    expect(occurrencesWithin({ startsOn, cadence }, range)).toEqual(expected);
  });

  test('models an inclusive API end date with the next local date as exclusive', () => {
    expect(occurrencesWithin(
      { startsOn: '2026-07-01', cadence: 'DAILY' },
      { startsOn: '2026-07-01', endsOnExclusive: '2026-07-04' },
    )).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
  });
});

describe('localDateToInstant', () => {
  test.each([
    ['2026-07-26', 'Europe/Moscow', '2026-07-25T21:00:00.000Z'],
    ['2026-03-08', 'America/New_York', '2026-03-08T05:00:00.000Z'],
    ['2026-11-01', 'America/New_York', '2026-11-01T04:00:00.000Z'],
  ])('converts %s midnight in %s through DST rules', (localDate, zone, expected) => {
    expect(localDateToInstant(localDate, zone).toISOString()).toBe(expected);
  });
});
