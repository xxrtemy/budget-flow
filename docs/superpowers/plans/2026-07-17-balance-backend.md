# Balance Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать полностью протестированный NestJS backend для баланса, доходов, расходов, обязательств, бюджетных резервов, накоплений и закрытия пользовательских расчётных циклов.

**Architecture:** PostgreSQL хранит неизменяемый двойной ledger и отдельные планы/расписания. Kysely предоставляет типобезопасный persistence layer; чистые доменные функции рассчитывают календарные вхождения и проводки, а NestJS services управляют транзакциями, reconciliation и HTTP API.

**Tech Stack:** NestJS 11, TypeScript, PostgreSQL, Kysely, `pg`, Luxon, class-validator, Nest Schedule, Vitest, Supertest, Testcontainers.

## Global Constraints

- Единственная валюта — `RUB`; суммы передаются положительными safe integer в копейках и хранятся как PostgreSQL `bigint`.
- Пользователь определяется обязательным UUID-заголовком `X-User-Id`; аутентификация не входит в scope.
- Часовая зона профиля — валидная IANA zone, по умолчанию `Europe/Moscow`.
- Периодичности цикла: `WEEKLY | MONTHLY | QUARTERLY | SEMIANNUAL | ANNUAL`.
- Периодичности расписаний: `DAILY | WEEKLY | MONTHLY | QUARTERLY | SEMIANNUAL | ANNUAL`.
- Проведённые ledger-записи неизменяемы; исправление создаёт `REVERSAL` в текущем периоде.
- Запросы, создающие денежные операции, требуют `Idempotency-Key`.
- Каждая задача выполняется test-first; production-код пишется только после наблюдаемого ожидаемого падения теста.

## File Map

- `apps/api/src/database/` — Kysely connection, DB types, migrations and transaction helpers.
- `apps/api/src/finance/domain/` — money, recurrence, period and ledger invariants without Nest or SQL.
- `apps/api/src/finance/profile/` — financial profile and calculation periods.
- `apps/api/src/finance/ledger/` — account creation, postings, balances and reversals.
- `apps/api/src/finance/income/` — one-off income and recurring income schedules.
- `apps/api/src/finance/expenses/` — categories and ordinary expenses.
- `apps/api/src/finance/budgets/` — budget plans and per-period allocations.
- `apps/api/src/finance/obligations/` — mandatory schedules and occurrence cancellation.
- `apps/api/src/finance/savings/` — general savings, goals and transfers.
- `apps/api/src/finance/settlement/` — reconciliation, period closure and settlement offers.
- `apps/api/src/finance/balance/` — balance read model.
- `apps/api/src/finance/http/` — user/idempotency request context, DTO validation and controllers.
- `apps/api/test/` — PostgreSQL integration harness and HTTP end-to-end scenarios.

---

### Task 1: Test harness, PostgreSQL connection and schema

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/tsconfig.json`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/src/database/database.types.ts`
- Create: `apps/api/src/database/database.constants.ts`
- Create: `apps/api/src/database/database.module.ts`
- Create: `apps/api/src/database/database.factory.ts`
- Create: `apps/api/src/database/migrations/001_balance_schema.ts`
- Create: `apps/api/src/database/migrator.ts`
- Create: `apps/api/test/database-test-context.ts`
- Create: `apps/api/test/schema.integration.spec.ts`

**Interfaces:**
- Produces: `DATABASE: unique symbol`, `Database` Kysely table map, `createDatabase(url): Kysely<Database>`, `migrateToLatest(db): Promise<void>`, `createDatabaseTestContext()`.

- [ ] **Step 1: Install runtime and test dependencies**

Run:

```powershell
pnpm --filter @budget-flow/api add kysely pg luxon class-validator class-transformer @nestjs/config @nestjs/schedule
pnpm --filter @budget-flow/api add -D vitest supertest @types/supertest @types/pg @types/luxon @nestjs/testing @testcontainers/postgresql tsx
```

Expected: both commands exit `0`; `pnpm-lock.yaml` records the resolved versions.

- [ ] **Step 2: Add test and migration scripts**

Add these scripts to `apps/api/package.json`:

```json
{
  "test": "vitest run",
  "test:unit": "vitest run src",
  "test:integration": "vitest run test",
  "migrate": "tsx src/database/migrator.ts",
  "migrate:check": "tsx src/database/migrator.ts --check"
}
```

Create `apps/api/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    pool: 'forks',
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 3: Write the failing schema integration test**

Create `apps/api/test/schema.integration.spec.ts`:

```ts
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createDatabaseTestContext, DatabaseTestContext } from './database-test-context';

let context: DatabaseTestContext;

beforeAll(async () => { context = await createDatabaseTestContext(); });
afterAll(async () => { await context.close(); });

