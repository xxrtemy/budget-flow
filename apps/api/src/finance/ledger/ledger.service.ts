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
import type {
  Database,
  JsonValue,
  LedgerPostingsTable,
  LedgerTransactionsTable,
} from '../../database/database.types';
import { assertMoneyMinor } from '../domain/money';
import { AccountRepository } from './account.repository';
import {
  POST_LEDGER_TRANSACTION_TYPES,
  type LedgerPosting,
  type LedgerTransaction,
  type LedgerTransactionType,
  type PostLedgerInput,
} from './ledger.types';

const PAGE_SIZE = 50;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_MICROS_PATTERN = /^[1-9][0-9]{0,15}$/;
const MAX_CURSOR_MICROS = BigInt(Number.MAX_SAFE_INTEGER);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type TransactionRow = Selectable<LedgerTransactionsTable>;
type PostingRow = Selectable<LedgerPostingsTable>;

interface LedgerCursor {
  createdAtMicros: string;
  id: string;
}

interface InternalPostLedgerInput extends Omit<PostLedgerInput, 'type'> {
  type: LedgerTransactionType;
}

@Injectable()
export class LedgerService {
  private readonly accounts: AccountRepository;

  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {
    this.accounts = new AccountRepository(db);
  }

  async createOpeningBalance(
    userId: string,
    amountMinor: number,
    effectiveAt: Date,
  ): Promise<LedgerTransaction> {
    validatePositiveMoney(amountMinor);

    return this.db.transaction().execute(async (trx) => {
      const accounts = await this.accounts.findByKinds(
        userId,
        ['OPENING_EQUITY', 'FREE'],
        trx,
      );
      const openingEquityId = accounts.find(({ kind }) => kind === 'OPENING_EQUITY')?.id;
      const freeId = accounts.find(({ kind }) => kind === 'FREE')?.id;
      if (!openingEquityId || !freeId) {
        throw new NotFoundException('Financial profile not found');
      }

      return this.post({
        userId,
        type: 'OPENING_BALANCE',
        effectiveAt,
        postings: [
          { accountId: openingEquityId, amountMinor: -amountMinor },
          { accountId: freeId, amountMinor },
        ],
      }, trx);
    });
  }

  async post(
    input: PostLedgerInput,
    trx?: Transaction<Database>,
  ): Promise<LedgerTransaction> {
    validatePostInput(input);

    if (trx) {
      return this.insert(input, null, trx);
    }
    return this.db.transaction().execute((transaction) =>
      this.insert(input, null, transaction));
  }

  async reverse(
    userId: string,
    transactionId: string,
    now: Date,
  ): Promise<LedgerTransaction> {
    validateDate(now);

    return this.db.transaction().execute(async (trx) => {
      const targetRow = await trx
        .selectFrom('ledger_transactions')
        .selectAll()
        .where('user_id', '=', userId)
        .where('id', '=', transactionId)
        .forUpdate()
        .executeTakeFirst();
      if (!targetRow) {
        throw new NotFoundException('Ledger transaction not found');
      }

      const existingReversal = await trx
        .selectFrom('ledger_transactions')
        .select('id')
        .where('user_id', '=', userId)
        .where('reversal_of', '=', transactionId)
        .executeTakeFirst();
      if (existingReversal) {
        throw new ConflictException('Ledger transaction has already been reversed');
      }

      const target = await this.loadTransaction(targetRow, trx);
      const reversalInput: InternalPostLedgerInput = {
        userId,
        type: 'REVERSAL',
        effectiveAt: now,
        metadata: { reversedTransactionId: target.id },
        postings: target.postings.map(({ accountId, amountMinor }) => ({
          accountId,
          amountMinor: -amountMinor,
        })),
      };
      return this.insert(reversalInput, target.id, trx);
    });
  }

  async getAccountBalance(
    userId: string,
    accountId: string,
    trx?: Transaction<Database>,
  ): Promise<number> {
    const balance = await this.accounts.getBalance(userId, accountId, trx ?? this.db);
    if (balance === undefined) {
      throw new NotFoundException('Financial account not found');
    }
    return balance;
  }

