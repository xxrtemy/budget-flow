import type { ColumnType, Generated } from 'kysely';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type CycleCadence = 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';
export type ScheduleCadence = 'DAILY' | CycleCadence;
export type AccountKind =
  | 'FREE'
  | 'OBLIGATION_RESERVE'
  | 'BUDGET_RESERVE'
  | 'SAVINGS_GENERAL'
  | 'SAVINGS_GOAL'
  | 'OPENING_EQUITY'
  | 'INCOME_SOURCE'
  | 'EXPENSE_SINK';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type CreatedAt = Generated<ColumnType<Date, Date | string | undefined, never>>;
type UpdatedAt = Generated<ColumnType<Date, Date | string | undefined, Date | string>>;
type DateOnly = ColumnType<string, string, string>;
type Money = ColumnType<string, bigint | number | string, never>;
type NullableMoney = ColumnType<string | null, bigint | number | string | null, never>;

export interface FinancialProfilesTable {
  user_id: string;
  currency: string;
  timezone: string;
  cadence: CycleCadence;
  next_period_ends_on: DateOnly;
  cycle_anchor_day: number;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface FinancialAccountsTable {
  id: string;
  user_id: string;
  kind: AccountKind;
  reference_id: string | null;
  name: string | null;
  target_amount_minor: NullableMoney;
  archived_at: Timestamp | null;
  created_at: CreatedAt;
}

export interface LedgerTransactionsTable {
  id: string;
  user_id: string;
  type: string;
  effective_at: Timestamp;
  reversal_of: string | null;
  source_occurrence_id: string | null;
  metadata: ColumnType<JsonValue, JsonValue | undefined, never>;
  created_at: CreatedAt;
}

export interface LedgerPostingsTable {
  id: string;
  transaction_id: string;
  user_id: string;
  account_id: string;
  amount_minor: Money;
  created_at: CreatedAt;
}

export interface CalculationPeriodsTable {
  id: string;
  user_id: string;
  starts_at: Timestamp;
  ends_at_exclusive: Timestamp;
  ends_on_local: DateOnly;
  timezone: string;
  status: 'OPEN' | 'CLOSED';
  closed_at: Timestamp | null;
  created_at: CreatedAt;
}

export interface CategoriesTable {
  id: string;
  user_id: string;
  name: string;
  archived_at: Timestamp | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface IncomeSchedulesTable {
  id: string;
  user_id: string;
  name: string;
  amount_minor: Money;
  starts_on: DateOnly;
  cadence: ScheduleCadence;
  archived_at: Timestamp | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ObligationSchedulesTable {
  id: string;
  user_id: string;
  name: string;
  amount_minor: Money;
  starts_on: DateOnly;
  cadence: ScheduleCadence;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ScheduleOccurrencesTable {
  id: string;
  user_id: string;
  schedule_type: 'INCOME' | 'OBLIGATION';
  schedule_id: string;
  due_at: Timestamp;
  status: 'PENDING' | 'RESERVED' | 'APPLIED' | 'CANCELLED';
  reservation_transaction_id: string | null;
  applied_transaction_id: string | null;
  cancelled_at: Timestamp | null;
  created_at: CreatedAt;
}

export interface BudgetPlansTable {
  id: string;
  user_id: string;
  category_id: string;
  amount_minor: Money;
  starts_on: DateOnly;
  cadence: ScheduleCadence;
  archived_at: Timestamp | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface BudgetAllocationsTable {
  id: string;
  user_id: string;
  budget_plan_id: string;
  period_id: string;
  occurrence_on: DateOnly;
  amount_minor: Money;
  reservation_transaction_id: string;
  released_transaction_id: string | null;
  created_at: CreatedAt;
}

export interface SettlementOffersTable {
  id: string;
  user_id: string;
  period_id: string;
  offered_amount_minor: Money;
  accepted_amount_minor: NullableMoney;
  status: 'PENDING' | 'ACCEPTED';
  accepted_at: Timestamp | null;
  transfer_transaction_id: string | null;
  created_at: CreatedAt;
}

export interface IdempotencyRecordsTable {
  id: string;
  user_id: string;
  idempotency_key: string;
  route: string;
  payload_hash: string;
  state: 'PROCESSING' | 'COMPLETED';
  response_status: number | null;
  response_body: ColumnType<JsonValue | null, JsonValue | null | undefined, JsonValue | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface Database {
  financial_profiles: FinancialProfilesTable;
  financial_accounts: FinancialAccountsTable;
  ledger_transactions: LedgerTransactionsTable;
  ledger_postings: LedgerPostingsTable;
  calculation_periods: CalculationPeriodsTable;
  categories: CategoriesTable;
  income_schedules: IncomeSchedulesTable;
  obligation_schedules: ObligationSchedulesTable;
  schedule_occurrences: ScheduleOccurrencesTable;
  budget_plans: BudgetPlansTable;
  budget_allocations: BudgetAllocationsTable;
  settlement_offers: SettlementOffersTable;
  idempotency_records: IdempotencyRecordsTable;
}
