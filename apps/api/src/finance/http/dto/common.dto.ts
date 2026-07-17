import { IsInt, IsISO8601, Max, Min } from 'class-validator';

export class PositiveMoneyDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amountMinor!: number;
}

export class EffectiveInstantDto {
  @IsISO8601({ strict: true, strictSeparator: true })
  effectiveAt!: string;
}

export const SCHEDULE_CADENCES = [
  'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL',
] as const;

export const CYCLE_CADENCES = SCHEDULE_CADENCES.slice(1);

export const STRICT_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
