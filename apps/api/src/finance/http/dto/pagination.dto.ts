import { IsOptional, IsString, MinLength } from 'class-validator';

export class PaginationDto {
  @IsOptional() @IsString() @MinLength(1) cursor?: string;
}

export class EmptyDto {}
