import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { isUUID } from 'class-validator';

@Injectable()
export class CurrentUserPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    return validateUserIdHeader(value);
  }
}

export function validateUserIdHeader(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || !isUUID(value, 'all')) {
    throw new BadRequestException('X-User-Id must be one valid UUID');
  }
  return value;
}