test('creates exactly the domain and required Kysely migration tables', async () => {
  const { rows } = await sql<{ table_name: string }>`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
  `.execute(context.db);

  expect(rows.map(({ table_name }) => table_name).sort()).toEqual([
    'budget_allocations', 'budget_plans', 'calculation_periods', 'categories',
    'financial_accounts', 'financial_profiles', 'idempotency_records',
    'income_schedules', 'ledger_postings', 'ledger_transactions',
    'kysely_migration', 'kysely_migration_lock',
    'obligation_schedules', 'schedule_occurrences', 'settlement_offers',
  ]);
});
```

- [ ] **Step 4: Run the test and verify RED**

Run: `pnpm --filter @budget-flow/api test:integration -- schema.integration.spec.ts`

Expected: FAIL because `database-test-context` and the migration do not exist.

- [ ] **Step 5: Implement the database contract and connection**

Use the following shared database contract; every row also has the exact columns required by the approved spec:

```ts
export type CycleCadence = 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';
export type ScheduleCadence = 'DAILY' | CycleCadence;
export type AccountKind =
  | 'FREE' | 'OBLIGATION_RESERVE' | 'BUDGET_RESERVE'
  | 'SAVINGS_GENERAL' | 'SAVINGS_GOAL'
  | 'OPENING_EQUITY' | 'INCOME_SOURCE' | 'EXPENSE_SINK';

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
```

The migration must create UUID primary keys, `user_id` indexes, foreign keys, positive-amount checks, state checks, and these unique keys:

```text
financial_profiles(user_id)
financial_accounts(user_id, kind, reference_id) NULLS NOT DISTINCT
ledger_transactions(user_id, reversal_of) WHERE reversal_of IS NOT NULL
schedule_occurrences(user_id, schedule_type, schedule_id, due_at)
budget_allocations(user_id, budget_plan_id, period_id, occurrence_on)
settlement_offers(user_id, period_id)
idempotency_records(user_id, idempotency_key)
```

Create the tables with this exact application-level column contract (`created_at` and `updated_at` are `timestamptz` unless stated otherwise):

```text
financial_profiles: user_id uuid PK, currency text, timezone text, cadence text,
  next_period_ends_on date, cycle_anchor_day smallint, created_at, updated_at
financial_accounts: id uuid PK, user_id uuid, kind text, reference_id uuid null,
  name text null, target_amount_minor bigint null, archived_at timestamptz null, created_at
ledger_transactions: id uuid PK, user_id uuid, type text, effective_at timestamptz,
  reversal_of uuid null FK ledger_transactions, source_occurrence_id uuid null,
  metadata jsonb, created_at
ledger_postings: id uuid PK, transaction_id uuid FK ledger_transactions,
  user_id uuid, account_id uuid FK financial_accounts, amount_minor bigint, created_at
calculation_periods: id uuid PK, user_id uuid, starts_at timestamptz,
  ends_at_exclusive timestamptz, ends_on_local date, timezone text, status text, closed_at null, created_at
categories: id uuid PK, user_id uuid, name text, archived_at null, created_at, updated_at
income_schedules: id uuid PK, user_id uuid, name text, amount_minor bigint,
  starts_on date, cadence text, archived_at null, created_at, updated_at
obligation_schedules: id uuid PK, user_id uuid, name text, amount_minor bigint,
  starts_on date, cadence text, created_at, updated_at
schedule_occurrences: id uuid PK, user_id uuid, schedule_type text, schedule_id uuid,
  due_at timestamptz, status text, reservation_transaction_id uuid null,
  applied_transaction_id uuid null, cancelled_at timestamptz null, created_at
budget_plans: id uuid PK, user_id uuid, category_id uuid FK categories,
  amount_minor bigint, starts_on date, cadence text, archived_at null, created_at, updated_at
budget_allocations: id uuid PK, user_id uuid, budget_plan_id uuid FK budget_plans,
  period_id uuid FK calculation_periods, occurrence_on date, amount_minor bigint,
  reservation_transaction_id uuid, released_transaction_id uuid null, created_at
settlement_offers: id uuid PK, user_id uuid, period_id uuid FK calculation_periods,
  offered_amount_minor bigint, accepted_amount_minor bigint null, status text,
  accepted_at timestamptz null, transfer_transaction_id uuid null, created_at
idempotency_records: id uuid PK, user_id uuid, idempotency_key text, route text,
  payload_hash text, state text, response_status integer null, response_body jsonb null, created_at, updated_at
```

Add a deferred PostgreSQL constraint trigger that rejects a `ledger_transaction` unless `SUM(ledger_postings.amount_minor) = 0` at commit.

- [ ] **Step 6: Implement the Testcontainers context and migrate**

`createDatabaseTestContext()` must start `PostgreSqlContainer`, call `migrateToLatest`, and expose:

```ts
export interface DatabaseTestContext {
  db: Kysely<Database>;
  connectionUri: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}
```

`reset()` truncates all domain tables in reverse dependency order inside one transaction.

- [ ] **Step 7: Verify GREEN and project health**

Run:

```powershell
pnpm --filter @budget-flow/api test:integration -- schema.integration.spec.ts
pnpm --filter @budget-flow/api typecheck
```

Expected: PASS and both commands exit `0`.

- [ ] **Step 8: Commit**

```powershell
git add apps/api/package.json pnpm-lock.yaml apps/api/vitest.config.ts apps/api/src/database apps/api/test
git commit -m "feat(api): add financial database foundation"
```

---

### Task 2: Money, recurrence, financial profile and periods

**Files:**
- Create: `apps/api/src/finance/domain/money.ts`
- Create: `apps/api/src/finance/domain/money.spec.ts`
- Create: `apps/api/src/finance/domain/recurrence.ts`
- Create: `apps/api/src/finance/domain/recurrence.spec.ts`
- Create: `apps/api/src/finance/profile/profile.repository.ts`
- Create: `apps/api/src/finance/profile/profile.service.ts`
- Create: `apps/api/src/finance/profile/profile.service.integration.spec.ts`
- Create: `apps/api/src/finance/profile/profile.types.ts`

**Interfaces:**
- Produces: `assertMoneyMinor(value): number`, `occurrencesWithin(rule, range): string[]`, `nextPeriodEnd(endOn, cadence): string`, `ProfileService.upsert`, `ProfileService.get`, `ProfileService.getCurrentPeriod`.

- [ ] **Step 1: Write failing money and calendar tests**

```ts
expect(() => assertMoneyMinor(0)).toThrow('amountMinor must be a positive safe integer');
expect(() => assertMoneyMinor(10.5)).toThrow('amountMinor must be a positive safe integer');
expect(assertMoneyMinor(12_345)).toBe(12_345);

