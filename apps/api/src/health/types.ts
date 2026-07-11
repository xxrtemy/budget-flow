import { HttpStatus } from '@nestjs/common';

export interface HealthStatus {
  status: HttpStatus;
  service: string;
  timestamp: string;
}
