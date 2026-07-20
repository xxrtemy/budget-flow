import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import type { Kysely } from 'kysely';

import { DATABASE } from '../database/database.constants';
import { DatabaseModule } from '../database/database.module';
import type { Database } from '../database/database.types';
import { BalanceService } from './balance/balance.service';
import { BudgetService } from './budgets/budget.service';
import { CategoryService } from './expenses/category.service';
import { ExpenseService } from './expenses/expense.service';
import { FINANCE_CLOCK, type FinanceClock } from './finance.constants';
import { BudgetController } from './http/budget.controller';
import { ExpenseController } from './http/expense.controller';
import { IdempotencyInterceptor } from './http/idempotency.interceptor';
import { IdempotencyService } from './http/idempotency.service';
import { IncomeController } from './http/income.controller';
import { LedgerController } from './http/ledger.controller';
import { ObligationController } from './http/obligation.controller';
import { PeriodController } from './http/period.controller';
import { PeriodQueryService } from './http/period-query.service';
import { ProfileController } from './http/profile.controller';
import { SavingsController } from './http/savings.controller';
import { SettlementController } from './http/settlement.controller';
import { IncomeService } from './income/income.service';
import { LedgerService } from './ledger/ledger.service';
import { ObligationService } from './obligations/obligation.service';
import { ProfileRepository } from './profile/profile.repository';
import { ProfileService } from './profile/profile.service';
import { SavingsService } from './savings/savings.service';
import { PERIOD_CLOSER, ReconciliationService } from './settlement/reconciliation.service';
import { ReconciliationScheduler } from './settlement/reconciliation.scheduler';
import { SettlementService } from './settlement/settlement.service';
import { FinanceTransactionContext } from './transaction/finance-transaction-context';

@Module({
  imports: [DatabaseModule, ScheduleModule.forRoot()],
  controllers: [
    ProfileController, IncomeController, ExpenseController, ObligationController,
    BudgetController, SavingsController, SettlementController, LedgerController,
    PeriodController,
  ],
  providers: [
    { provide: FINANCE_CLOCK, useFactory: (): FinanceClock => () => new Date() },
    FinanceTransactionContext,
    LedgerService,
    CategoryService,
    ExpenseService,
    SavingsService,
    SettlementService,
    { provide: PERIOD_CLOSER, useExisting: SettlementService },
    {
      provide: BudgetService,
      inject: [DATABASE, FINANCE_CLOCK, FinanceTransactionContext],
      useFactory: (db: Kysely<Database>, clock: FinanceClock,
        transactions: FinanceTransactionContext) => new BudgetService(db, transactions, clock),
    },
    {
      provide: ProfileService,
      inject: [DATABASE, FINANCE_CLOCK],
      useFactory: (db: Kysely<Database>, clock: FinanceClock) =>
        new ProfileService(new ProfileRepository(db), clock),
    },
    {
      provide: IncomeService,
      inject: [DATABASE, FINANCE_CLOCK, FinanceTransactionContext],
      useFactory: (db: Kysely<Database>, clock: FinanceClock,
        transactions: FinanceTransactionContext) => new IncomeService(db, clock, transactions),
    },
    {
      provide: ObligationService,
      inject: [DATABASE, FINANCE_CLOCK, FinanceTransactionContext],
      useFactory: (db: Kysely<Database>, clock: FinanceClock,
        transactions: FinanceTransactionContext) => new ObligationService(db, clock, transactions),
    },
    ReconciliationService,
    BalanceService,
    PeriodQueryService,
    ReconciliationScheduler,
    IdempotencyService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [FINANCE_CLOCK, ReconciliationService],
})
export class FinanceModule {}
