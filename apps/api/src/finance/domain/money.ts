export function assertMoneyMinor(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('amountMinor must be a positive safe integer');
  }

  return value;
}