expect(nextPeriodEnd('2028-02-29', 'ANNUAL', 29)).toBe('2029-02-28');
expect(nextPeriodEnd('2029-02-28', 'ANNUAL', 29)).toBe('2030-02-28');
expect(nextPeriodEnd('2026-01-31', 'MONTHLY', 31)).toBe('2026-02-28');
expect(nextPeriodEnd('2026-02-28', 'MONTHLY', 31)).toBe('2026-03-31');
expect(nextPeriodEnd('2026-01-31', 'QUARTERLY', 31)).toBe('2026-04-30');

expect(occurrencesWithin(
  { startsOn: '2026-07-01', cadence: 'WEEKLY' },
  { startsOn: '2026-07-01', endsOnExclusive: '2026-07-22' },
)).toEqual(['2026-07-01', '2026-07-08', '2026-07-15']);
```

Also cover DST conversion for `Europe/Moscow` and `America/New_York`, inclusive API end date, daily/monthly/semiannual cadences, and a profile created mid-day.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @budget-flow/api test:unit -- finance/domain`

Expected: FAIL because the domain functions do not exist.

- [ ] **Step 3: Implement pure calendar functions**

Use Luxon `DateTime.fromISO(date, { zone }).startOf('day')`. Preserve an anchor day for monthly-or-longer schedules and clamp with `Math.min(anchorDay, target.daysInMonth)`. Do not add fixed millisecond durations for calendar periods.

```ts
export interface RecurrenceRule {
  startsOn: string;
  cadence: ScheduleCadence;
}

export interface LocalDateRange {
  startsOn: string;
  endsOnExclusive: string;
}

export function occurrencesWithin(
  rule: RecurrenceRule,
  range: LocalDateRange,
): string[];

export function nextPeriodEnd(
  previousEndOn: string,
  cadence: CycleCadence,
  anchorDay: number,
): string;

export function localDateToInstant(
  localDate: string,
  zone: string,
): Date;
```

- [ ] **Step 4: Write the failing profile integration test**

The test must upsert a profile ending `2026-07-25`, verify the first period begins at the injected clock time and ends at local midnight after July 25, then verify `MONTHLY` creates the next inclusive end date `2026-08-25`. Updating cadence must leave the open period unchanged and apply the supplied end date to the next unopened period.

- [ ] **Step 5: Run and verify RED**

Run: `pnpm --filter @budget-flow/api test:integration -- profile.service.integration.spec.ts`

Expected: FAIL because `ProfileService` does not exist.

- [ ] **Step 6: Implement profile and period persistence**

```ts
export interface UpsertProfileInput {
  userId: string;
  timezone?: string;
  firstPeriodEndsOn: string;
  cadence: CycleCadence;
}

export interface FinancialProfile {
  userId: string;
  currency: 'RUB';
  timezone: string;
  cadence: CycleCadence;
  createdAt: Date;
}
```

Profile creation must atomically create `FREE`, `OBLIGATION_RESERVE`, `SAVINGS_GENERAL`, `OPENING_EQUITY`, `INCOME_SOURCE`, and `EXPENSE_SINK` accounts plus the first `OPEN` period.

- [ ] **Step 7: Verify GREEN**

Run: `pnpm --filter @budget-flow/api test -- finance/domain profile.service.integration.spec.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add apps/api/src/finance/domain apps/api/src/finance/profile
git commit -m "feat(api): add financial profiles and periods"
```

---

### Task 3: Immutable double-entry ledger

**Files:**
- Create: `apps/api/src/finance/ledger/ledger.types.ts`
- Create: `apps/api/src/finance/ledger/ledger.service.ts`
- Create: `apps/api/src/finance/ledger/ledger.service.integration.spec.ts`
- Create: `apps/api/src/finance/ledger/account.repository.ts`

**Interfaces:**
- Consumes: `DATABASE`, `assertMoneyMinor`.
- Produces: `LedgerService.createOpeningBalance`, `LedgerService.post`, `LedgerService.reverse`, `LedgerService.getAccountBalance`, `LedgerService.list`.

- [ ] **Step 1: Write failing ledger tests**

```ts
const transaction = await ledger.post({
  userId,
  type: 'OPENING_BALANCE',
  effectiveAt: now,
  postings: [
    { accountId: openingEquityId, amountMinor: -100_000 },
    { accountId: freeId, amountMinor: 100_000 },
  ],
});

expect(await ledger.getAccountBalance(userId, freeId)).toBe(100_000);
expect(transaction.postings.reduce((sum, p) => sum + p.amountMinor, 0)).toBe(0);
```

Add tests that unbalanced postings fail, another user's account returns `404`, one opening balance is allowed, a reversal mirrors postings exactly, and a second reversal returns `409`.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @budget-flow/api test:integration -- ledger.service.integration.spec.ts`

Expected: FAIL because `LedgerService` does not exist.

- [ ] **Step 3: Implement the ledger transaction boundary**

