import { IsString, MinLength } from 'class-validator';

export class CategoryDto {
  @IsString() @MinLength(1) name!: string;
}
