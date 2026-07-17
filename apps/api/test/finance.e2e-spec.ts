import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { AppModule } from '../src/app.module';
import { DATABASE } from '../src/database/database.constants';
import { FINANCE_CLOCK } from '../src/finance/finance.constants';
import { configureApp } from '../src/configure-app';
import { createDatabaseTestContext, type DatabaseTestContext } from './database-test-context';

let context: DatabaseTestContext;
let app: INestApplication;
let now = new Date('2026-07-20T09:00:00.000Z');

beforeAll(async () => {
  context = await createDatabaseTestContext();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DATABASE).useValue(context.db)
    .overrideProvider(FINANCE_CLOCK).useValue(() => now)
    .compile();
  app = module.createNestApplication();
  configureApp(app);
  await app.init();
  const schedulerRegistry = app.get(SchedulerRegistry);
  for (const [name, job] of schedulerRegistry.getCronJobs()) {
    job.stop();
    schedulerRegistry.deleteCronJob(name);
  }
});

beforeEach(async () => {
  now = new Date('2026-07-20T09:00:00.000Z');
  await context.reset();
});

afterAll(async () => {
  await app?.close();
  await context?.close();
});

describe('finance HTTP context and validation', () => {
  test.each([
    {},
    { 'X-User-Id': '' },
    { 'X-User-Id': 'not-a-uuid' },
  ])('rejects a missing, blank or malformed user header before domain SQL', async (headers) => {
    const response = await request(app.getHttpServer()).get('/finance/profile').set(headers);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toMatch(/select |postgres|sqlstate|2350/i);
  });

  test('rejects repeated user headers, malformed UUID paths and unexpected body/query keys', async () => {
    const repeated = await request(app.getHttpServer())
      .get('/finance/profile')
      .set({ 'X-User-Id': [randomUUID(), randomUUID()] } as any);
    expect(repeated.status).toBe(400);

    const userId = randomUUID();
    await createProfile(userId);
    expect((await api(userId).get('/finance/budgets/not-a-uuid')).status).toBe(400);
    expect((await api(userId).get('/finance/categories').query({ unexpected: 'x' })).status).toBe(400);
    expect((await api(userId).post('/finance/categories').send({ name: 'Food', extra: true })).status)
      .toBe(400);
  });

  test('validates money, exact dates, instants, cycle cadence and IANA timezone', async () => {
    const userId = randomUUID();
    for (const body of [
      { cadence: 'DAILY', firstPeriodEndsOn: '2026-07-12' },
      { cadence: 'WEEKLY', firstPeriodEndsOn: '2026-02-30' },
      { cadence: 'WEEKLY', firstPeriodEndsOn: '2026-07-12', timezone: 'Mars/Olympus' },
    ]) {
      expect((await api(userId).put('/finance/profile').send(body)).status).toBe(400);
    }

    await createProfile(userId);
    for (const body of [
      { amountMinor: 0, effectiveAt: now.toISOString() },
      { amountMinor: Number.MAX_SAFE_INTEGER + 1, effectiveAt: now.toISOString() },
      { amountMinor: 100, effectiveAt: '2026-07-10' },
    ]) {
      expect((await api(userId).post('/finance/opening-balance')
        .set('Idempotency-Key', randomUUID()).send(body)).status).toBe(400);
    }
  });
});