```ts
export interface PostLedgerInput {
  userId: string;
  type: LedgerTransactionType;
  effectiveAt: Date;
  postings: ReadonlyArray<{ accountId: string; amountMinor: number }>;
  metadata?: Record<string, unknown>;
  sourceOccurrenceId?: string;
}

export class LedgerService {
  createOpeningBalance(userId: string, amountMinor: number, effectiveAt: Date): Promise<LedgerTransaction>;
  post(input: PostLedgerInput, trx?: Transaction<Database>): Promise<LedgerTransaction>;
  reverse(userId: string, transactionId: string, now: Date): Promise<LedgerTransaction>;
  getAccountBalance(userId: string, accountId: string, trx?: Transaction<Database>): Promise<number>;
  list(userId: string, cursor?: string): Promise<{
    items: LedgerTransaction[];
    nextCursor: string | null;
  }>;
}
```

Validate at least two non-zero postings, a zero sum, account ownership, safe integer values, and allowed negative balances. Insert the transaction and all postings in the same DB transaction.

- [ ] **Step 4: Implement account locks for constrained transfers**

`lockAccounts(userId, accountIds, trx)` sorts UUIDs, selects them `FOR UPDATE`, and returns balances. Savings transfers use this helper and reject insufficient source funds; obligation/budget/expense postings may make `FREE` negative.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm --filter @budget-flow/api test:integration -- ledger.service.integration.spec.ts`

Expected: PASS, including the database trigger test for an unbalanced direct insert.

- [ ] **Step 6: Commit**

```powershell
git add apps/api/src/finance/ledger
git commit -m "feat(api): add immutable financial ledger"
```

---

### Task 4: Categories, budget plans and ordinary expenses

**Files:**
- Create: `apps/api/src/finance/expenses/category.service.ts`
- Create: `apps/api/src/finance/expenses/expense.service.ts`
- Create: `apps/api/src/finance/budgets/budget.service.ts`
- Create: `apps/api/src/finance/budgets/budget-calculator.ts`
- Create: `apps/api/src/finance/budgets/budget-calculator.spec.ts`
- Create: `apps/api/src/finance/budgets/budget-expense.integration.spec.ts`

**Interfaces:**
- Consumes: `occurrencesWithin`, `LedgerService`, current `CalculationPeriod`.
- Produces: `CategoryService`, `BudgetService.reconcilePeriod`, `ExpenseService.create`.

- [ ] **Step 1: Write failing allocation tests**

```ts
expect(calculateBudgetOccurrences(
  { amountMinor: 3_000, startsOn: '2026-07-01', cadence: 'WEEKLY' },
  { startsOn: '2026-07-01', endsOnExclusive: '2026-07-29' },
)).toEqual({ occurrenceDates: ['2026-07-01', '2026-07-08', '2026-07-15', '2026-07-22'], totalMinor: 12_000 });
```

Add a mid-period plan test that includes only not-yet-started intervals and a quarterly plan spanning an annual period.

Add lifecycle tests: archiving a plan with a positive reserve posts `BUDGET_RESERVE → FREE` as `BUDGET_RELEASE` before archiving it; archiving a category releases and archives every active plan in that category in one transaction. Historical allocations and expense metadata retain the original category ID.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @budget-flow/api test:unit -- budget-calculator.spec.ts`

Expected: FAIL because the calculator does not exist.

- [ ] **Step 3: Implement allocation calculation**

```ts
export function calculateBudgetOccurrences(
  plan: { amountMinor: number; startsOn: string; cadence: ScheduleCadence },
  period: LocalDateRange,
  notBefore?: string,
): { occurrenceDates: string[]; totalMinor: number };
```

Use `occurrencesWithin`, filter `date >= notBefore`, multiply with `Number.isSafeInteger` overflow protection.

- [ ] **Step 4: Write failing integration scenarios**

Create a `12_000` reserve for food, record an `8_000` expense, and assert `BUDGET_RESERVE=4_000`. Record another `6_000` expense and assert the reserve becomes `0`, `FREE` decreases by `2_000`, and the expense has one ledger transaction with three postings whose sum is zero.

- [ ] **Step 5: Run and verify RED**

Run: `pnpm --filter @budget-flow/api test:integration -- budget-expense.integration.spec.ts`

Expected: FAIL because budget and expense services do not exist.

- [ ] **Step 6: Implement category, budget and expense services**

```ts
export interface CreateExpenseInput {
  userId: string;
  categoryId: string;
  amountMinor: number;
  occurredAt: Date;
  description?: string;
}

export interface CreateBudgetPlanInput {
  userId: string;
  categoryId: string;
  amountMinor: number;
  startsOn: string;
  cadence: ScheduleCadence;
}

export class CategoryService {
  create(userId: string, name: string): Promise<Category>;
  list(userId: string, cursor?: string): Promise<{ items: Category[]; nextCursor: string | null }>;
  update(userId: string, id: string, name: string): Promise<Category>;
  archive(userId: string, id: string): Promise<void>;
}

export class BudgetService {
  create(input: CreateBudgetPlanInput): Promise<BudgetPlan>;
  get(userId: string, id: string): Promise<BudgetPlan>;
  list(userId: string, cursor?: string): Promise<{ items: BudgetPlan[]; nextCursor: string | null }>;
  update(userId: string, id: string, patch: BudgetPlanPatch, now: Date): Promise<BudgetPlan>;
  archive(userId: string, id: string): Promise<void>;
  reconcilePeriod(userId: string, periodId: string, now: Date, trx?: Transaction<Database>): Promise<void>;
}

export class ExpenseService {
  create(input: CreateExpenseInput): Promise<Expense>;
  list(userId: string, cursor?: string): Promise<{ items: Expense[]; nextCursor: string | null }>;
}
```

