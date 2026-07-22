import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';

import { DATABASE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import { lockActiveCategory } from '../budgets/budget-locking';
import { FinanceTransactionContext } from '../transaction/finance-transaction-context';
import { assertMoneyMinor } from '../domain/money';
import { AccountRepository } from '../ledger/account.repository';
import { LedgerService } from '../ledger/ledger.service';
import type {
  LedgerPosting,
  LedgerTransaction,
} from '../ledger/ledger.types';
import {
  decodeListCursor,
  encodeListCursor,
  listCursorTimestamp,
} from '../shared/list-cursor';

const PAGE_SIZE = 50;

export interface CreateExpenseInput {
  userId: string;
  categoryId: string;
  amountMinor: number;
  occurredAt: Date;
  description?: string;
}

export interface Expense {
  id: string;
  userId: string;
  categoryId: string;
  amountMinor: number;
  occurredAt: Date;
  description: string | null;
  remainingCategoryReserveMinor: number;
  transaction: LedgerTransaction;
  createdAt: Date;
}

@Injectable()
export class ExpenseService {
  private readonly ledger: LedgerService;
  private readonly accounts: AccountRepository;
  private readonly transactions: FinanceTransactionContext;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    @Optional() transactions?: FinanceTransactionContext,
  ) {
    this.ledger = new LedgerService(db);
    this.accounts = new AccountRepository(db);
    this.transactions = transactions ?? new FinanceTransactionContext();
  }

  async create(input: CreateExpenseInput): Promise<Expense> {
    validateAmount(input.amountMinor);
    validateDate(input.occurredAt);
    const description = validateDescription(input.description);

    return this.transactions.inTransaction(this.db, async (trx) => {
      await lockActiveCategory(input.userId, input.categoryId, trx);
      const reserveAccounts = await trx.selectFrom('financial_accounts')
        .innerJoin('budget_plans', (join) => join
          .onRef('budget_plans.id', '=', 'financial_accounts.reference_id')
          .onRef('budget_plans.user_id', '=', 'financial_accounts.user_id'))
        .select('financial_accounts.id')
        .where('financial_accounts.user_id', '=', input.userId)
        .where('financial_accounts.kind', '=', 'BUDGET_RESERVE')
        .where('financial_accounts.archived_at', 'is', null)
        .where('budget_plans.category_id', '=', input.categoryId)
        .where('budget_plans.archived_at', 'is', null)
        .orderBy('financial_accounts.id')
        .execute();
      const systemAccounts = await trx.selectFrom('financial_accounts')
        .select(['id', 'kind'])
        .where('user_id', '=', input.userId)
        .where('kind', 'in', ['FREE', 'EXPENSE_SINK'])
        .where('archived_at', 'is', null)
        .execute();
      const freeId = systemAccounts.find(({ kind }) => kind === 'FREE')?.id;
      const sinkId = systemAccounts.find(({ kind }) => kind === 'EXPENSE_SINK')?.id;
      if (!freeId || !sinkId) {
        throw new NotFoundException('Financial profile not found');
      }

      const locked = await this.accounts.lockPostingAccounts(
        input.userId,
        [freeId, sinkId, ...reserveAccounts.map(({ id }) => id)],
        trx,
      );
      const balanceById = new Map(locked.map((account) => [
        account.id,
        account.balanceMinor,
      ]));
      let remainingExpense = BigInt(input.amountMinor);
      let remainingReserve = 0n;
      const reservePostings: Array<{ accountId: string; amountMinor: number }> = [];
      for (const account of reserveAccounts) {
        const storedBalance = balanceById.get(account.id) ?? 0n;
        const balance = storedBalance > 0n ? storedBalance : 0n;
        const consumed = balance < remainingExpense ? balance : remainingExpense;
        if (consumed > 0n) {
          reservePostings.push({ accountId: account.id, amountMinor: -Number(consumed) });
          remainingExpense -= consumed;
        }
        remainingReserve += balance - consumed;
      }
      const remainingReserveMinor = safeReserveAggregate(remainingReserve);
      const postings = [
        ...reservePostings,
        ...(remainingExpense > 0n
          ? [{ accountId: freeId, amountMinor: -Number(remainingExpense) }]
          : []),
        { accountId: sinkId, amountMinor: input.amountMinor },
      ];
      const transaction = await this.ledger.post({
        userId: input.userId,
        type: 'ORDINARY_EXPENSE',
        effectiveAt: input.occurredAt,
        metadata: {
          categoryId: input.categoryId,
          ...(description === null ? {} : { description }),
          remainingCategoryReserveMinor: remainingReserveMinor,
        },
        postings,
      }, trx);
      return toExpense(
        transaction,
        input.categoryId,
        input.amountMinor,
        description,
        remainingReserveMinor,
      );
    });
  }

  async list(userId: string, cursor?: string): Promise<{
    items: Expense[];
    nextCursor: string | null;
  }> {
    const decoded = cursor ? decodeListCursor(cursor) : undefined;
    let query = this.db.selectFrom('ledger_transactions')
      .selectAll()
      .select(
        sql<string>`((extract(epoch from created_at) * 1000000)::bigint)::text`
          .as('cursor_created_at_micros'),
      )
      .where('user_id', '=', userId)
      .where('type', '=', 'ORDINARY_EXPENSE');
    if (decoded) {
      const cursorTimestamp = listCursorTimestamp(decoded.createdAtMicros);
      query = query.where(({ and, eb, or }) => or([
        eb('created_at', '<', cursorTimestamp),
        and([
          eb('created_at', '=', cursorTimestamp),
          eb('id', '<', decoded.id),
        ]),
      ]));
    }
    const rows = await query.orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(PAGE_SIZE + 1)
      .execute();
    const pageRows = rows.slice(0, PAGE_SIZE);
    const transactionIds = pageRows.map(({ id }) => id);
    const postingRows = transactionIds.length === 0
      ? []
      : await this.db.selectFrom('ledger_postings')
          .selectAll()
          .where('user_id', '=', userId)
          .where('transaction_id', 'in', transactionIds)
          .orderBy('created_at')
          .orderBy('id')
          .execute();
    const postingsByTransaction = new Map<string, LedgerPosting[]>();
    for (const row of postingRows) {
      const postings = postingsByTransaction.get(row.transaction_id) ?? [];
      postings.push({
        id: row.id,
        transactionId: row.transaction_id,
        userId: row.user_id,
        accountId: row.account_id,
        amountMinor: parseMoney(row.amount_minor),
        createdAt: row.created_at,
      });
      postingsByTransaction.set(row.transaction_id, postings);
    }
    const items = pageRows.map((row) => {
      const metadata = row.metadata as Record<string, unknown>;
      const postings = postingsByTransaction.get(row.id) ?? [];
      const amountMinor = safeExpenseAggregate(postings
        .filter(({ amountMinor }) => amountMinor > 0)
        .map(({ amountMinor }) => amountMinor));
      const transaction: LedgerTransaction = {
        id: row.id,
        userId: row.user_id,
        type: 'ORDINARY_EXPENSE',
        effectiveAt: row.effective_at,
        reversalOf: row.reversal_of,
        sourceOccurrenceId: row.source_occurrence_id,
        metadata,
        createdAt: row.created_at,
        postings,
      };
      return toExpense(
        transaction,
        requiredMetadataString(metadata, 'categoryId'),
        amountMinor,
        optionalMetadataString(metadata, 'description'),
        requiredMetadataMoney(metadata, 'remainingCategoryReserveMinor'),
      );
    });
    const last = pageRows.at(-1);
    return {
      items,
      nextCursor: rows.length > PAGE_SIZE && last
        ? encodeListCursor({
            createdAtMicros: last.cursor_created_at_micros,
            id: last.id,
          })
        : null,
    };
  }
}