describe('finance routes and tenant scoping', () => {
  test('wires representative CRUD/list/current-period routes and hides foreign IDs', async () => {
    const owner = randomUUID();
    const stranger = randomUUID();
    await createProfile(owner);
    await createProfile(stranger);

    const category = await api(owner).post('/finance/categories').send({ name: 'Еда' });
    expect(category.status).toBe(201);
    expect(category.body).toMatchObject({ userId: owner, name: 'Еда' });
    expect((await api(owner).get('/finance/categories')).body.items).toHaveLength(1);
    expect((await api(owner).patch(`/finance/categories/${category.body.id}`)
      .send({ name: 'Продукты' })).body.name).toBe('Продукты');
    expect((await api(stranger).patch(`/finance/categories/${category.body.id}`)
      .send({ name: 'Чужое' })).status).toBe(404);

    const current = await api(owner).get('/finance/periods/current');
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ userId: owner, status: 'OPEN' });
    const periods = await api(owner).get('/finance/periods');
    expect(periods.body).toEqual({ items: [current.body], nextCursor: null });
  });

  test('exposes every route family with service-shaped DTOs', async () => {
    const userId = randomUUID();
    await createProfile(userId);
    await opening(userId, 200_000, 'opening-routes');

    const category = (await api(userId).post('/finance/categories').send({ name: 'Еда' })).body;
    const income = await api(userId).post('/finance/incomes')
      .set('Idempotency-Key', 'income-routes')
      .send({ amountMinor: 10_000, effectiveAt: now.toISOString(), name: 'Разовый' });
    expect(income.status).toBe(201);
    expect((await api(userId).get('/finance/incomes')).body.items).toHaveLength(1);

    const schedule = await api(userId).post('/finance/income-schedules').send({
      amountMinor: 50_000, startsOn: '2026-07-11', cadence: 'MONTHLY', name: 'Зарплата',
    });
    expect((await api(userId).get(`/finance/income-schedules/${schedule.body.id}`)).status).toBe(200);
    expect((await api(userId).patch(`/finance/income-schedules/${schedule.body.id}`)
      .send({ name: 'Оклад' })).status).toBe(200);

    const budget = await api(userId).post('/finance/budgets')
      .set('Idempotency-Key', 'budget-routes')
      .send({ categoryId: category.id, amountMinor: 7_000, startsOn: '2026-07-10', cadence: 'WEEKLY' });
    expect((await api(userId).get(`/finance/budgets/${budget.body.id}`)).status).toBe(200);
    expect((await api(userId).get('/finance/budgets')).body.items).toHaveLength(1);

    const expense = await api(userId).post('/finance/expenses')
      .set('Idempotency-Key', 'expense-routes')
      .send({ categoryId: category.id, amountMinor: 1_000, occurredAt: now.toISOString() });
    expect(expense.status).toBe(201);
    expect((await api(userId).get('/finance/expenses')).body.items).toHaveLength(1);

    const obligation = await api(userId).post('/finance/obligations')
      .set('Idempotency-Key', 'obligation-routes')
      .send({ amountMinor: 2_000, startsOn: '2026-07-11', cadence: 'MONTHLY', name: 'Связь' });
    expect((await api(userId).get(`/finance/obligations/${obligation.body.id}`)).status).toBe(200);
    expect((await api(userId).get(`/finance/obligations/${obligation.body.id}/occurrences`)).status)
      .toBe(200);

    const goal = await api(userId).post('/finance/savings/goals').send({ name: 'Подушка', targetMinor: 100_000 });
    expect((await api(userId).get(`/finance/savings/goals/${goal.body.id}`)).status).toBe(200);
    expect((await api(userId).get('/finance/savings/goals')).body.items).toHaveLength(1);
    expect((await api(userId).post('/finance/savings/transfers')
      .set('Idempotency-Key', 'transfer-routes')
      .send({ from: { type: 'FREE' }, to: { type: 'GOAL', goalId: goal.body.id }, amountMinor: 500,
        effectiveAt: now.toISOString() })).status).toBe(201);

    expect((await api(userId).get('/finance/balance')).status).toBe(200);
    expect((await api(userId).get('/finance/settlement-offers')).status).toBe(200);
    const ledger = await api(userId).get('/finance/ledger');
    expect(ledger.status).toBe(200);
    expect(ledger.body.items.length).toBeGreaterThan(0);
  });
});