Each budget plan owns one `BUDGET_RESERVE` account. `reconcilePeriod` creates unique allocation rows and posts `FREE → BUDGET_RESERVE`. Expense creation locks the category reserve and free account, consumes reserve first, posts any remainder from free to `EXPENSE_SINK`, and returns the remaining category reserve.

`BudgetPlanPatch` contains only `amountMinor`, `startsOn`, and `cadence`; category ownership is immutable. `BudgetService.archive` locks the plan and reserve account, posts any positive balance back to `FREE` as `BUDGET_RELEASE`, then archives plan/account atomically. `CategoryService.archive` locks the category and all active plans/accounts, releases every positive reserve, archives those plans/accounts, then archives the category in the same transaction.

- [ ] **Step 7: Verify GREEN**

Run: `pnpm --filter @budget-flow/api test -- budget-calculator budget-expense.integration.spec.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add apps/api/src/finance/expenses apps/api/src/finance/budgets
git commit -m "feat(api): add category budgets and expenses"
```

---

### Task 5: One-off and recurring income

**Files:**
- Create: `apps/api/src/finance/income/income.service.ts`
- Create: `apps/api/src/finance/income/income.repository.ts`
- Create: `apps/api/src/finance/income/income.service.integration.spec.ts`

**Interfaces:**
- Consumes: `occurrencesWithin`, `LedgerService`, `INCOME_SOURCE` and `FREE` accounts.
- Produces: `IncomeService.createOneOff`, create/read/update/archive schedule methods, `IncomeService.materializeAndApplyDue`.

- [ ] **Step 1: Write failing income tests**

Test a one-off income of `150_000` posts `INCOME_SOURCE → FREE`. Create a monthly salary starting on January 31 and reconcile through March 31; assert exactly three occurrences on January 31, February 28 and March 31 and no duplicate transactions after a second reconciliation.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @budget-flow/api test:integration -- income.service.integration.spec.ts`

Expected: FAIL because `IncomeService` does not exist.

- [ ] **Step 3: Implement income commands**

```ts
export interface IncomeScheduleInput {
  userId: string;
  amountMinor: number;
  startsOn: string;
  cadence: ScheduleCadence;
  name: string;
}

export class IncomeService {
  createOneOff(input: OneOffIncomeInput): Promise<LedgerTransaction>;
  listOneOff(userId: string, cursor?: string): Promise<{ items: LedgerTransaction[]; nextCursor: string | null }>;
  createSchedule(input: IncomeScheduleInput): Promise<IncomeSchedule>;
  getSchedule(userId: string, id: string): Promise<IncomeSchedule>;
  listSchedules(userId: string, cursor?: string): Promise<{ items: IncomeSchedule[]; nextCursor: string | null }>;
  updateSchedule(userId: string, id: string, patch: IncomeSchedulePatch): Promise<IncomeSchedule>;
  archiveSchedule(userId: string, id: string): Promise<void>;
  materializeAndApplyDue(userId: string, through: Date, trx?: Transaction<Database>): Promise<void>;
}
```

Schedule changes affect only unmaterialized occurrences. Use `(user_id, schedule_type, schedule_id, due_at)` uniqueness and attach the occurrence ID to the ledger transaction.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm --filter @budget-flow/api test:integration -- income.service.integration.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/finance/income
git commit -m "feat(api): add one-off and recurring income"
```

---

### Task 6: Mandatory obligations and reconciliation

**Files:**
- Create: `apps/api/src/finance/obligations/obligation.service.ts`
- Create: `apps/api/src/finance/obligations/obligation.repository.ts`
- Create: `apps/api/src/finance/obligations/obligation.service.integration.spec.ts`
- Create: `apps/api/src/finance/settlement/reconciliation.service.ts`
- Create: `apps/api/src/finance/settlement/reconciliation.service.integration.spec.ts`

**Interfaces:**
- Consumes: profile periods, recurrence, budget and income services, ledger.
- Produces: obligation create/read/update/cancel occurrence; `ReconciliationService.reconcileUser(userId, now)`.

- [ ] **Step 1: Write failing obligation tests**

Create a monthly obligation of `10_000` due inside the open period. Assert creation immediately posts `FREE → OBLIGATION_RESERVE`. Cancel before due and assert `OBLIGATION_RESERVE → FREE`; the following month's occurrence remains scheduled. In a separate test reconcile past due and assert `OBLIGATION_RESERVE → EXPENSE_SINK` without confirmation. Cancellation after posting must return `409`.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @budget-flow/api test:integration -- obligation.service.integration.spec.ts`

Expected: FAIL because `ObligationService` does not exist.

- [ ] **Step 3: Implement obligation lifecycle**

```ts
export class ObligationService {
  create(input: ObligationScheduleInput): Promise<ObligationSchedule>;
  get(userId: string, id: string): Promise<ObligationSchedule>;
  list(userId: string, cursor?: string): Promise<{
    items: ObligationSchedule[];
    nextCursor: string | null;
  }>;
  updateFuture(userId: string, id: string, patch: ObligationSchedulePatch): Promise<ObligationSchedule>;
  listOccurrences(userId: string, id: string, cursor?: string): Promise<{
    items: Occurrence[];
    nextCursor: string | null;
  }>;
  cancelOccurrence(userId: string, occurrenceId: string, now: Date): Promise<Occurrence>;
  reservePeriod(userId: string, periodId: string, now: Date, trx?: Transaction<Database>): Promise<void>;
  applyDue(userId: string, through: Date, trx?: Transaction<Database>): Promise<void>;
}
```

There is no method for deleting the full obligation schedule. Update only future unmaterialized occurrences.

