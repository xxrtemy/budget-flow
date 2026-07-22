import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';

import { createDatabase } from '../../database/database.factory';
import type { Database } from '../../database/database.types';
import { migrateToLatest } from '../../database/migrator';

export interface FinanceDatabaseTestContext {
  db: Kysely<Database>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createFinanceDatabaseTestContext(): Promise<FinanceDatabaseTestContext> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const db = createDatabase(container.getConnectionUri());
  try {
    await migrateToLatest(db);
  } catch (error) {
    await close(db, container);
    throw error;
  }
  return {
    db,
    async reset() {
      await sql`
        truncate table
          idempotency_records, settlement_offers, budget_allocations, budget_plans,
          schedule_occurrences, obligation_schedules, income_schedules, categories,
          calculation_periods, ledger_postings, ledger_transactions,
          financial_accounts, financial_profiles
        restart identity cascade
      `.execute(db);
    },
    async close() { await close(db, container); },
  };
}

async function close(
  db: Kysely<Database>,
  container: StartedPostgreSqlContainer,
): Promise<void> {
  try {
    await db.destroy();
  } finally {
    await container.stop();
  }
}
