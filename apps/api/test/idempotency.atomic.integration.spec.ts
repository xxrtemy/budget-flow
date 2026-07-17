import { randomUUID } from 'node:crypto';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { IdempotencyService } from '../src/finance/http/idempotency.service';
import { LedgerService } from '../src/finance/ledger/ledger.service';
import { FinanceTransactionContext } from '../src/finance/transaction/finance-transaction-context';
import type { Database } from '../src/database/database.types';
import { ProfileRepository } from '../src/finance/profile/profile.repository';
import { ProfileService } from '../src/finance/profile/profile.service';
import { createDatabaseTestContext, type DatabaseTestContext } from './database-test-context';

const NOW = new Date('2026-07-20T09:00:00.000Z');
let context: DatabaseTestContext;

beforeAll(async () => { context = await createDatabaseTestContext(); });
beforeEach(async () => { await context.reset(); });
afterAll(async () => { await context.close(); });

describe('atomic HTTP idempotency transaction', () => {
  test('rolls back domain ledger work when completion persistence faults, then retries once', async () => {
    const userId = randomUUID();
    await profile(userId);
    const transactions = new FinanceTransactionContext();
    const service = new IdempotencyService(context.db, transactions);
    const ledger = new LedgerService(context.db, transactions);
    await sql`
      create function fail_idempotency_completion() returns trigger as $$
      begin
        if new.state = 'COMPLETED' then
          raise exception 'injected completion fault' using errcode = 'P0001';
        end if;
        return new;
      end;
      $$ language plpgsql;
      create trigger idempotency_completion_fault
        before update on idempotency_records
        for each row execute function fail_idempotency_completion();
    `.execute(context.db);

    try {
      await expect(service.execute({
        userId,
        key: 'atomic-fault',
        route: 'POST /finance/opening-balance',
        payloadHash: 'atomic-fault-hash',
      }, async () => ({
        status: 201,
        body: await ledger.createOpeningBalance(userId, 10_000, NOW),
      }))).rejects.toThrow('injected completion fault');
    } finally {
      await sql`
        drop trigger if exists idempotency_completion_fault on idempotency_records;
        drop function if exists fail_idempotency_completion();
      `.execute(context.db);
    }

    expect(await context.db.selectFrom('ledger_transactions').select('id')
      .where('user_id', '=', userId).execute()).toEqual([]);
    expect(await context.db.selectFrom('idempotency_records').select('id')
      .where('user_id', '=', userId).execute()).toEqual([]);

    const retry = await service.execute({
      userId,
      key: 'atomic-fault',
      route: 'POST /finance/opening-balance',
      payloadHash: 'atomic-fault-hash',
    }, async () => ({
      status: 201,
      body: await ledger.createOpeningBalance(userId, 10_000, NOW),
    }));
    expect(retry.status).toBe(201);
    expect(await context.db.selectFrom('ledger_transactions').select('id')
      .where('user_id', '=', userId).execute()).toHaveLength(1);
  });

  test('completes a money command with a one-connection pool', async () => {
    const userId = randomUUID();
    await profile(userId);
    const singleConnectionDb = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({
          connectionString: context.connectionUri,
          max: 1,
          connectionTimeoutMillis: 500,
        }),
      }),
    });
    try {
      const transactions = new FinanceTransactionContext();
      const service = new IdempotencyService(singleConnectionDb, transactions);
      const ledger = new LedgerService(singleConnectionDb, transactions);
      const result = await service.execute({
        userId,
        key: 'pool-one',
        route: 'POST /finance/opening-balance',
        payloadHash: 'pool-one-hash',
      }, async () => ({
        status: 201,
        body: await ledger.createOpeningBalance(userId, 5_000, NOW),
      }));
      expect(result.status).toBe(201);
    } finally {
      await singleConnectionDb.destroy();
    }
  });

  test('waits on a concurrent identical key and replays one committed effect', async () => {
    const result = await runBlockedPair(4_000, 4_000, 48_101);
    expect(result.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
    if (result[0].status !== 'fulfilled' || result[1].status !== 'fulfilled') {
      throw new Error('Expected two fulfilled idempotency results');
    }
    expect(result[1].value).toMatchObject({
      status: result[0].value.status,
      body: JSON.parse(JSON.stringify(result[0].value.body)),
      replayed: true,
    });
    expect(await context.db.selectFrom('ledger_transactions').select('id')
      .where('user_id', '=', result.userId).execute()).toHaveLength(1);
  });

  test('waits on a concurrent conflicting payload and rejects it after the winner commits', async () => {
    const result = await runBlockedPair(4_000, 5_000, 48_102);
    expect(result[0].status).toBe('fulfilled');
    expect(result[1].status).toBe('rejected');
    if (result[1].status !== 'rejected') throw new Error('Expected conflicting request rejection');
    expect(result[1].reason).toMatchObject({ status: 409 });
    expect(await context.db.selectFrom('ledger_transactions').select('id')
      .where('user_id', '=', result.userId).execute()).toHaveLength(1);
  });
});

