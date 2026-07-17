import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';

import { DATABASE } from '../../database/database.constants';
import type { Database, FinancialAccountsTable } from '../../database/database.types';
import { assertMoneyMinor } from '../domain/money';
import { AccountRepository, type LockedPostingAccount } from '../ledger/account.repository';
import { LedgerService } from '../ledger/ledger.service';
import type { LedgerTransaction } from '../ledger/ledger.types';
import {
  decodeListCursor,
  encodeListCursor,
  listCursorTimestamp,
} from '../shared/list-cursor';
import type {
  CreateSavingsGoalInput,
  SavingsEndpoint,
  SavingsGoal,
  SavingsTransferInput,
  UpdateSavingsGoalInput,
} from './savings.types';

const PAGE_SIZE = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AccountRow = Selectable<FinancialAccountsTable>;

interface ResolvedEndpoint {
  id: string;
  kind: 'FREE' | 'SAVINGS_GENERAL' | 'SAVINGS_GOAL';
}

@Injectable()
export class SavingsService {
  private readonly accounts: AccountRepository;
  private readonly ledger: LedgerService;

  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {
    this.accounts = new AccountRepository(db);
    this.ledger = new LedgerService(db);
  }

  async createGoal(userId: string, input: CreateSavingsGoalInput): Promise<SavingsGoal> {
    assertExactKeys(input, ['name', 'targetMinor'], 'goal');
    const name = validateName(input.name);
    const targetMinor = input.targetMinor === undefined
      ? null
      : validateTarget(input.targetMinor);
    return this.db.transaction().execute(async (trx) => {
      const profile = await trx.selectFrom('financial_profiles').select('user_id')
        .where('user_id', '=', userId).forUpdate().executeTakeFirst();
      if (!profile) {
        throw new NotFoundException('Financial profile not found');
      }

      const id = randomUUID();
      const row = await trx.insertInto('financial_accounts').values({
        id,
        user_id: userId,
        kind: 'SAVINGS_GOAL',
        reference_id: id,
        name,
        target_amount_minor: targetMinor,
        archived_at: null,
      }).returningAll().executeTakeFirstOrThrow();
      return toGoal(row, 0n);
    });
  }

  async getGoal(userId: string, id: string): Promise<SavingsGoal> {
    validateGoalId(id);
    const row = await this.findActiveGoal(userId, id, this.db);
    if (!row) {
      throw new NotFoundException('Savings goal not found');
    }
    return toGoal(row, await this.goalBalance(userId, id, this.db));
  }

