import { IsDateString, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import type { CycleCadence } from '../../../database/database.types';
import { CYCLE_CADENCES } from './common.dto';
import { IsIanaTimezone } from '../is-iana-timezone.decorator';

export class UpsertProfileDto {
  @IsIn(CYCLE_CADENCES)
  cadence!: CycleCadence;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  @IsString()
  firstPeriodEndsOn!: string;

  @IsOptional()
  @IsIanaTimezone()
  timezone?: string;
}
