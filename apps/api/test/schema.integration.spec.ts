import { randomUUID } from 'node:crypto';

import { sql, type Kysely, type Selectable, type Transaction, type Updateable } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, expectTypeOf, test } from 'vitest';

import type {
  Database,
  FinancialAccountsTable,
  FinancialProfilesTable,
  SettlementOffersTable,
} from '../src/database/database.types';
import { createDatabaseTestContext, type DatabaseTestContext } from './database-test-context';

let context: DatabaseTestContext | undefined;

beforeAll(async () => { context = await createDatabaseTestContext(); });
beforeEach(async () => { await context?.reset(); });
afterAll(async () => { await context?.close(); });

test('creates exactly the domain and required Kysely migration tables', async () => {
  const { rows } = await sql<{ table_name: string }>`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
  `.execute(database());

  expect(rows.map(({ table_name }) => table_name).sort()).toEqual([
    'budget_allocations', 'budget_plans', 'calculation_periods', 'categories',
    'financial_accounts', 'financial_profiles', 'idempotency_records',
    'income_schedules', 'kysely_migration', 'kysely_migration_lock',
    'ledger_postings', 'ledger_transactions',
    'obligation_schedules', 'schedule_occurrences', 'settlement_offers',
  ]);
});

test('does not duplicate the financial profile primary-key index', async () => {
  const { rows } = await sql<{ indexname: string }>`
    select indexname
    from pg_indexes
    where schemaname = 'public' and tablename = 'financial_profiles'
  `.execute(database());

  expect(rows.map(({ indexname }) => indexname).sort()).toEqual(['financial_profiles_pkey']);
});

test('defaults profile timezone to Europe/Moscow', async () => {
  const userId = randomUUID();

  await sql`
    insert into financial_profiles (
      user_id, currency, cadence, next_period_ends_on, cycle_anchor_day
    ) values (
      ${userId}::uuid, 'RUB', 'MONTHLY', date '2026-08-31', 31
    )
  `.execute(database());

  const profile = await database()
    .selectFrom('financial_profiles')
    .select('timezone')
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();

  expect(profile.timezone).toBe('Europe/Moscow');
});

test('rejects non-RUB profile currency', async () => {
  await expect(sql`
    insert into financial_profiles (
      user_id, currency, timezone, cadence, next_period_ends_on, cycle_anchor_day
    ) values (
      ${randomUUID()}::uuid, 'USD', 'Europe/Moscow', 'MONTHLY', date '2026-08-31', 31
    )
  `.execute(database())).rejects.toThrow();
});

test('rejects a profile timezone outside PostgreSQL IANA names', async () => {
  await expect(sql`
    insert into financial_profiles (
      user_id, currency, timezone, cadence, next_period_ends_on, cycle_anchor_day
    ) values (
      ${randomUUID()}::uuid, 'RUB', 'Mars/Olympus', 'MONTHLY', date '2026-08-31', 31
    )
  `.execute(database())).rejects.toThrow();
});

test('rejects direct ledger transaction updates', async () => {
  const entry = await createBalancedLedgerEntry();

  await expect(sql`
    update ledger_transactions
    set metadata = '{"changed":true}'::jsonb
    where id = ${entry.transactionId}::uuid
  `.execute(database())).rejects.toThrow(/immutable/i);
});

test('rejects direct ledger posting updates', async () => {
  const entry = await createBalancedLedgerEntry();

  await expect(sql`
    update ledger_postings
    set amount_minor = amount_minor
    where id = ${entry.postingIds[0]}::uuid
  `.execute(database())).rejects.toThrow(/immutable/i);
});

test('rejects deleting a complete balanced ledger entry', async () => {
  const entry = await createBalancedLedgerEntry();

  await expect(database().transaction().execute(async (transaction) => {
    await sql`delete from ledger_postings where transaction_id = ${entry.transactionId}::uuid`
      .execute(transaction);
    await sql`delete from ledger_transactions where id = ${entry.transactionId}::uuid`
      .execute(transaction);
  })).rejects.toThrow(/immutable/i);
});

test('requires REVERSAL transactions to reference a transaction', async () => {
  const userId = randomUUID();
  const accounts = await createLedgerAccounts(userId);

  await expect(database().transaction().execute(async (transaction) => {
    await insertLedgerEntry(transaction, { userId, accounts, type: 'REVERSAL' });
  })).rejects.toThrow();
});

test('allows reversal_of only for REVERSAL transactions', async () => {
  const target = await createBalancedLedgerEntry();

  await expect(database().transaction().execute(async (transaction) => {
    await insertLedgerEntry(transaction, {
      userId: target.userId,
      accounts: target.accounts,
      type: 'INCOME',
      reversalOf: target.transactionId,
    });
  })).rejects.toThrow();
});

test('requires a reversal target to belong to the same user', async () => {
  const target = await createBalancedLedgerEntry();
  const reversingUserId = randomUUID();
  const reversingAccounts = await createLedgerAccounts(reversingUserId);

  await expect(database().transaction().execute(async (transaction) => {
    await insertLedgerEntry(transaction, {
      userId: reversingUserId,
      accounts: reversingAccounts,
      type: 'REVERSAL',
      reversalOf: target.transactionId,
    });
  })).rejects.toThrow();
});