async function profile(userId: string): Promise<void> {
  await new ProfileService(new ProfileRepository(context.db), () => NOW).upsert({
    userId,
    cadence: 'WEEKLY',
    firstPeriodEndsOn: '2026-07-22',
    timezone: 'Europe/Moscow',
  });
}

type SettledHttpResult = PromiseSettledResult<{
  status: number;
  body: unknown;
  replayed?: boolean;
}>;

async function runBlockedPair(
  firstAmount: number,
  secondAmount: number,
  advisoryKey: number,
): Promise<[SettledHttpResult, SettledHttpResult] & { userId: string }> {
  const userId = randomUUID();
  await profile(userId);
  const transactions = new FinanceTransactionContext();
  const service = new IdempotencyService(context.db, transactions);
  const ledger = new LedgerService(context.db, transactions);
  await sql`
    create function block_idempotency_completion() returns trigger as $$
    begin
      perform pg_advisory_xact_lock(${sql.raw(advisoryKey.toString())});
      return new;
    end;
    $$ language plpgsql;
    create trigger idempotency_completion_barrier
      before update on idempotency_records
      for each row execute function block_idempotency_completion();
  `.execute(context.db);

  let settled: [SettledHttpResult, SettledHttpResult] | undefined;
  try {
    await context.db.connection().execute(async (locker) => {
      await sql`select pg_advisory_lock(${advisoryKey})`.execute(locker);
      try {
        const first = executeOpening(service, ledger, userId, firstAmount, 'blocked-key');
        await waitForBlockedQuery('update "idempotency_records"');
        const second = executeOpening(service, ledger, userId, secondAmount, 'blocked-key');
        await waitForBlockedQuery('insert into "idempotency_records"');
        await sql`select pg_advisory_unlock(${advisoryKey})`.execute(locker);
        settled = await Promise.allSettled([first, second]);
      } finally {
        await sql`select pg_advisory_unlock(${advisoryKey})`.execute(locker);
      }
    });
  } finally {
    await sql`
      drop trigger if exists idempotency_completion_barrier on idempotency_records;
      drop function if exists block_idempotency_completion();
    `.execute(context.db);
  }
  if (!settled) throw new Error('Idempotency pair did not settle');
  return Object.assign(settled, { userId });
}

function executeOpening(
  service: IdempotencyService,
  ledger: LedgerService,
  userId: string,
  amountMinor: number,
  key: string,
) {
  return service.execute({
    userId,
    key,
    route: 'POST /finance/opening-balance',
    payloadHash: `amount:${amountMinor}`,
  }, async () => ({
    status: 201,
    body: await ledger.createOpeningBalance(userId, amountMinor, NOW),
  }));
}

async function waitForBlockedQuery(fragment: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await sql<{ count: string }>`
      select count(*)::text as count
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and query ilike ${`%${fragment}%`}
    `.execute(context.db);
    if (Number(result.rows[0]?.count ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for blocked query: ${fragment}`);
}