  async list(userId: string, cursor?: string): Promise<{
    items: LedgerTransaction[];
    nextCursor: string | null;
  }> {
    const decodedCursor = cursor ? decodeCursor(cursor) : undefined;
    let query = this.db
      .selectFrom('ledger_transactions')
      .selectAll()
      .select(
        sql<string>`((extract(epoch from created_at) * 1000000)::bigint)::text`
          .as('cursor_created_at_micros'),
      )
      .where('user_id', '=', userId);

    if (decodedCursor) {
      const cursorMicros = BigInt(decodedCursor.createdAtMicros);
      const cursorSeconds = (cursorMicros / 1_000_000n).toString();
      const microsRemainder = (cursorMicros % 1_000_000n).toString();
      const cursorTimestamp = sql<Date>`
        timestamptz 'epoch'
        + ${cursorSeconds}::bigint * interval '1 second'
        + ${microsRemainder}::integer * interval '1 microsecond'
      `;
      query = query.where(({ and, eb, or }) => or([
        eb('created_at', '<', cursorTimestamp),
        and([
          eb('created_at', '=', cursorTimestamp),
          eb('id', '<', decodedCursor.id),
        ]),
      ]));
    }

    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(PAGE_SIZE + 1)
      .execute();
    const hasNextPage = rows.length > PAGE_SIZE;
    const pageRows = rows.slice(0, PAGE_SIZE);
    const items = await this.loadTransactions(pageRows, this.db);
    const last = pageRows.at(-1);

    return {
      items,
      nextCursor: hasNextPage && last
        ? encodeCursor({
            createdAtMicros: last.cursor_created_at_micros,
            id: last.id,
          })
        : null,
    };
  }

  private async insert(
    input: InternalPostLedgerInput,
    reversalOf: string | null,
    trx: Transaction<Database>,
  ): Promise<LedgerTransaction> {
    if (input.type === 'OPENING_BALANCE') {
      await this.assertOpeningBalanceAvailable(input.userId, trx);
    }

    const accountIds = input.postings.map(({ accountId }) => accountId);
    const ownedAccounts = await this.accounts.findByIds(input.userId, accountIds, trx);
    if (ownedAccounts.length !== new Set(accountIds).size) {
      throw new NotFoundException('Financial account not found');
    }
    if (input.type === 'OPENING_BALANCE') {
      validateOpeningBalanceShape(input, ownedAccounts);
    }

    const transactionId = randomUUID();
    const row = await trx
      .insertInto('ledger_transactions')
      .values({
        id: transactionId,
        user_id: input.userId,
        type: input.type,
        effective_at: input.effectiveAt,
        reversal_of: reversalOf,
        source_occurrence_id: input.sourceOccurrenceId ?? null,
        metadata: toJsonObject(input.metadata ?? {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('ledger_postings')
      .values(input.postings.map(({ accountId, amountMinor }) => ({
        id: randomUUID(),
        transaction_id: transactionId,
        user_id: input.userId,
        account_id: accountId,
        amount_minor: amountMinor,
      })))
      .execute();

    return this.loadTransaction(row, trx);
  }

  private async assertOpeningBalanceAvailable(
    userId: string,
    trx: Transaction<Database>,
  ): Promise<void> {
    const profile = await trx
      .selectFrom('financial_profiles')
      .select('user_id')
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!profile) {
      throw new NotFoundException('Financial profile not found');
    }

    const existing = await trx
      .selectFrom('ledger_transactions')
      .select('id')
      .where('user_id', '=', userId)
      .where('type', '=', 'OPENING_BALANCE')
      .executeTakeFirst();
    if (existing) {
      throw new ConflictException('Opening balance already exists');
    }
  }

  private async loadTransaction(
    row: TransactionRow,
    executor: Kysely<Database> | Transaction<Database>,
  ): Promise<LedgerTransaction> {
    const [transaction] = await this.loadTransactions([row], executor);
    if (!transaction) {
      throw new Error('Inserted ledger transaction could not be loaded');
    }
    return transaction;
  }

  private async loadTransactions(
    rows: readonly TransactionRow[],
    executor: Kysely<Database> | Transaction<Database>,
  ): Promise<LedgerTransaction[]> {
    if (rows.length === 0) {
      return [];
    }

    const transactionIds = rows.map(({ id }) => id);
    const postingRows = await executor
      .selectFrom('ledger_postings')
      .selectAll()
      .where('transaction_id', 'in', transactionIds)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const postingsByTransaction = new Map<string, LedgerPosting[]>();
    for (const postingRow of postingRows) {
      const postings = postingsByTransaction.get(postingRow.transaction_id) ?? [];
      postings.push(toPosting(postingRow));
      postingsByTransaction.set(postingRow.transaction_id, postings);
    }

    return rows.map((transactionRow) => ({
      id: transactionRow.id,
      userId: transactionRow.user_id,
      type: transactionRow.type as LedgerTransactionType,
      effectiveAt: transactionRow.effective_at,
      reversalOf: transactionRow.reversal_of,
      sourceOccurrenceId: transactionRow.source_occurrence_id,
      metadata: transactionRow.metadata as Record<string, unknown>,
      createdAt: transactionRow.created_at,
      postings: postingsByTransaction.get(transactionRow.id) ?? [],
    }));
  }
}

function validatePostInput(input: PostLedgerInput): void {
  if (!(POST_LEDGER_TRANSACTION_TYPES as readonly string[]).includes(input.type)) {
    throw new BadRequestException('Invalid ledger transaction type');
  }
  validateDate(input.effectiveAt);
  if (input.type === 'OPENING_BALANCE' && input.postings.length !== 2) {
    throw new BadRequestException('Opening balance requires exactly two postings');
  }
  if (input.postings.length < 2) {
    throw new BadRequestException('A ledger transaction requires at least two postings');
  }

  let sum = 0n;
  for (const posting of input.postings) {
    validateSignedMoney(posting.amountMinor);
    sum += BigInt(posting.amountMinor);
  }
  if (sum !== 0n) {
    throw new BadRequestException('Ledger postings must sum to zero');
  }
  toJsonObject(input.metadata ?? {});
}

function validateOpeningBalanceShape(
  input: InternalPostLedgerInput,
  accounts: ReadonlyArray<{ id: string; kind: string }>,
): void {
  const kindById = new Map(accounts.map(({ id, kind }) => [id, kind]));
  const openingEquityPosting = input.postings.find(
    ({ accountId }) => kindById.get(accountId) === 'OPENING_EQUITY',
  );
  const freePosting = input.postings.find(
    ({ accountId }) => kindById.get(accountId) === 'FREE',
  );
  if (!openingEquityPosting || !freePosting
    || openingEquityPosting.amountMinor >= 0
    || freePosting.amountMinor <= 0
    || -openingEquityPosting.amountMinor !== freePosting.amountMinor) {
    throw new BadRequestException(
      'Opening balance must debit OPENING_EQUITY and credit FREE by the same amount',
    );
  }
}

function validatePositiveMoney(value: number): void {
  try {
    assertMoneyMinor(value);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'Invalid amountMinor');
  }
}

function validateSignedMoney(value: number): void {
  if (value === 0) {
    throw new BadRequestException('Ledger posting amount must be non-zero');
  }
  validatePositiveMoney(Math.abs(value));
}

function validateDate(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new BadRequestException('effectiveAt must be a valid Date');
  }
}

function toJsonObject(value: Record<string, unknown>): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error('Metadata is not JSON serializable');
    }
    return JSON.parse(serialized) as JsonValue;
  } catch {
    throw new BadRequestException('metadata must be JSON serializable');
  }
}