test('rejects an unbalanced ledger transaction at commit', async () => {
  const userId = randomUUID();
  const accounts = await createLedgerAccounts(userId);
  let reachedTransactionEnd = false;

  await expect(database().transaction().execute(async (transaction) => {
    await insertLedgerEntry(transaction, { userId, accounts, amounts: [100, -99] });
    reachedTransactionEnd = true;
  })).rejects.toThrow(/not balanced/i);

  expect(reachedTransactionEnd).toBe(true);
});

test('enforces a representative state check', async () => {
  await expect(sql`
    insert into calculation_periods (
      id, user_id, starts_at, ends_at_exclusive, ends_on_local, timezone, status, closed_at
    ) values (
      ${randomUUID()}::uuid, ${randomUUID()}::uuid,
      timestamptz '2026-07-01 00:00:00+03', timestamptz '2026-08-01 00:00:00+03',
      date '2026-07-31', 'Europe/Moscow', 'CLOSED', null
    )
  `.execute(database())).rejects.toThrow();
});

test('enforces NULLS NOT DISTINCT account uniqueness', async () => {
  const userId = randomUUID();
  await sql`
    insert into financial_accounts (id, user_id, kind)
    values (${randomUUID()}::uuid, ${userId}::uuid, 'FREE')
  `.execute(database());

  await expect(sql`
    insert into financial_accounts (id, user_id, kind)
    values (${randomUUID()}::uuid, ${userId}::uuid, 'FREE')
  `.execute(database())).rejects.toThrow();
});

test('enforces a representative foreign key', async () => {
  await expect(sql`
    insert into budget_plans (
      id, user_id, category_id, amount_minor, starts_on, cadence
    ) values (
      ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
      100, date '2026-07-01', 'MONTHLY'
    )
  `.execute(database())).rejects.toThrow();
});

test('exposes timestamp updates as Date and accepts nullable money updates', () => {
  type ProfileRow = Selectable<FinancialProfilesTable>;
  type AccountRow = Selectable<FinancialAccountsTable>;
  type ProfileUpdate = Updateable<FinancialProfilesTable>;
  type AccountUpdate = Updateable<FinancialAccountsTable>;

  expectTypeOf<ProfileRow['created_at']>().toEqualTypeOf<Date>();
  expectTypeOf<ProfileRow['updated_at']>().toEqualTypeOf<Date>();
  expectTypeOf<AccountRow['archived_at']>().toEqualTypeOf<Date | null>();
  expectTypeOf<Exclude<ProfileUpdate['updated_at'], undefined>>().toEqualTypeOf<Date>();
  expectTypeOf<Exclude<AccountUpdate['archived_at'], undefined>>().toEqualTypeOf<Date | null>();
  expectTypeOf<{ accepted_amount_minor: number | null }>()
    .toMatchTypeOf<Updateable<SettlementOffersTable>>();
});

function database(): Kysely<Database> {
  if (!context) {
    throw new Error('Database test context was not created');
  }

  return context.db;
}

interface LedgerAccounts {
  debitId: string;
  creditId: string;
}

interface LedgerEntry {
  userId: string;
  transactionId: string;
  postingIds: [string, string];
  accounts: LedgerAccounts;
}

async function createLedgerAccounts(userId: string): Promise<LedgerAccounts> {
  const accounts = { debitId: randomUUID(), creditId: randomUUID() };
  await sql`
    insert into financial_accounts (id, user_id, kind)
    values
      (${accounts.debitId}::uuid, ${userId}::uuid, 'FREE'),
      (${accounts.creditId}::uuid, ${userId}::uuid, 'INCOME_SOURCE')
  `.execute(database());
  return accounts;
}

async function createBalancedLedgerEntry(): Promise<LedgerEntry> {
  const userId = randomUUID();
  const accounts = await createLedgerAccounts(userId);

  return database().transaction().execute((transaction) =>
    insertLedgerEntry(transaction, { userId, accounts }),
  );
}

async function insertLedgerEntry(
  transaction: Transaction<Database>,
  options: {
    userId: string;
    accounts: LedgerAccounts;
    type?: string;
    reversalOf?: string;
    amounts?: [number, number];
  },
): Promise<LedgerEntry> {
  const transactionId = randomUUID();
  const postingIds: [string, string] = [randomUUID(), randomUUID()];
  const [debitAmount, creditAmount] = options.amounts ?? [100, -100];

  await sql`
    insert into ledger_transactions (id, user_id, type, effective_at, reversal_of)
    values (
      ${transactionId}::uuid, ${options.userId}::uuid, ${options.type ?? 'INCOME'}, now(),
      ${options.reversalOf ?? null}::uuid
    )
  `.execute(transaction);
  await sql`
    insert into ledger_postings (id, transaction_id, user_id, account_id, amount_minor)
    values
      (
        ${postingIds[0]}::uuid, ${transactionId}::uuid, ${options.userId}::uuid,
        ${options.accounts.debitId}::uuid, ${debitAmount}
      ),
      (
        ${postingIds[1]}::uuid, ${transactionId}::uuid, ${options.userId}::uuid,
        ${options.accounts.creditId}::uuid, ${creditAmount}
      )
  `.execute(transaction);

  return { userId: options.userId, transactionId, postingIds, accounts: options.accounts };
}
