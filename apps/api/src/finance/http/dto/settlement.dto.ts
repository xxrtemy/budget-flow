import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class AcceptSettlementDto {
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  amountMinor?: number;
}
