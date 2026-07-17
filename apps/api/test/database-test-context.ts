import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';

import { createDatabase } from '../src/database/database.factory';
import type { Database } from '../src/database/database.types';
import { migrateToLatest } from '../src/database/migrator';

export interface DatabaseTestContext {
  db: Kysely<Database>;
  connectionUri: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createDatabaseTestContext(): Promise<DatabaseTestContext> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const connectionUri = container.getConnectionUri();
  const db = createDatabase(connectionUri);

  try {
    await migrateToLatest(db);
  } catch (error) {
    await closeDatabaseAndContainer(db, container);
    throw error;
  }

  return {
    db,
    connectionUri,
    async reset(): Promise<void> {
      await db.transaction().execute(async (transaction) => {
        await sql`
          truncate table
            idempotency_records,
            settlement_offers,
            budget_allocations,
            budget_plans,
            schedule_occurrences,
            obligation_schedules,
            income_schedules,
            categories,
            calculation_periods,
            ledger_postings,
            ledger_transactions,
            financial_accounts,
            financial_profiles
          restart identity cascade
        `.execute(transaction);
      });
    },
    async close(): Promise<void> {
      await closeDatabaseAndContainer(db, container);
    },
  };
}

async function closeDatabaseAndContainer(
  db: Kysely<Database>,
  container: StartedPostgreSqlContainer,
): Promise<void> {
  try {
    await db.destroy();
  } finally {
    await container.stop();
  }
}