describe('HTTP idempotency', () => {
  test('requires a key only on handlers that can create a ledger transaction', async () => {
    const userId = randomUUID();
    await createProfile(userId);
    const category = (await api(userId).post('/finance/categories').send({ name: 'Еда' })).body;

    const marked: Array<[string, string, unknown]> = [
      ['post', '/finance/opening-balance', { amountMinor: 1_000, effectiveAt: now.toISOString() }],
      ['post', '/finance/incomes', { amountMinor: 100, effectiveAt: now.toISOString() }],
      ['post', '/finance/expenses', { categoryId: category.id, amountMinor: 100, occurredAt: now.toISOString() }],
      ['post', '/finance/obligations', { amountMinor: 100, startsOn: '2026-07-11', cadence: 'DAILY', name: 'x' }],
      ['post', '/finance/budgets', { categoryId: category.id, amountMinor: 100, startsOn: '2026-07-10', cadence: 'DAILY' }],
      ['patch', `/finance/obligations/${randomUUID()}`, { amountMinor: 100 }],
      ['post', `/finance/obligations/occurrences/${randomUUID()}/cancel`, {}],
      ['patch', `/finance/budgets/${randomUUID()}`, { amountMinor: 100 }],
      ['delete', `/finance/budgets/${randomUUID()}`, {}],
      ['post', `/finance/settlement-offers/${randomUUID()}/accept`, {}],
      ['post', '/finance/savings/transfers', { from: { type: 'FREE' }, to: { type: 'GENERAL' }, amountMinor: 100, effectiveAt: now.toISOString() }],
      ['post', `/finance/ledger/${randomUUID()}/reverse`, {}],
    ];
    for (const [method, path, body] of marked) {
      const response = await (api(userId) as any)[method](path).send(body);
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(400);
    }

    expect((await api(userId).post('/finance/income-schedules').send({
      amountMinor: 100, startsOn: '2026-07-11', cadence: 'DAILY', name: 'x',
    })).status).toBe(201);
    expect((await api(userId).post('/finance/savings/goals').send({ name: 'x' })).status).toBe(201);
  });

  test('replays exact status/body once and rejects changed payload or route', async () => {
    const userId = randomUUID();
    await createProfile(userId);
    const first = await opening(userId, 5_000, 'same-key');
    const replay = await api(userId).post('/finance/opening-balance')
      .set('Idempotency-Key', 'same-key')
      .send({ effectiveAt: now.toISOString(), amountMinor: 5_000 });
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual(first.body);
    expect(await context.db.selectFrom('ledger_transactions').select('id')
      .where('user_id', '=', userId).where('type', '=', 'OPENING_BALANCE').execute()).toHaveLength(1);

    expect((await opening(userId, 6_000, 'same-key')).status).toBe(409);
    expect((await api(userId).post('/finance/incomes').set('Idempotency-Key', 'same-key')
      .send({ amountMinor: 5_000, effectiveAt: now.toISOString() })).status).toBe(409);
  });

  test('serializes concurrent identical and conflicting requests without exposing 23505', async () => {
    const userId = randomUUID();
    await createProfile(userId);
    const identical = await Promise.all([
      opening(userId, 5_000, 'concurrent-same'),
      opening(userId, 5_000, 'concurrent-same'),
    ]);
    expect(identical.map(({ status }) => status)).toEqual([201, 201]);
    expect(identical[0]!.body).toEqual(identical[1]!.body);

    const conflict = await Promise.all([
      api(userId).post('/finance/incomes').set('Idempotency-Key', 'concurrent-different')
        .send({ amountMinor: 100, effectiveAt: now.toISOString() }),
      api(userId).post('/finance/incomes').set('Idempotency-Key', 'concurrent-different')
        .send({ amountMinor: 200, effectiveAt: now.toISOString() }),
    ]);
    expect(conflict.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(JSON.stringify(conflict.map(({ body }) => body))).not.toContain('23505');
  });

  test('recovers a stale matching PROCESSING row but never replays a fresh incomplete row', async () => {
    const userId = randomUUID();
    await createProfile(userId);
    const body = { amountMinor: 5_000, effectiveAt: now.toISOString() };
    const route = 'POST /finance/opening-balance';
    const hash = requestHash('POST', route, body, {}, {});
    await context.db.insertInto('idempotency_records').values({
      id: randomUUID(), user_id: userId, idempotency_key: 'stale-key', route,
      payload_hash: hash, state: 'PROCESSING', response_status: null, response_body: null,
      updated_at: new Date('2026-07-16T00:00:00.000Z'),
    }).execute();
    expect((await api(userId).post('/finance/opening-balance')
      .set('Idempotency-Key', 'stale-key').send(body)).status).toBe(201);

    const secondUser = randomUUID();
    await createProfile(secondUser);
    await context.db.insertInto('idempotency_records').values({
      id: randomUUID(), user_id: secondUser, idempotency_key: 'fresh-key', route,
      payload_hash: hash, state: 'PROCESSING', response_status: null, response_body: null,
    }).execute();
    const fresh = await api(secondUser).post('/finance/opening-balance')
      .set('Idempotency-Key', 'fresh-key').send(body);
    expect(fresh.status).toBe(409);
    expect(fresh.body.message).toContain('still processing');
    expect(await context.db.selectFrom('ledger_transactions').select('id')
      .where('user_id', '=', secondUser).execute()).toEqual([]);
  });

  test('does not cache a failed domain attempt', async () => {
    const userId = randomUUID();
    await createProfile(userId);
    await opening(userId, 100, 'error-opening');
    const transfer = {
      from: { type: 'FREE' }, to: { type: 'GENERAL' }, amountMinor: 200,
      effectiveAt: now.toISOString(),
    };
    expect((await api(userId).post('/finance/savings/transfers')
      .set('Idempotency-Key', 'retry-after-error').send(transfer)).status).toBe(409);
    await api(userId).post('/finance/incomes').set('Idempotency-Key', 'error-top-up')
      .send({ amountMinor: 200, effectiveAt: now.toISOString() }).expect(201);
    expect((await api(userId).post('/finance/savings/transfers')
      .set('Idempotency-Key', 'retry-after-error').send(transfer)).status).toBe(201);
  });
});

describe('approved finance flow', () => {
  test('covers reconciliation, settlement, savings, balance, pagination and reversal end to end', async () => {
    const userId = randomUUID();
    await createProfile(userId);
    await opening(userId, 100_000, 'flow-opening');
    const category = (await api(userId).post('/finance/categories').send({ name: 'Еда и транспорт' })).body;
    await api(userId).post('/finance/budgets').set('Idempotency-Key', 'flow-budget').send({
      categoryId: category.id, amountMinor: 30_000, startsOn: '2026-07-21', cadence: 'WEEKLY',
    }).expect(201);
    const oneOff = await api(userId).post('/finance/incomes').set('Idempotency-Key', 'flow-income').send({
      amountMinor: 100_000, effectiveAt: now.toISOString(), name: 'Премия',
    }).expect(201);
    await api(userId).post('/finance/income-schedules').send({
      amountMinor: 10_000, startsOn: '2026-07-21', cadence: 'DAILY', name: 'Начисление',
    }).expect(201);

    // Balance reconciliation reserves the active weekly budget before the expense.
    expect((await api(userId).get('/finance/balance')).body.budgetReserveMinor).toBe(30_000);
    await api(userId).post('/finance/expenses').set('Idempotency-Key', 'flow-expense').send({
      categoryId: category.id, amountMinor: 20_000, occurredAt: now.toISOString(), description: 'Неделя',
    }).expect(201);

    const obligation = await api(userId).post('/finance/obligations')
      .set('Idempotency-Key', 'flow-obligation').send({
        amountMinor: 10_000, startsOn: '2026-07-21', cadence: 'DAILY', name: 'Обязательный платёж',
      }).expect(201);
    const occurrences = await api(userId).get(`/finance/obligations/${obligation.body.id}/occurrences`);
    expect(occurrences.body.items).toHaveLength(2);
    await api(userId).post(`/finance/obligations/occurrences/${occurrences.body.items[0].id}/cancel`)
      .set('Idempotency-Key', 'flow-cancel').send({}).expect(201);

    now = new Date('2026-07-23T10:00:00.000Z');
    const afterClose = await api(userId).get('/finance/balance').expect(200);
    expect(afterClose.body.currentPeriod.status).toBe('OPEN');
    const offers = await api(userId).get('/finance/settlement-offers').expect(200);
    expect(offers.body.items).toHaveLength(1);
    expect(offers.body.items[0].offeredAmountMinor).toBe(90_000);
    const reconciledOccurrences = await api(userId)
      .get(`/finance/obligations/${obligation.body.id}/occurrences`).expect(200);
    expect(reconciledOccurrences.body.items.map(({ status }: { status: string }) => status))
      .toEqual(expect.arrayContaining(['CANCELLED', 'APPLIED']));
    const acceptance = await api(userId)
      .post(`/finance/settlement-offers/${offers.body.items[0].id}/accept`)
      .set('Idempotency-Key', 'flow-settlement').send({ amountMinor: 20_000 }).expect(201);
    expect(acceptance.body).toMatchObject({ status: 'ACCEPTED', acceptedAmountMinor: 20_000 });

    const goal = await api(userId).post('/finance/savings/goals')
      .send({ name: 'Подушка', targetMinor: 100_000 }).expect(201);
    await api(userId).post('/finance/savings/transfers').set('Idempotency-Key', 'flow-goal-transfer')
      .send({ from: { type: 'GENERAL' }, to: { type: 'GOAL', goalId: goal.body.id },
        amountMinor: 5_000, effectiveAt: now.toISOString() }).expect(201);
    const balance = await api(userId).get('/finance/balance').expect(200);
    expect(balance.body).toMatchObject({
      currency: 'RUB', savingsMinor: 20_000, savingsGeneralMinor: 15_000,
      goals: [{ id: goal.body.id, name: 'Подушка', balanceMinor: 5_000, targetMinor: 100_000 }],
    });

    for (let index = 0; index < 45; index += 1) {
      await api(userId).post('/finance/incomes').set('Idempotency-Key', `flow-page-${index}`)
        .send({ amountMinor: 1, effectiveAt: now.toISOString(), name: `p${index}` }).expect(201);
    }
    const firstPage = await api(userId).get('/finance/ledger').expect(200);
    expect(firstPage.body.items).toHaveLength(50);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));
    const secondPage = await api(userId).get('/finance/ledger')
      .query({ cursor: firstPage.body.nextCursor }).expect(200);
    expect(secondPage.body.items.length).toBeGreaterThan(0);

    const reversal = await api(userId).post(`/finance/ledger/${oneOff.body.id}/reverse`)
      .set('Idempotency-Key', 'flow-reversal').send({}).expect(201);
    expect(reversal.body).toMatchObject({ type: 'REVERSAL', reversalOf: oneOff.body.id });
    expect((await api(userId).post(`/finance/ledger/${oneOff.body.id}/reverse`)
      .set('Idempotency-Key', 'flow-reversal').send({})).body).toEqual(reversal.body);
    expect((await api(userId).post(`/finance/ledger/${firstPage.body.items[0].id}/reverse`)
      .set('Idempotency-Key', 'flow-reversal').send({})).status).toBe(409);

    const insufficient = await api(userId).post('/finance/savings/transfers')
      .set('Idempotency-Key', 'flow-insufficient').send({
        from: { type: 'GENERAL' }, to: { type: 'FREE' }, amountMinor: 999_999,
        effectiveAt: now.toISOString(),
      });
    expect(insufficient.status).toBe(409);
  });
});

function api(userId: string) {
  const client = request(app.getHttpServer());
  return {
    get: (path: string) => client.get(path).set('X-User-Id', userId),
    put: (path: string) => client.put(path).set('X-User-Id', userId),
    post: (path: string) => client.post(path).set('X-User-Id', userId),
    patch: (path: string) => client.patch(path).set('X-User-Id', userId),
    delete: (path: string) => client.delete(path).set('X-User-Id', userId),
  };
}

async function createProfile(userId: string) {
  const response = await api(userId).put('/finance/profile').send({
    cadence: 'WEEKLY', firstPeriodEndsOn: '2026-07-22', timezone: 'Europe/Moscow',
  });
  expect(response.status).toBe(200);
  return response;
}

function opening(userId: string, amountMinor: number, key: string) {
  return api(userId).post('/finance/opening-balance').set('Idempotency-Key', key).send({
    amountMinor, effectiveAt: now.toISOString(),
  });
}

function requestHash(
  method: string,
  route: string,
  body: unknown,
  params: unknown,
  query: unknown,
): string {
  return createHash('sha256').update(JSON.stringify(sortValue({ method, route, body, params, query })))
    .digest('hex');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]));
  }
  return value;
}