function toPosting(row: PostingRow): LedgerPosting {
  const amountMinor = Number(row.amount_minor);
  if (!Number.isSafeInteger(amountMinor)) {
    throw new Error('Stored posting amount exceeds the safe integer range');
  }
  return {
    id: row.id,
    transactionId: row.transaction_id,
    userId: row.user_id,
    accountId: row.account_id,
    amountMinor,
    createdAt: row.created_at,
  };
}

function encodeCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify({
    createdAtMicros: cursor.createdAtMicros,
    id: cursor.id,
  })).toString('base64url');
}

function decodeCursor(cursor: string): LedgerCursor {
  try {
    if (!BASE64URL_PATTERN.test(cursor)) {
      throw new Error('Invalid base64url');
    }
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      createdAtMicros?: unknown;
      id?: unknown;
    };
    if (typeof decoded.createdAtMicros !== 'string'
      || !CURSOR_MICROS_PATTERN.test(decoded.createdAtMicros)
      || BigInt(decoded.createdAtMicros) > MAX_CURSOR_MICROS
      || typeof decoded.id !== 'string'
      || !UUID_PATTERN.test(decoded.id)) {
      throw new Error('Invalid cursor payload');
    }
    const canonical: LedgerCursor = {
      createdAtMicros: decoded.createdAtMicros,
      id: decoded.id,
    };
    if (encodeCursor(canonical) !== cursor) {
      throw new Error('Non-canonical cursor');
    }
    return canonical;
  } catch {
    throw new BadRequestException('Invalid ledger cursor');
  }
}
