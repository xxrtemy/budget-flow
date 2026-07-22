import { IsISO8601, Matches } from 'class-validator';
import { PositiveMoneyDto, STRICT_INSTANT_PATTERN } from './common.dto';

export class OpeningBalanceDto extends PositiveMoneyDto {
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(STRICT_INSTANT_PATTERN)
  effectiveAt!: string;
}
