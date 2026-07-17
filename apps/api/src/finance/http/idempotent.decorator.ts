import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_METADATA = 'finance:idempotent';
export const Idempotent = () => SetMetadata(IDEMPOTENT_METADATA, true);