  async listGoals(userId: string, cursor?: string): Promise<{
    items: SavingsGoal[];
    nextCursor: string | null;
  }> {
    let decoded;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string') {
        throw new BadRequestException('Invalid cursor');
      }
      decoded = decodeListCursor(cursor);
    }
    let query = this.db.selectFrom('financial_accounts')
      .selectAll()
      .select(
        sql<string>`((extract(epoch from created_at) * 1000000)::bigint)::text`
          .as('cursor_created_at_micros'),
      )
      .where('user_id', '=', userId)
      .where('kind', '=', 'SAVINGS_GOAL')
      .where('archived_at', 'is', null);
    if (decoded) {
      const createdAt = listCursorTimestamp(decoded.createdAtMicros);
      query = query.where(({ and, eb, or }) => or([
        eb('created_at', '<', createdAt),
        and([eb('created_at', '=', createdAt), eb('id', '<', decoded.id)]),
      ]));
    }
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc')
      .limit(PAGE_SIZE + 1).execute();
    const pageRows = rows.slice(0, PAGE_SIZE);
    const balanceById = await this.goalBalances(
      userId,
      pageRows.map(({ id }) => id),
      this.db,
    );
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => toGoal(row, balanceById.get(row.id) ?? 0n)),
      nextCursor: rows.length > PAGE_SIZE && last
        ? encodeListCursor({
            createdAtMicros: last.cursor_created_at_micros,
            id: last.id,
          })
        : null,
    };
  }

  async updateGoal(
    userId: string,
    id: string,
    patch: UpdateSavingsGoalInput,
  ): Promise<SavingsGoal> {
    validateGoalId(id);
    assertExactKeys(patch, ['name', 'targetMinor'], 'goal patch');
    if (!Object.hasOwn(patch, 'name') && !Object.hasOwn(patch, 'targetMinor')) {
      throw new BadRequestException('Goal patch must contain a supported field');
    }
    const values: { name?: string; target_amount_minor?: number | null } = {};
    if (Object.hasOwn(patch, 'name')) {
      values.name = validateName(patch.name);
    }
    if (Object.hasOwn(patch, 'targetMinor')) {
      values.target_amount_minor = patch.targetMinor === null
        ? null
        : validateTarget(patch.targetMinor);
    }

    const row = await this.db.updateTable('financial_accounts').set(values)
      .where('user_id', '=', userId).where('id', '=', id)
      .where('kind', '=', 'SAVINGS_GOAL').where('archived_at', 'is', null)
      .returningAll().executeTakeFirst();
    if (!row) {
      throw new NotFoundException('Savings goal not found');
    }
    return toGoal(row, await this.goalBalance(userId, id, this.db));
  }

  async archiveGoal(userId: string, id: string): Promise<void> {
    validateGoalId(id);
    await this.db.transaction().execute(async (trx) => {
      const [account] = await this.accounts.lockPostingAccounts(userId, [id], trx);
      assertActiveGoal(account);
      if (account.balanceMinor !== 0n) {
        throw new ConflictException('Savings goal balance must be zero before archive');
      }
      const archived = await trx.updateTable('financial_accounts')
        .set({ archived_at: new Date() })
        .where('user_id', '=', userId).where('id', '=', id)
        .where('kind', '=', 'SAVINGS_GOAL').where('archived_at', 'is', null)
        .returning('id').executeTakeFirst();
      if (!archived) {
        throw new NotFoundException('Savings goal not found');
      }
    });
  }

  async transfer(input: SavingsTransferInput): Promise<LedgerTransaction> {
    validateTransfer(input);
    return this.db.transaction().execute(async (trx) => {
      const [from, to] = await Promise.all([
        this.resolveEndpoint(input.userId, input.from, trx),
        this.resolveEndpoint(input.userId, input.to, trx),
      ]);
      if (from.id === to.id) {
        throw new BadRequestException('Savings transfer endpoints must be different');
      }

      const locked = await this.accounts.lockPostingAccounts(
        input.userId,
        [from.id, to.id],
        trx,
      );
      const lockedById = new Map(locked.map((account) => [account.id, account]));
      const lockedFrom = assertResolvedEndpoint(from, lockedById.get(from.id));
      assertResolvedEndpoint(to, lockedById.get(to.id));
      const amount = BigInt(input.amountMinor);
      if (lockedFrom.balanceMinor < amount) {
        throw new ConflictException('Savings transfer source has insufficient funds');
      }

      return this.ledger.post({
        userId: input.userId,
        type: 'SAVINGS_TRANSFER',
        effectiveAt: input.effectiveAt,
        metadata: {
          from: endpointMetadata(input.from),
          to: endpointMetadata(input.to),
        },
        postings: [
          { accountId: from.id, amountMinor: -input.amountMinor },
          { accountId: to.id, amountMinor: input.amountMinor },
        ],
      }, trx);
    });
  }

  private async resolveEndpoint(
    userId: string,
    endpoint: SavingsEndpoint,
    trx: Transaction<Database>,
  ): Promise<ResolvedEndpoint> {
    if (endpoint.type === 'GOAL') {
      const goal = await this.findActiveGoal(userId, endpoint.goalId, trx);
      if (!goal) throw new NotFoundException('Savings goal not found');
      return { id: goal.id, kind: 'SAVINGS_GOAL' };
    }
    const kind = endpoint.type === 'FREE' ? 'FREE' : 'SAVINGS_GENERAL';
    const row = await trx.selectFrom('financial_accounts').select(['id', 'kind'])
      .where('user_id', '=', userId).where('kind', '=', kind)
      .where('archived_at', 'is', null).executeTakeFirst();
    if (!row) throw new NotFoundException('Financial account not found');
    return { id: row.id, kind };
  }

  private findActiveGoal(
    userId: string,
    id: string,
    executor: Kysely<Database> | Transaction<Database>,
  ): Promise<AccountRow | undefined> {
    return executor.selectFrom('financial_accounts').selectAll()
      .where('user_id', '=', userId).where('id', '=', id)
      .where('kind', '=', 'SAVINGS_GOAL').where('archived_at', 'is', null)
      .executeTakeFirst();
  }

  private async goalBalance(
    userId: string,
    id: string,
    executor: Kysely<Database> | Transaction<Database>,
  ): Promise<bigint> {
    return (await this.goalBalances(userId, [id], executor)).get(id) ?? 0n;
  }

  private async goalBalances(
    userId: string,
    ids: readonly string[],
    executor: Kysely<Database> | Transaction<Database>,
  ): Promise<Map<string, bigint>> {
    if (ids.length === 0) return new Map();
    const rows = await executor.selectFrom('ledger_postings')
      .select(['account_id', sql<string>`sum(amount_minor)`.as('balance_minor')])
      .where('user_id', '=', userId).where('account_id', 'in', [...ids])
      .groupBy('account_id').execute();
    return new Map(rows.map(({ account_id, balance_minor }) => [
      account_id,
      BigInt(balance_minor),
    ]));
  }
}

