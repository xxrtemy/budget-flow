import { HttpStatus, Injectable } from '@nestjs/common';
import { HealthStatus } from './types';

@Injectable()
export class HealthService {
  getHealth(): HealthStatus {
    return {
      status: HttpStatus.OK,
      service: '@budget-flow/api',
      timestamp: new Date().toLocaleString(),
    };
  }
}
