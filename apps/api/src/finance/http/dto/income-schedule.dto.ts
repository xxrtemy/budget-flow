import { IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from 'class-validator';
import type { ScheduleCadence } from '../../../database/database.types';
import { SCHEDULE_CADENCES } from './common.dto';

export class CreateIncomeScheduleDto {
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  amountMinor!: number;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true }) startsOn!: string;
  @IsIn(SCHEDULE_CADENCES) cadence!: ScheduleCadence;
  @IsString() @MinLength(1) name!: string;
}

export class UpdateIncomeScheduleDto {
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  amountMinor?: number;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true }) startsOn?: string;
  @IsOptional() @IsIn(SCHEDULE_CADENCES) cadence?: ScheduleCadence;
  @IsOptional() @IsString() @MinLength(1) name?: string;
}