- [ ] **Step 4: Write failing reconciliation idempotency tests**

Run two concurrent `reconcileUser` calls for the same user and timestamp. Assert one income occurrence, one obligation reserve/payment, one budget allocation and one open period exist. Restart the service clock past a boundary and assert the old period closes and exactly one next period opens.

- [ ] **Step 5: Run and verify RED**

Run: `pnpm --filter @budget-flow/api test:integration -- reconciliation.service.integration.spec.ts`

Expected: FAIL because orchestration is missing.

- [ ] **Step 6: Implement reconciliation ordering**

Within an advisory lock keyed by `userId`, perform this exact order:

```ts
await ensureOpenPeriods(userId, now, trx);
await budgets.reconcileOpenPeriods(userId, now, trx);
await obligations.reserveOpenPeriods(userId, now, trx);
await incomes.materializeAndApplyDue(userId, now, trx);
await obligations.applyDue(userId, now, trx);
await settlement.closeDuePeriods(userId, now, trx);
```

The first implementation of `settlement.closeDuePeriods` may delegate to an injected interface whose real implementation arrives in Task 8; its test fake records calls and returns without state changes.

Define that seam exactly in `reconciliation.service.ts`:

```ts
export const PERIOD_CLOSER = Symbol('PERIOD_CLOSER');

export interface PeriodCloser {
  closeDuePeriods(userId: string, now: Date, trx: Transaction<Database>): Promise<void>;
}
```

Task 8 registers `SettlementService` under `PERIOD_CLOSER`.

- [ ] **Step 7: Verify GREEN**

Run: `pnpm --filter @budget-flow/api test:integration -- obligation reconciliation`

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add apps/api/src/finance/obligations apps/api/src/finance/settlement/reconciliation.service.ts apps/api/src/finance/settlement/reconciliation.service.integration.spec.ts
git commit -m "feat(api): add mandatory payment reconciliation"
```

---

### Task 7: General savings, goals and transfers

**Files:**
- Create: `apps/api/src/finance/savings/savings.service.ts`
- Create: `apps/api/src/finance/savings/savings.service.integration.spec.ts`
- Create: `apps/api/src/finance/savings/savings.types.ts`

**Interfaces:**
- Consumes: account locks and `LedgerService.post`.
- Produces: goal create/read/update/archive methods and transfers between `FREE`, `SAVINGS_GENERAL`, and `SAVINGS_GOAL`.

- [ ] **Step 1: Write failing savings tests**

Create goals `Подушка` and `Отпуск`, transfer `20_000` from free to general savings, `5_000` general-to-goal, `2_000` goal-to-goal, then `1_000` goal-to-free. Assert actual balance is unchanged after every transfer and each account balance matches. Assert insufficient source funds returns `409`, cross-user IDs return `404`, and a non-empty goal cannot be deleted.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @budget-flow/api test:integration -- savings.service.integration.spec.ts`

Expected: FAIL because `SavingsService` does not exist.

- [ ] **Step 3: Implement savings operations**

```ts
export type SavingsEndpoint =
  | { type: 'FREE' }
  | { type: 'GENERAL' }
  | { type: 'GOAL'; goalId: string };

export interface SavingsTransferInput {
  userId: string;
  from: SavingsEndpoint;
  to: SavingsEndpoint;
  amountMinor: number;
  effectiveAt: Date;
}

export class SavingsService {
  createGoal(userId: string, input: { name: string; targetMinor?: number }): Promise<SavingsGoal>;
  getGoal(userId: string, id: string): Promise<SavingsGoal>;
  listGoals(userId: string, cursor?: string): Promise<{ items: SavingsGoal[]; nextCursor: string | null }>;
  updateGoal(userId: string, id: string, patch: { name?: string; targetMinor?: number | null }): Promise<SavingsGoal>;
  archiveGoal(userId: string, id: string): Promise<void>;
  transfer(input: SavingsTransferInput): Promise<LedgerTransaction>;
}
```

Reject identical endpoints. Resolve both accounts under user scope, lock them in UUID order, verify the source balance, and post one zero-sum `SAVINGS_TRANSFER` transaction. Goal deletion is a soft archive allowed only at balance zero.

- [ ] **Step 4: Add a concurrent transfer test and verify GREEN**

Start two transfers that each try to consume the same `FREE` balance. Assert only one succeeds and the source never falls below zero.

Run: `pnpm --filter @budget-flow/api test:integration -- savings.service.integration.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/finance/savings
git commit -m "feat(api): add savings accounts and transfers"
```

---

### Task 8: Period settlement and balance read model

**Files:**
- Create: `apps/api/src/finance/settlement/settlement.service.ts`
- Create: `apps/api/src/finance/settlement/settlement.service.integration.spec.ts`
- Create: `apps/api/src/finance/balance/balance.service.ts`
- Create: `apps/api/src/finance/balance/balance.service.integration.spec.ts`

**Interfaces:**
- Consumes: ledger, budgets, periods, savings general account.
- Produces: `SettlementService.closeDuePeriods`, `SettlementService.acceptOffer`, `BalanceService.get`.

- [ ] **Step 1: Write failing settlement tests**

For one period, post `100_000` income, reserve `30_000`, spend `20_000` from the reserve, and post a `10_000` obligation. Close the period and assert the remaining `10_000` budget returns to free and the offer is `70_000`. Assert opening balance and internal transfers are excluded. A zero or negative result creates no positive offer.