function validateTransfer(input: SavingsTransferInput): void {
  if (!isRecord(input)) throw new BadRequestException('Invalid savings transfer');
  assertEndpoint(input.from);
  assertEndpoint(input.to);
  validatePositiveMoney(input.amountMinor);
  if (!(input.effectiveAt instanceof Date) || Number.isNaN(input.effectiveAt.getTime())) {
    throw new BadRequestException('effectiveAt must be a valid Date');
  }
}

function assertEndpoint(value: unknown): asserts value is SavingsEndpoint {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new BadRequestException('Invalid savings endpoint');
  }
  if (value.type === 'FREE' || value.type === 'GENERAL') {
    assertExactKeys(value, ['type'], 'savings endpoint');
    return;
  }
  if (value.type === 'GOAL') {
    assertExactKeys(value, ['type', 'goalId'], 'savings endpoint');
    if (typeof value.goalId !== 'string' || !UUID_PATTERN.test(value.goalId)) {
      throw new BadRequestException('goalId must be a valid UUID');
    }
    return;
  }
  throw new BadRequestException('Invalid savings endpoint');
}

function assertResolvedEndpoint(
  expected: ResolvedEndpoint,
  account: LockedPostingAccount | undefined,
): LockedPostingAccount {
  if (!account || account.kind !== expected.kind || account.archivedAt !== null) {
    throw new NotFoundException(
      expected.kind === 'SAVINGS_GOAL' ? 'Savings goal not found' : 'Financial account not found',
    );
  }
  return account;
}

function assertActiveGoal(
  account: LockedPostingAccount | undefined,
): asserts account is LockedPostingAccount {
  if (!account || account.kind !== 'SAVINGS_GOAL' || account.archivedAt !== null) {
    throw new NotFoundException('Savings goal not found');
  }
}

function validateName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException('name must be a non-empty string');
  }
  return value.trim();
}

function validateGoalId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException('goalId must be a valid UUID');
  }
}

function validateTarget(value: unknown): number {
  validatePositiveMoney(value);
  return value;
}

function validatePositiveMoney(value: unknown): asserts value is number {
  try {
    assertMoneyMinor(value as number);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'Invalid money');
  }
}

function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new BadRequestException(`Invalid ${label}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function endpointMetadata(endpoint: SavingsEndpoint): Record<string, string> {
  return endpoint.type === 'GOAL'
    ? { type: endpoint.type, goalId: endpoint.goalId }
    : { type: endpoint.type };
}

function toGoal(row: {
  id: string;
  user_id: string;
  name: string | null;
  target_amount_minor: string | null;
  created_at: Date;
}, balanceMinor: bigint): SavingsGoal {
  if (row.name === null) throw new Error('Savings goal name is missing');
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    targetMinor: row.target_amount_minor === null
      ? null
      : parseSafeInteger(BigInt(row.target_amount_minor), 'target'),
    balanceMinor: parseSafeInteger(balanceMinor, 'balance'),
    createdAt: row.created_at,
  };
}

function parseSafeInteger(value: bigint, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Stored savings ${label} exceeds the safe integer range`);
  }
  return parsed;
}
