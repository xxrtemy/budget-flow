import { IsISO8601, IsOptional, IsString, IsUUID, Matches, MinLength } from 'class-validator';
import { PositiveMoneyDto, STRICT_INSTANT_PATTERN } from './common.dto';

export class CreateExpenseDto extends PositiveMoneyDto {
  @IsUUID('all') categoryId!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) @Matches(STRICT_INSTANT_PATTERN)
  occurredAt!: string;
  @IsOptional() @IsString() @MinLength(1) description?: string;
}
