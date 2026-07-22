import { Type } from 'class-transformer';
import {
  IsDefined, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches,
  Max, Min, MinLength, ValidateBy, ValidateNested,
} from 'class-validator';
import { STRICT_INSTANT_PATTERN } from './common.dto';

export class CreateSavingsGoalDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) targetMinor?: number;
}

export class UpdateSavingsGoalDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) targetMinor?: number | null;
}

export class SavingsEndpointDto {
  @IsIn(['FREE', 'GENERAL', 'GOAL'])
  @ValidateBy({
    name: 'isExactSavingsEndpoint',
    validator: {
      validate: (_value, args) => {
        const endpoint = args!.object as SavingsEndpointDto;
        return endpoint.type === 'GOAL'
          ? typeof endpoint.goalId === 'string'
          : (endpoint.type === 'FREE' || endpoint.type === 'GENERAL')
            && endpoint.goalId === undefined;
      },
      defaultMessage: () =>
        'GOAL requires goalId; FREE and GENERAL must not contain goalId',
    },
  })
  type!: 'FREE' | 'GENERAL' | 'GOAL';
  @IsOptional() @IsUUID('all') goalId?: string;
}

export class SavingsTransferDto {
  @IsDefined() @ValidateNested() @Type(() => SavingsEndpointDto) from!: SavingsEndpointDto;
  @IsDefined() @ValidateNested() @Type(() => SavingsEndpointDto) to!: SavingsEndpointDto;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amountMinor!: number;
  @IsISO8601({ strict: true, strictSeparator: true }) @Matches(STRICT_INSTANT_PATTERN)
  effectiveAt!: string;
}
