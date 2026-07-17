import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { Database } from './database.types';

export function createDatabase(url: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: url }),
    }),
  });
}
