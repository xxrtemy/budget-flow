import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import type { ScheduleCadence } from '../../../database/database.types';
import { SCHEDULE_CADENCES } from './common.dto';

export class CreateBudgetDto {
  @IsUUID('all') categoryId!: string;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amountMinor!: number;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true }) startsOn!: string;
  @IsIn(SCHEDULE_CADENCES) cadence!: ScheduleCadence;
}

export class UpdateBudgetDto {
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amountMinor?: number;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true }) startsOn?: string;
  @IsOptional() @IsIn(SCHEDULE_CADENCES) cadence?: ScheduleCadence;
}