Accept the whole offer and assert `FREE → SAVINGS_GENERAL`. In a separate case spend part of free after closure; accepting more than `min(offered, currentFree)` returns `409` with `availableAmountMinor`. Accepting a custom smaller amount marks the offer `ACCEPTED` once and leaves the remainder free.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @budget-flow/api test:integration -- settlement.service.integration.spec.ts`

Expected: FAIL because `SettlementService` does not exist.

- [ ] **Step 3: Implement closure and offer acceptance**

```ts
export class SettlementService {
  closeDuePeriods(userId: string, now: Date, trx?: Transaction<Database>): Promise<void>;
  listOffers(userId: string, cursor?: string): Promise<{
    items: SettlementOffer[];
    nextCursor: string | null;
  }>;
  acceptOffer(input: {
    userId: string;
    offerId: string;
    amountMinor?: number;
    acceptedAt: Date;
  }): Promise<SettlementOffer>;
}
```

Calculate `netCashResult` only from `INCOME`, `ORDINARY_EXPENSE`, `OBLIGATION_PAYMENT`, and current-period `REVERSAL` transaction types. Release each open budget reserve before reading current free. Insert one offer per period and open the next period in the same transaction.

- [ ] **Step 4: Write the failing balance projection test**

Assert this exact response after a mixed scenario:

```ts
expect(await balance.get(userId, now)).toEqual({
  asOf: now,
  currency: 'RUB',
  actualMinor: 100_000,
  freeMinor: 35_000,
  obligationReserveMinor: 10_000,
  budgetReserveMinor: 15_000,
  savingsMinor: 40_000,
  savingsGeneralMinor: 25_000,
  goals: [{ id: goalId, name: 'Подушка', balanceMinor: 15_000, targetMinor: 100_000 }],
  deficitMinor: 0,
  currentPeriod: expect.objectContaining({ status: 'OPEN' }),
  pendingSettlementOffers: [],
});
```

Add a negative-free case where `deficitMinor = Math.abs(freeMinor)`.

- [ ] **Step 5: Run and verify RED**

Run: `pnpm --filter @budget-flow/api test:integration -- balance.service.integration.spec.ts`

Expected: FAIL because `BalanceService` does not exist.

- [ ] **Step 6: Implement the read model and wire real settlement into reconciliation**

`BalanceService.get` first calls `reconcileUser`, then aggregates asset accounts with one grouped Kysely query and loads goal/period/offer details under the same user scope. Break the reconciliation cycle by exposing `getWithoutReconciliation` for internal use; only the controller-facing `get` invokes reconciliation.

- [ ] **Step 7: Verify GREEN, including concurrent acceptance**

Run: `pnpm --filter @budget-flow/api test:integration -- settlement balance reconciliation`

Expected: PASS; two concurrent accept requests produce one transfer and one `409`.

- [ ] **Step 8: Commit**

```powershell
git add apps/api/src/finance/settlement apps/api/src/finance/balance
git commit -m "feat(api): add period settlement and balance projection"
```

---

### Task 9: HTTP API, idempotency and scheduled reconciliation

**Files:**
- Create: `apps/api/src/finance/http/current-user.decorator.ts`
- Create: `apps/api/src/finance/http/current-user.pipe.ts`
- Create: `apps/api/src/finance/http/is-iana-timezone.decorator.ts`
- Create: `apps/api/src/finance/http/idempotent.decorator.ts`
- Create: `apps/api/src/finance/http/idempotency.service.ts`
- Create: `apps/api/src/finance/http/idempotency.interceptor.ts`
- Create: `apps/api/src/finance/http/dto/profile.dto.ts`
- Create: `apps/api/src/finance/http/dto/opening-balance.dto.ts`
- Create: `apps/api/src/finance/http/dto/income.dto.ts`
- Create: `apps/api/src/finance/http/dto/income-schedule.dto.ts`
- Create: `apps/api/src/finance/http/dto/expense.dto.ts`
- Create: `apps/api/src/finance/http/dto/category.dto.ts`
- Create: `apps/api/src/finance/http/dto/obligation.dto.ts`
- Create: `apps/api/src/finance/http/dto/budget.dto.ts`
- Create: `apps/api/src/finance/http/dto/settlement.dto.ts`
- Create: `apps/api/src/finance/http/dto/savings.dto.ts`
- Create: `apps/api/src/finance/http/dto/pagination.dto.ts`
- Create: `apps/api/src/finance/http/profile.controller.ts`
- Create: `apps/api/src/finance/http/income.controller.ts`
- Create: `apps/api/src/finance/http/expense.controller.ts`
- Create: `apps/api/src/finance/http/obligation.controller.ts`
- Create: `apps/api/src/finance/http/budget.controller.ts`
- Create: `apps/api/src/finance/http/savings.controller.ts`
- Create: `apps/api/src/finance/http/settlement.controller.ts`
- Create: `apps/api/src/finance/http/balance.controller.ts`
- Create: `apps/api/src/finance/http/ledger.controller.ts`
- Create: `apps/api/src/finance/finance.module.ts`
- Create: `apps/api/src/finance/settlement/reconciliation.scheduler.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/main.ts`
- Create: `apps/api/test/finance.e2e-spec.ts`

**Interfaces:**
- Consumes: all services from Tasks 2–8.
- Produces: every `/finance` route in the design spec, validated DTOs, request idempotency and background reconciliation.

- [ ] **Step 1: Write failing HTTP context and validation tests**

Test that missing/malformed `X-User-Id` returns `400`; missing `Idempotency-Key` on money-writing routes returns `400`; invalid amount, cadence, date and timezone return `400`; another user's IDs return `404`.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @budget-flow/api test:integration -- finance.e2e-spec.ts`

