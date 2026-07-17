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
    'income_schedules', 'kysely_migration', 'kysely_migration_lock',
    'ledger_postings', 'ledger_transactions',
    'obligation_schedules', 'schedule_occurrences', 'settlement_offers',
  ]);
});