function toExpense(
  transaction: LedgerTransaction,
  categoryId: string,
  amountMinor: number,
  description: string | null,
  remainingCategoryReserveMinor: number,
): Expense {
  return {
    id: transaction.id,
    userId: transaction.userId,
    categoryId,
    amountMinor,
    occurredAt: transaction.effectiveAt,
    description,
    remainingCategoryReserveMinor,
    transaction,
    createdAt: transaction.createdAt,
  };
}

function validateAmount(value: number): void {
  try {
    assertMoneyMinor(value);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'Invalid amountMinor');
  }
}

function validateDate(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new BadRequestException('occurredAt must be a valid Date');
  }
}

function validateDescription(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException('description must be a non-empty string');
  }
  return value.trim();
}

function parseMoney(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('Stored expense amount exceeds the safe integer range');
  }
  return parsed;
}

function requiredMetadataString(metadata: Record<string, unknown>, field: string): string {
  const value = metadata[field];
  if (typeof value !== 'string') {
    throw new Error(`Ordinary expense metadata is missing ${field}`);
  }
  return value;
}

function optionalMetadataString(
  metadata: Record<string, unknown>,
  field: string,
): string | null {
  const value = metadata[field];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Ordinary expense metadata has invalid ${field}`);
  }
  return value;
}

function requiredMetadataMoney(metadata: Record<string, unknown>, field: string): number {
  const value = metadata[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Ordinary expense metadata has invalid ${field}`);
  }
  return value;
}

function safeReserveAggregate(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConflictException('Category reserve balance exceeds the safe integer range');
  }
  return Number(value);
}

function safeExpenseAggregate(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConflictException('Expense amount exceeds the safe integer range');
  }
  return Number(total);
}
