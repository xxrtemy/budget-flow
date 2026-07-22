import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';
import { HealthStatus } from './types';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getStatus(): HealthStatus {
    return this.healthService.getHealth();
  }
}