Expected: FAIL because `FinanceModule` and controllers do not exist.

- [ ] **Step 3: Implement request context and DTO validation**

Enable globally in `main.ts`:

```ts
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
}));
```

`@CurrentUserId()` reads `X-User-Id`; the pipe validates UUID. DTOs use `@IsInt()`, `@Min(1)`, `@IsISO8601()`, and `@IsIn(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'])` for schedule cadence. Cycle cadence uses the same list without `DAILY`. A custom `@IsIanaTimezone()` is backed by Luxon `IANAZone.isValidZone`.

- [ ] **Step 4: Implement idempotency before money-writing handlers**

```ts
export interface IdempotentRequest {
  userId: string;
  key: string;
  route: string;
  payloadHash: string;
}

export class IdempotencyService {
  execute<T>(request: IdempotentRequest, work: () => Promise<HttpResult<T>>): Promise<HttpResult<T>>;
}
```

Hash the stable JSON payload plus route with SHA-256. Lock/insert `(user_id, idempotency_key)`; the same hash returns stored status/body, another hash returns `409`. Store the response only after successful domain commit. Concurrent identical requests wait for and replay one result.

- [ ] **Step 5: Implement all controllers**

Controllers must expose exactly:

```text
GET|PUT /finance/profile
POST /finance/opening-balance
GET /finance/balance
POST|GET /finance/incomes
POST|GET|GET:id|PATCH:id|DELETE:id /finance/income-schedules
POST|GET /finance/expenses
POST|GET|PATCH:id|DELETE:id /finance/categories
POST|GET|GET:id|PATCH:id /finance/obligations
GET /finance/obligations/:id/occurrences
POST /finance/obligations/occurrences/:id/cancel
POST|GET|GET:id|PATCH:id|DELETE:id /finance/budgets
GET /finance/periods
GET /finance/periods/current
GET /finance/settlement-offers
POST /finance/settlement-offers/:id/accept
POST|GET|GET:id|PATCH:id|DELETE:id /finance/savings/goals
POST /finance/savings/transfers
GET /finance/ledger
POST /finance/ledger/:transactionId/reverse
```

All list endpoints use opaque base64url cursor `{createdAt,id}` and deterministic `created_at DESC, id DESC` ordering.

- [ ] **Step 6: Add the scheduler**

Import `ScheduleModule.forRoot()`. Every minute, query user IDs whose open period or occurrence is due, then call `reconcileUser` individually. One user's failure is logged and does not stop the remaining users.

- [ ] **Step 7: Complete the end-to-end scenario**

The e2e test must create a profile and opening balance, categories, weekly budget, salary, ordinary expense, mandatory payment, savings goal, then advance an injected clock across the period boundary. Assert balance breakdown, automatic payment, one pending offer, partial acceptance, goal transfer, ledger pagination, idempotent replay and reversal.

- [ ] **Step 8: Verify GREEN**

Run:

```powershell
pnpm --filter @budget-flow/api test
pnpm --filter @budget-flow/api typecheck
pnpm --filter @budget-flow/api build
```

Expected: all commands exit `0` with no test warnings or unhandled rejections.

- [ ] **Step 9: Commit**

```powershell
git add apps/api/src apps/api/test
git commit -m "feat(api): expose balance management API"
```

---

### Task 10: Local PostgreSQL workflow and final verification

**Files:**
- Create: `compose.yaml`
- Create: `.env.example`
- Create: `apps/api/README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: migration CLI and NestJS API.
- Produces: reproducible local database startup, migration and verification commands.

- [ ] **Step 1: Write the local workflow files**

`compose.yaml` defines PostgreSQL with database `budget_flow`, user `budget_flow`, a named volume, healthcheck `pg_isready`, and host port `${POSTGRES_PORT:-5432}`. `.env.example` contains:

```dotenv
DATABASE_URL=postgresql://budget_flow:budget_flow@localhost:5432/budget_flow
PORT=3000
RECONCILIATION_CRON=* * * * *
```

Root scripts:

```json
{
  "db:up": "docker compose up -d postgres",
  "db:down": "docker compose down",
  "db:migrate": "pnpm --filter @budget-flow/api migrate",
  "test": "turbo run test"
}
```

- [ ] **Step 2: Document exact startup and API prerequisites**

`apps/api/README.md` must show `pnpm install`, `pnpm db:up`, copying `.env.example` to `.env`, `pnpm db:migrate`, `pnpm --filter @budget-flow/api dev`, and example `curl` requests with `X-User-Id`, integer kopecks and `Idempotency-Key`.

- [ ] **Step 3: Verify migrations on a clean database**

Run:

```powershell
docker compose up -d postgres
pnpm --filter @budget-flow/api migrate
pnpm --filter @budget-flow/api migrate
```

Expected: first run applies `001_balance_schema`; second reports no pending migrations and exits `0`.

- [ ] **Step 4: Run the complete verification suite**

Run:

```powershell
pnpm test
pnpm typecheck
pnpm build
git diff --check
git status --short
```

Expected: tests, typecheck and build pass; `git diff --check` prints nothing; status contains only the intended Task 10 files.

- [ ] **Step 5: Commit**

```powershell
git add compose.yaml .env.example apps/api/README.md package.json pnpm-lock.yaml
git commit -m "docs(api): add local balance backend workflow"
```

- [ ] **Step 6: Perform final requirements audit**

Read `docs/superpowers/specs/2026-07-16-balance-backend-design.md` section by section and map each requirement to a passing unit, integration or e2e test. Add a missing test before claiming completion; do not weaken an assertion to make the suite pass.
