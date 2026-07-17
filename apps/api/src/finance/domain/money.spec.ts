import { describe, expect, test } from 'vitest';

import { assertMoneyMinor } from './money';

describe('assertMoneyMinor', () => {
  test.each([0, -1, 10.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid amount %s',
    (value) => {
      expect(() => assertMoneyMinor(value)).toThrow(
        'amountMinor must be a positive safe integer',
      );
    },
  );

  test('returns a positive safe integer', () => {
    expect(assertMoneyMinor(12_345)).toBe(12_345);
  });
});
