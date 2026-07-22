import '../config/load-environment';

import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

import { createDatabase } from './database.factory';
import type { Database } from './database.types';
import * as balanceSchema from './migrations/001_balance_schema';

const migrations: Record<string, Migration> = {
  '001_balance_schema': balanceSchema,
};

class BalanceMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({
    db,
    provider: new BalanceMigrationProvider(),
  });
}

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const { error } = await createMigrator(db).migrateToLatest();

  if (error) {
    throw error;
  }
}

async function checkMigrations(db: Kysely<Database>): Promise<void> {
  const pending = (await createMigrator(db).getMigrations()).filter(
    ({ executedAt }) => executedAt === undefined,
  );

  if (pending.length > 0) {
    throw new Error(`Pending migrations: ${pending.map(({ name }) => name).join(', ')}`);
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }

  const db = createDatabase(url);
  try {
    if (process.argv.includes('--check')) {
      await checkMigrations(db);
    } else {
      await migrateToLatest(db);
    }
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
