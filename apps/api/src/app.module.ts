import { Module } from '@nestjs/common';

import { HealthModule } from './health/health.module';
import { FinanceModule } from './finance/finance.module';

@Module({
  imports: [HealthModule, FinanceModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
