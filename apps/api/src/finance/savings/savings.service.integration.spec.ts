import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';

import type { Database } from '../../database/database.types';
import { LedgerService } from '../ledger/ledger.service';
import { ProfileRepository } from '../profile/profile.repository';
import { ProfileService } from '../profile/profile.service';
import {
  createFinanceDatabaseTestContext,
  type FinanceDatabaseTestContext,
} from '../test/database-test-context';
import { SavingsService } from './savings.service';
import type { SavingsEndpoint } from './savings.types';

const NOW = new Date('2026-07-17T08:00:00.000Z');
const MAX_SAFE_MONEY = Number.MAX_SAFE_INTEGER;
const ASSET_KINDS = [
  'FREE',
  'OBLIGATION_RESERVE',
  'BUDGET_RESERVE',
  'SAVINGS_GENERAL',
  'SAVINGS_GOAL',
] as const;

let context: FinanceDatabaseTestContext | undefined;

beforeAll(async () => { context = await createFinanceDatabaseTestContext(); });
beforeEach(async () => { await context?.reset(); });
afterAll(async () => { await context?.close(); });

describe('SavingsService', () => {
  test('creates two goals and performs the required transfer sequence without changing actual balance', async () => {
    const userId = await createUser(100_000);
    const service = savingsService();
    const cushion = await service.createGoal(userId, {
      name: '  Подушка  ',
      targetMinor: 500_000,
    });
    const vacation = await service.createGoal(userId, { name: 'Отпуск' });

    expect(cushion).toMatchObject({
      userId,
      name: 'Подушка',
      targetMinor: 500_000,
      balanceMinor: 0,
    });
    expect(vacation).toMatchObject({ targetMinor: null, balanceMinor: 0 });
    await expectGoalIdentity(cushion.id);

    const initialActual = await actualBalance(userId);
    await service.transfer(transfer(userId, { type: 'FREE' }, { type: 'GENERAL' }, 20_000));
    expect(await balances(userId, cushion.id, vacation.id)).toEqual({
      free: 80_000, general: 20_000, cushion: 0, vacation: 0,
    });
    expect(await actualBalance(userId)).toBe(initialActual);

    await service.transfer(transfer(
      userId,
      { type: 'GENERAL' },
      { type: 'GOAL', goalId: cushion.id },
      5_000,
    ));
    expect(await balances(userId, cushion.id, vacation.id)).toEqual({
      free: 80_000, general: 15_000, cushion: 5_000, vacation: 0,
    });
    expect(await actualBalance(userId)).toBe(initialActual);

    await service.transfer(transfer(
      userId,
      { type: 'GOAL', goalId: cushion.id },
      { type: 'GOAL', goalId: vacation.id },
      2_000,
    ));
    expect(await balances(userId, cushion.id, vacation.id)).toEqual({
      free: 80_000, general: 15_000, cushion: 3_000, vacation: 2_000,
    });
    expect(await actualBalance(userId)).toBe(initialActual);

    const transaction = await service.transfer(transfer(
      userId,
      { type: 'GOAL', goalId: vacation.id },
      { type: 'FREE' },
      1_000,
    ));
    expect(transaction.type).toBe('SAVINGS_TRANSFER');
    expect(transaction.postings.map(({ amountMinor }) => amountMinor).sort((a, b) => a - b))
      .toEqual([-1_000, 1_000]);
    expect(await balances(userId, cushion.id, vacation.id)).toEqual({
      free: 81_000, general: 15_000, cushion: 3_000, vacation: 1_000,
    });
    expect(await actualBalance(userId)).toBe(initialActual);
  });

  test('rejects an insufficient source without moving money', async () => {
    const userId = await createUser(10_000);
    const goal = await savingsService().createGoal(userId, { name: 'Goal' });

    await expect(savingsService().transfer(transfer(
      userId,
      { type: 'FREE' },
      { type: 'GOAL', goalId: goal.id },
      10_001,
    ))).rejects.toBeInstanceOf(ConflictException);
    expect(await balances(userId, goal.id)).toEqual({ free: 10_000, general: 0, goal: 0 });
    expect(await savingsTransactionCount(userId)).toBe(0);
  });

  test('transfers from general savings back to free without changing actual balance', async () => {
    const userId = await createUser(10_000);
    const service = savingsService();
    const goal = await service.createGoal(userId, { name: 'Balance probe' });
    const initialActual = await actualBalance(userId);
    await service.transfer(transfer(
      userId, { type: 'FREE' }, { type: 'GENERAL' }, 6_000,
    ));

    await service.transfer(transfer(
      userId, { type: 'GENERAL' }, { type: 'FREE' }, 2_000,
    ));

    expect(await balances(userId, goal.id)).toEqual({
      free: 6_000, general: 4_000, goal: 0,
    });
    expect(await actualBalance(userId)).toBe(initialActual);
  });

  test.each(['getGoal', 'updateGoal', 'archiveGoal'] as const)(
    'rejects a non-UUID goal id at the %s boundary with domain 400',
    async (operation) => {
      const userId = await createUser();
      const service = savingsService();
      const promise = operation === 'getGoal'
        ? service.getGoal(userId, 'invalid')
        : operation === 'updateGoal'
          ? service.updateGoal(userId, 'invalid', { name: 'Updated' })
          : service.archiveGoal(userId, 'invalid');

      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  test('hides foreign, missing and archived goals from every operation', async () => {
    const ownerId = await createUser(10_000);
    const otherId = await createUser(10_000);
    const service = savingsService();
    const goal = await service.createGoal(ownerId, { name: 'Private' });

    await expect(service.getGoal(otherId, goal.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateGoal(otherId, goal.id, { name: 'Stolen' }))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.archiveGoal(otherId, goal.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.transfer(transfer(
      otherId,
      { type: 'FREE' },
      { type: 'GOAL', goalId: goal.id },
      1_000,
    ))).rejects.toBeInstanceOf(NotFoundException);

    await service.archiveGoal(ownerId, goal.id);
    await expect(service.getGoal(ownerId, goal.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateGoal(ownerId, goal.id, { name: 'Again' }))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.archiveGoal(ownerId, goal.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.transfer(transfer(
      ownerId,
      { type: 'FREE' },
      { type: 'GOAL', goalId: goal.id },
      1_000,
    ))).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getGoal(ownerId, randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    expect((await service.listGoals(ownerId)).items).toEqual([]);
  });

  test('validates goal create/update input and allows a target below the current balance', async () => {
    const userId = await createUser(50_000);
    const service = savingsService();

    await expect(service.createGoal(userId, { name: '   ' }))
      .rejects.toBeInstanceOf(BadRequestException);
    for (const targetMinor of [0, -1, 1.5, MAX_SAFE_MONEY + 1]) {
      await expect(service.createGoal(userId, { name: 'Bad target', targetMinor }))
        .rejects.toBeInstanceOf(BadRequestException);
    }

    const goal = await service.createGoal(userId, { name: 'First', targetMinor: 100_000 });
    await service.transfer(transfer(
      userId,
      { type: 'FREE' },
      { type: 'GOAL', goalId: goal.id },
      20_000,
    ));
    const lowerTarget = await service.updateGoal(userId, goal.id, {
      name: '  Updated  ',
      targetMinor: 10_000,
    });
    expect(lowerTarget).toMatchObject({ name: 'Updated', targetMinor: 10_000, balanceMinor: 20_000 });
    expect((await service.updateGoal(userId, goal.id, { targetMinor: null })).targetMinor).toBeNull();

    await expect(service.updateGoal(userId, goal.id, {}))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateGoal(userId, goal.id, { name: ' ' }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateGoal(userId, goal.id, { targetMinor: 0 }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateGoal(userId, goal.id, { unsupported: true } as never))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  test('lists active goals with the canonical stable cursor', async () => {
    const userId = await createUser();
    const service = savingsService();
    for (let index = 0; index < 51; index += 1) {
      await service.createGoal(userId, { name: `Goal ${index}` });
    }

    const first = await service.listGoals(userId);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.listGoals(userId, first.nextCursor!);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(51);
    await expect(service.listGoals(userId, 'not-a-cursor'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  test.each([
    '',
    null,
    false,
    0,
    'not-a-cursor',
    Buffer.from(JSON.stringify({
      id: randomUUID(),
      createdAtMicros: '1',
    })).toString('base64url'),
  ])('rejects an explicitly supplied invalid runtime cursor %#', async (cursor) => {
    const userId = await createUser();
    await savingsService().createGoal(userId, { name: 'Cursor target' });

    await expect(savingsService().listGoals(userId, cursor as string))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  test('archives a goal only when its exact balance is zero', async () => {
    const userId = await createUser(10_000);
    const service = savingsService();
    const goal = await service.createGoal(userId, { name: 'Close me' });
    await service.transfer(transfer(
      userId, { type: 'FREE' }, { type: 'GOAL', goalId: goal.id }, 3_000,
    ));

    await expect(service.archiveGoal(userId, goal.id)).rejects.toBeInstanceOf(ConflictException);
    expect((await service.getGoal(userId, goal.id)).balanceMinor).toBe(3_000);
    await service.transfer(transfer(
      userId, { type: 'GOAL', goalId: goal.id }, { type: 'GENERAL' }, 3_000,
    ));
    await expect(service.archiveGoal(userId, goal.id)).resolves.toBeUndefined();
    await expect(service.getGoal(userId, goal.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  test.each([
    [null, { type: 'FREE' }],
    [{}, { type: 'FREE' }],
    [{ type: 'UNKNOWN' }, { type: 'FREE' }],
    [{ type: 'GOAL' }, { type: 'FREE' }],
    [{ type: 'GOAL', goalId: 'invalid' }, { type: 'FREE' }],
    [{ type: 'FREE', goalId: randomUUID() }, { type: 'GENERAL' }],
  ])('strictly validates endpoint shapes %#', async (from, to) => {
    const userId = await createUser(10_000);
    await expect(savingsService().transfer({
      userId,
      from: from as SavingsEndpoint,
      to: to as SavingsEndpoint,
      amountMinor: 1_000,
      effectiveAt: NOW,
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  test('rejects identical resolved accounts, invalid money and invalid dates', async () => {
    const userId = await createUser(10_000);
    const goal = await savingsService().createGoal(userId, { name: 'Same' });
    for (const [from, to] of [
      [{ type: 'FREE' }, { type: 'FREE' }],
      [{ type: 'GENERAL' }, { type: 'GENERAL' }],
      [{ type: 'GOAL', goalId: goal.id }, { type: 'GOAL', goalId: goal.id }],
    ] as const) {
      await expect(savingsService().transfer(transfer(userId, from, to, 1_000)))
        .rejects.toBeInstanceOf(BadRequestException);
    }
    for (const amountMinor of [0, -1, 1.5, MAX_SAFE_MONEY + 1]) {
      await expect(savingsService().transfer(transfer(
        userId, { type: 'FREE' }, { type: 'GENERAL' }, amountMinor,
      ))).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(savingsService().transfer({
      ...transfer(userId, { type: 'FREE' }, { type: 'GENERAL' }, 1_000),
      effectiveAt: new Date('invalid'),
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  test('serializes competing source transfers so only one affordable transfer commits', async () => {
    const userId = await createUser(10_000);
    const goal = await savingsService().createGoal(userId, { name: 'Race' });
    const barrier = await installLedgerInsertBarrier(47007);
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    try {
      first = savingsService().transfer(transfer(
        userId, { type: 'FREE' }, { type: 'GENERAL' }, 7_000,
      ));
      await waitForBlockedQuery('insert into "ledger_transactions"', 1);
      second = savingsService().transfer(transfer(
        userId, { type: 'FREE' }, { type: 'GOAL', goalId: goal.id }, 7_000,
      ));
      await waitForBlockedQuery('from "financial_accounts"', 1);
      await barrier.release();
      const results = await Promise.allSettled([first, second]);
      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(({ status }) => status === 'rejected');
      expect(rejected).toMatchObject({ status: 'rejected', reason: expect.any(ConflictException) });
    } finally {
      await barrier.release();
      await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]);
      await barrier.cleanup();
    }

    const result = await balances(userId, goal.id);
    expect(result.free).toBe(3_000);
    expect(result.general + (result.goal ?? 0)).toBe(7_000);
    expect(await savingsTransactionCount(userId)).toBe(1);
  });

  test('serializes a transfer that reaches a goal before an archive attempt', async () => {
    const userId = await createUser(10_000);
    const service = savingsService();
    const goal = await service.createGoal(userId, { name: 'Race target' });
    const barrier = await installLedgerInsertBarrier(47008);
    let moving: Promise<unknown> | undefined;
    let archiving: Promise<unknown> | undefined;
    try {
      moving = service.transfer(transfer(
        userId, { type: 'FREE' }, { type: 'GOAL', goalId: goal.id }, 1_000,
      ));
      await waitForBlockedQuery('insert into "ledger_transactions"', 1);
      archiving = service.archiveGoal(userId, goal.id);
      await waitForBlockedQuery('from "financial_accounts"', 1);
      await barrier.release();
      await expect(moving).resolves.toBeDefined();
      await expect(archiving).rejects.toBeInstanceOf(ConflictException);
    } finally {
      await barrier.release();
      await Promise.allSettled([...(moving ? [moving] : []), ...(archiving ? [archiving] : [])]);
      await barrier.cleanup();
    }
    expect((await service.getGoal(userId, goal.id)).balanceMinor).toBe(1_000);
  });

  test('rechecks an archived goal after a waiting transfer acquires the account lock', async () => {
    const userId = await createUser(10_000);
    const service = savingsService();
    const goal = await service.createGoal(userId, { name: 'Archive wins' });
    const barrier = await installGoalArchiveBarrier(47009);
    let archiving: Promise<unknown> | undefined;
    let moving: Promise<unknown> | undefined;
    try {
      archiving = service.archiveGoal(userId, goal.id);
      await waitForBlockedQuery('update "financial_accounts"', 1);
      moving = service.transfer(transfer(
        userId, { type: 'FREE' }, { type: 'GOAL', goalId: goal.id }, 1_000,
      ));
      await waitForBlockedQuery('from "financial_accounts"', 1);
      await barrier.release();
      await expect(archiving).resolves.toBeUndefined();
      await expect(moving).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await barrier.release();
      await Promise.allSettled([...(archiving ? [archiving] : []), ...(moving ? [moving] : [])]);
      await barrier.cleanup();
    }
    expect(await accountBalance(userId, await systemAccountId(userId, 'FREE'))).toBe(10_000);
    expect(await savingsTransactionCount(userId)).toBe(0);
  });

  test('rolls back when the destination safe-integer balance would overflow', async () => {
    const userId = await createUser(MAX_SAFE_MONEY);
    const service = savingsService();
    const goal = await service.createGoal(userId, { name: 'Full' });
    await service.transfer(transfer(
      userId, { type: 'FREE' }, { type: 'GOAL', goalId: goal.id }, MAX_SAFE_MONEY,
    ));
    await new LedgerService(database()).post({
      userId,
      type: 'INCOME',
      effectiveAt: NOW,
      postings: [
        { accountId: await systemAccountId(userId, 'INCOME_SOURCE'), amountMinor: -1 },
        { accountId: await systemAccountId(userId, 'FREE'), amountMinor: 1 },
      ],
    });

    await expect(service.transfer(transfer(
      userId, { type: 'FREE' }, { type: 'GOAL', goalId: goal.id }, 1,
    ))).rejects.toBeInstanceOf(ConflictException);
    expect(await balances(userId, goal.id)).toEqual({
      free: 1, general: 0, goal: MAX_SAFE_MONEY,
    });
    expect(await savingsTransactionCount(userId)).toBe(1);
  });

  test('locks the profile before goal insertion and hides missing-profile creation with 404', async () => {
    const missingUserId = randomUUID();
    await expect(savingsService().createGoal(missingUserId, { name: 'Orphan' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(await goalRowCount(missingUserId)).toBe(0);

    const userId = await createUser();
    const holder = await holdProfileLock(userId);
    let creation: Promise<unknown> | undefined;
    try {
      creation = savingsService().createGoal(userId, { name: 'No phantom' });
      await waitForBlockedQuery('from "financial_profiles"', 1);
      expect(await goalRowCount(userId)).toBe(0);
    } finally {
      await holder.release();
      await Promise.allSettled(creation ? [creation] : []);
    }
    await expect(creation).resolves.toMatchObject({ name: 'No phantom' });
    expect(await goalRowCount(userId)).toBe(1);
  });
});

function savingsService(): SavingsService {
  return new SavingsService(database());
}

async function createUser(openingMinor?: number): Promise<string> {
  const userId = randomUUID();
  await new ProfileService(
    new ProfileRepository(database()),
    () => new Date('2026-07-01T00:00:00.000Z'),
  ).upsert({
    userId,
    firstPeriodEndsOn: '2026-07-31',
    cadence: 'MONTHLY',
  });
  if (openingMinor !== undefined) {
    await new LedgerService(database()).createOpeningBalance(userId, openingMinor, NOW);
  }
  return userId;
}

function transfer(
  userId: string,
  from: SavingsEndpoint,
  to: SavingsEndpoint,
  amountMinor: number,
) {
  return { userId, from, to, amountMinor, effectiveAt: NOW };
}

async function balances(userId: string, firstGoalId: string, secondGoalId?: string) {
  const free = await accountBalance(userId, await systemAccountId(userId, 'FREE'));
  const general = await accountBalance(userId, await systemAccountId(userId, 'SAVINGS_GENERAL'));
  const first = await accountBalance(userId, firstGoalId);
  return secondGoalId
    ? { free, general, cushion: first, vacation: await accountBalance(userId, secondGoalId) }
    : { free, general, goal: first };
}

async function actualBalance(userId: string): Promise<number> {
  const row = await database().selectFrom('ledger_postings')
    .innerJoin('financial_accounts', (join) => join
      .onRef('financial_accounts.id', '=', 'ledger_postings.account_id')
      .onRef('financial_accounts.user_id', '=', 'ledger_postings.user_id'))
    .select(sql<string>`coalesce(sum(ledger_postings.amount_minor), 0)`.as('balance'))
    .where('ledger_postings.user_id', '=', userId)
    .where('financial_accounts.kind', 'in', [...ASSET_KINDS])
    .executeTakeFirstOrThrow();
  return Number(row.balance);
}

async function accountBalance(userId: string, accountId: string): Promise<number> {
  return new LedgerService(database()).getAccountBalance(userId, accountId);
}

async function systemAccountId(
  userId: string,
  kind: 'FREE' | 'SAVINGS_GENERAL' | 'INCOME_SOURCE',
): Promise<string> {
  const row = await database().selectFrom('financial_accounts').select('id')
    .where('user_id', '=', userId).where('kind', '=', kind).executeTakeFirstOrThrow();
  return row.id;
}

async function expectGoalIdentity(goalId: string): Promise<void> {
  const row = await database().selectFrom('financial_accounts')
    .select(['id', 'reference_id', 'kind']).where('id', '=', goalId).executeTakeFirstOrThrow();
  expect(row).toEqual({ id: goalId, reference_id: goalId, kind: 'SAVINGS_GOAL' });
}

async function savingsTransactionCount(userId: string): Promise<number> {
  const row = await database().selectFrom('ledger_transactions')
    .select(sql<string>`count(*)`.as('count')).where('user_id', '=', userId)
    .where('type', '=', 'SAVINGS_TRANSFER').executeTakeFirstOrThrow();
  return Number(row.count);
}

async function goalRowCount(userId: string): Promise<number> {
  const row = await database().selectFrom('financial_accounts')
    .select(sql<string>`count(*)`.as('count')).where('user_id', '=', userId)
    .where('kind', '=', 'SAVINGS_GOAL').executeTakeFirstOrThrow();
  return Number(row.count);
}

interface DatabaseBarrier {
  release(): Promise<void>;
  cleanup(): Promise<void>;
}

async function installLedgerInsertBarrier(key: number): Promise<DatabaseBarrier> {
  return installBarrier(
    key,
    'task7_wait_for_savings_transfer',
    sql`
      create function task7_wait_for_savings_transfer() returns trigger as $$
      begin
        if new.type = 'SAVINGS_TRANSFER' then
          perform pg_advisory_xact_lock(${sql.raw(String(key))});
        end if;
        return new;
      end;
      $$ language plpgsql
    `,
    sql`
      create trigger task7_wait_for_savings_transfer
      before insert on ledger_transactions
      for each row execute function task7_wait_for_savings_transfer()
    `,
    sql`drop trigger if exists task7_wait_for_savings_transfer on ledger_transactions`,
  );
}

async function installGoalArchiveBarrier(key: number): Promise<DatabaseBarrier> {
  return installBarrier(
    key,
    'task7_wait_for_goal_archive',
    sql`
      create function task7_wait_for_goal_archive() returns trigger as $$
      begin
        if old.kind = 'SAVINGS_GOAL' and old.archived_at is null and new.archived_at is not null then
          perform pg_advisory_xact_lock(${sql.raw(String(key))});
        end if;
        return new;
      end;
      $$ language plpgsql
    `,
    sql`
      create trigger task7_wait_for_goal_archive
      before update on financial_accounts
      for each row execute function task7_wait_for_goal_archive()
    `,
    sql`drop trigger if exists task7_wait_for_goal_archive on financial_accounts`,
  );
}

async function installBarrier(
  key: number,
  functionName: string,
  createFunction: ReturnType<typeof sql>,
  createTrigger: ReturnType<typeof sql>,
  dropTrigger: ReturnType<typeof sql>,
): Promise<DatabaseBarrier> {
  const entered = deferred<void>();
  const release = deferred<void>();
  const holder = database().transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(${key})`.execute(trx);
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  try {
    await createFunction.execute(database());
    await createTrigger.execute(database());
  } catch (error) {
    release.resolve();
    await holder;
    await sql.raw(`drop function if exists ${functionName}()`).execute(database());
    throw error;
  }
  let released = false;
  return {
    async release() {
      if (!released) {
        released = true;
        release.resolve();
        await holder;
      }
    },
    async cleanup() {
      await dropTrigger.execute(database());
      await sql.raw(`drop function if exists ${functionName}()`).execute(database());
    },
  };
}

async function holdProfileLock(userId: string) {
  const entered = deferred<void>();
  const release = deferred<void>();
  const holder = database().transaction().execute(async (trx) => {
    await trx.selectFrom('financial_profiles').select('user_id')
      .where('user_id', '=', userId).forUpdate().executeTakeFirstOrThrow();
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let released = false;
  return {
    async release() {
      if (!released) {
        released = true;
        release.resolve();
        await holder;
      }
    },
  };
}

async function waitForBlockedQuery(fragment: string, expectedCount: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await sql<{ count: string }>`
      select count(*)::text as count
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and state = 'active'
        and wait_event_type = 'Lock'
        and query ilike ${`%${fragment}%`}
    `.execute(database());
    if (Number(result.rows[0]?.count ?? 0) >= expectedCount) return;
  }
  throw new Error(`Timed out waiting for ${expectedCount} blocked queries: ${fragment}`);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function database(): Kysely<Database> {
  if (!context) throw new Error('Database test context was not created');
  return context.db;
}
