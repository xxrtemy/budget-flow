import { Kysely, PostgresDialect } from 'kysely';
import { Pool, TypeOverrides, types } from 'pg';

import type { Database } from './database.types';

export function createDatabase(url: string): Kysely<Database> {
  const databaseTypes = new TypeOverrides();
  databaseTypes.setTypeParser(types.builtins.DATE, (value) => value);

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: url, types: databaseTypes }),
    }),
  });
}
