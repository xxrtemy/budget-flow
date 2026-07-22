import { IsISO8601, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { PositiveMoneyDto, STRICT_INSTANT_PATTERN } from './common.dto';

export class CreateIncomeDto extends PositiveMoneyDto {
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(STRICT_INSTANT_PATTERN)
  effectiveAt!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;
}
