import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';

import { DATABASE } from '../../database/database.constants';
import type { Database, SettlementOffersTable } from '../../database/database.types';
import { BudgetService } from '../budgets/budget.service';
import { assertMoneyMinor } from '../domain/money';
import { localDateToInstant, nextPeriodEnd } from '../domain/recurrence';
import { AccountRepository } from '../ledger/account.repository';
import { LedgerService } from '../ledger/ledger.service';
import {
  decodeListCursor,
  encodeListCursor,
  listCursorTimestamp,
} from '../shared/list-cursor';
import type { PeriodCloser } from './reconciliation.service';
import { FinanceTransactionContext } from '../transaction/finance-transaction-context';

const PAGE_SIZE = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_ACCOUNT_KINDS = [
  'FREE', 'OBLIGATION_RESERVE', 'BUDGET_RESERVE', 'SAVINGS_GENERAL', 'SAVINGS_GOAL',
] as const;

export interface SettlementOffer {
  id: string;
  userId: string;
  periodId: string;
  offeredAmountMinor: number;
  acceptedAmountMinor: number | null;
  status: 'PENDING' | 'ACCEPTED';
  acceptedAt: Date | null;
  transferTransactionId: string | null;
  createdAt: Date;
}

export interface AcceptSettlementOfferInput {
  userId: string;
  offerId: string;
  amountMinor?: number;
  acceptedAt: Date;
}

@Injectable()
export class SettlementService implements PeriodCloser {
  private readonly ledger: LedgerService;
  private readonly accounts: AccountRepository;
  private readonly transactions: FinanceTransactionContext;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    private readonly budgets: BudgetService,
    @Optional() transactions?: FinanceTransactionContext,
  ) {
    this.ledger = new LedgerService(db);
    this.accounts = new AccountRepository(db);
    this.transactions = transactions ?? new FinanceTransactionContext();
  }

  async closeDuePeriods(
    userId: string,
    now: Date,
    trx?: Transaction<Database>,
  ): Promise<void> {
    validateUuid(userId, 'userId');
    validateDate(now, 'now');
    if (trx) {
      await this.closeOne(userId, now, trx);
      return;
    }
    await this.transactions.inTransaction(
      this.db,
      (transaction) => this.closeOne(userId, now, transaction),
    );
  }

  async listOffers(userId: string, cursor?: string): Promise<{
    items: SettlementOffer[];
    nextCursor: string | null;
  }> {
    validateUuid(userId, 'userId');
    const decoded = cursor === undefined ? undefined : decodeListCursor(cursor);
    let query = this.db.selectFrom('settlement_offers').selectAll()
      .select(sql<string>`((extract(epoch from created_at) * 1000000)::bigint)::text`
        .as('cursor_created_at_micros'))
      .where('user_id', '=', userId);
    if (decoded) {
      const createdAt = listCursorTimestamp(decoded.createdAtMicros);
      query = query.where(({ and, eb, or }) => or([
        eb('created_at', '<', createdAt),
        and([eb('created_at', '=', createdAt), eb('id', '<', decoded.id)]),
      ]));
    }
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc')
      .limit(PAGE_SIZE + 1).execute();
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: page.map(toOffer),
      nextCursor: rows.length > PAGE_SIZE && last
        ? encodeListCursor({ createdAtMicros: last.cursor_created_at_micros, id: last.id })
        : null,
    };
  }

  async acceptOffer(input: AcceptSettlementOfferInput): Promise<SettlementOffer> {
    validateAcceptInput(input);
    return this.transactions.inTransaction(this.db, async (trx) => {
      const offer = await trx.selectFrom('settlement_offers').selectAll()
        .where('user_id', '=', input.userId).where('id', '=', input.offerId)
        .forUpdate().executeTakeFirst();
      if (!offer) throw new NotFoundException('Settlement offer not found');
      if (offer.status !== 'PENDING') throw new ConflictException('Settlement offer is not pending');

      const offered = parseMoney(offer.offered_amount_minor, 'offered amount');
      const requested = input.amountMinor ?? offered;
      validatePositiveMoney(requested);
      if (requested > offered) {
        throw new BadRequestException('amountMinor must not exceed the offered amount');
      }

      const identities = await this.accounts.findByKinds(
        input.userId,
        ['FREE', 'SAVINGS_GENERAL'],
        trx,
      );
      const freeId = identities.find(({ kind }) => kind === 'FREE')?.id;
      const savingsId = identities.find(({ kind }) => kind === 'SAVINGS_GENERAL')?.id;
      if (!freeId || !savingsId || identities.length !== 2) {
        throw new NotFoundException('Financial profile not found');
      }
      const locked = await this.accounts.lockPostingAccounts(
        input.userId,
        [freeId, savingsId],
        trx,
      );
      const free = locked.find(({ id }) => id === freeId)!;
      const available = Number(free.balanceMinor > 0n
        ? (free.balanceMinor < BigInt(offered) ? free.balanceMinor : BigInt(offered))
        : 0n);
      if (requested > available) {
        throw new ConflictException({
          message: 'Settlement amount exceeds currently available FREE',
          availableAmountMinor: available,
        });
      }

      const transfer = await this.ledger.post({
        userId: input.userId,
        type: 'SETTLEMENT_TRANSFER',
        effectiveAt: input.acceptedAt,
        metadata: { settlementOfferId: offer.id, periodId: offer.period_id },
        postings: [
          { accountId: freeId, amountMinor: -requested },
          { accountId: savingsId, amountMinor: requested },
        ],
      }, trx);
      const accepted = await trx.updateTable('settlement_offers').set({
        status: 'ACCEPTED',
        accepted_amount_minor: requested,
        accepted_at: input.acceptedAt,
        transfer_transaction_id: transfer.id,
      }).where('user_id', '=', input.userId).where('id', '=', offer.id)
        .where('status', '=', 'PENDING').returningAll().executeTakeFirstOrThrow();
      return toOffer(accepted);
    });
  }

  private async closeOne(
    userId: string,
    now: Date,
    trx: Transaction<Database>,
  ): Promise<void> {
    const profile = await trx.selectFrom('financial_profiles').selectAll()
      .where('user_id', '=', userId).forUpdate().executeTakeFirst();
    if (!profile) throw new NotFoundException('Financial profile not found');
    const period = await trx.selectFrom('calculation_periods').selectAll()
      .where('user_id', '=', userId).where('status', '=', 'OPEN')
      .orderBy('starts_at').orderBy('id').forUpdate().executeTakeFirst();
    if (!period) throw new NotFoundException('Current calculation period not found');
    if (period.ends_at_exclusive > now) return;

    const plans = await this.budgets.lockActivePlansForSettlement(userId, trx);
    await this.lockCompleteAssetAccountSet(userId, trx);
    await this.budgets.releasePeriodRemainders(userId, period.id, now, trx, plans);
    const netCashResult = await exactNetCashResult(userId, period.starts_at, period.ends_at_exclusive, trx);
    const [free] = await this.accounts.findByKinds(userId, ['FREE'], trx);
    if (!free) throw new NotFoundException('Financial profile not found');
    const [lockedFree] = await this.accounts.lockPostingAccounts(userId, [free.id], trx);
    const freeBalance = lockedFree!.balanceMinor;
    const offerAmount = minBigInt(maxZero(netCashResult), maxZero(freeBalance));

    await trx.updateTable('calculation_periods').set({ status: 'CLOSED', closed_at: now })
      .where('user_id', '=', userId).where('id', '=', period.id)
      .where('status', '=', 'OPEN').executeTakeFirstOrThrow();
    if (offerAmount > 0n) {
      await trx.insertInto('settlement_offers').values({
        id: randomUUID(), user_id: userId, period_id: period.id,
        offered_amount_minor: parseSafeBigInt(offerAmount, 'settlement offer'),
        accepted_amount_minor: null, status: 'PENDING', accepted_at: null,
        transfer_transaction_id: null,
      }).execute();
    }

    const nextEndsOn = profile.next_period_ends_on;
    const nextEndsExclusive = localDateToInstant(nextLocalDate(nextEndsOn), profile.timezone);
    await trx.insertInto('calculation_periods').values({
      id: randomUUID(), user_id: userId, starts_at: period.ends_at_exclusive,
      ends_at_exclusive: nextEndsExclusive, ends_on_local: nextEndsOn,
      timezone: profile.timezone, status: 'OPEN', closed_at: null,
    }).execute();
    await trx.updateTable('financial_profiles').set({
      next_period_ends_on: nextPeriodEnd(
        nextEndsOn,
        profile.cadence,
        profile.cycle_anchor_day,
      ),
      updated_at: now,
    }).where('user_id', '=', userId).execute();
  }

  private async lockCompleteAssetAccountSet(
    userId: string,
    trx: Transaction<Database>,
  ): Promise<void> {
    const accounts = await trx.selectFrom('financial_accounts').select('id')
      .where('user_id', '=', userId)
      .where('kind', 'in', [...ASSET_ACCOUNT_KINDS])
      .orderBy('id')
      .execute();
    await this.accounts.lockPostingAccounts(
      userId,
      accounts.map(({ id }) => id),
      trx,
    );
  }
}

async function exactNetCashResult(
  userId: string,
  startsAt: Date,
  endsAtExclusive: Date,
  trx: Transaction<Database>,
): Promise<bigint> {
  const result = await sql<{ net_cash: string }>`
    select coalesce(sum(posting.amount_minor), 0)::text as net_cash
    from ledger_transactions transaction
    join ledger_postings posting
      on posting.transaction_id = transaction.id
     and posting.user_id = transaction.user_id
    join financial_accounts account
      on account.id = posting.account_id
     and account.user_id = posting.user_id
    left join ledger_transactions reversed
      on reversed.id = transaction.reversal_of
     and reversed.user_id = transaction.user_id
    where transaction.user_id = ${userId}
      and transaction.effective_at >= ${startsAt}
      and transaction.effective_at < ${endsAtExclusive}
      and account.kind in (
        'FREE', 'OBLIGATION_RESERVE', 'BUDGET_RESERVE',
        'SAVINGS_GENERAL', 'SAVINGS_GOAL'
      )
      and (
        transaction.type in ('INCOME', 'ORDINARY_EXPENSE', 'OBLIGATION_PAYMENT')
        or (
          transaction.type = 'REVERSAL'
          and reversed.type in ('INCOME', 'ORDINARY_EXPENSE', 'OBLIGATION_PAYMENT')
        )
      )
  `.execute(trx);
  return BigInt(result.rows[0]?.net_cash ?? '0');
}

function toOffer(row: Selectable<SettlementOffersTable>): SettlementOffer {
  return {
    id: row.id, userId: row.user_id, periodId: row.period_id,
    offeredAmountMinor: parseMoney(row.offered_amount_minor, 'offered amount'),
    acceptedAmountMinor: row.accepted_amount_minor === null
      ? null : parseMoney(row.accepted_amount_minor, 'accepted amount'),
    status: row.status, acceptedAt: row.accepted_at,
    transferTransactionId: row.transfer_transaction_id, createdAt: row.created_at,
  };
}

function validateAcceptInput(input: AcceptSettlementOfferInput): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BadRequestException('Invalid settlement acceptance');
  }
  if (Object.keys(input).some((key) => ![
    'userId', 'offerId', 'amountMinor', 'acceptedAt',
  ].includes(key))) {
    throw new BadRequestException('Invalid settlement acceptance');
  }
  validateUuid(input.userId, 'userId');
  validateUuid(input.offerId, 'offerId');
  validateDate(input.acceptedAt, 'acceptedAt');
  if (input.amountMinor !== undefined) validatePositiveMoney(input.amountMinor);
}

function validatePositiveMoney(value: number): void {
  try { assertMoneyMinor(value); } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'Invalid amountMinor');
  }
}

function validateUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a valid UUID`);
  }
}

function validateDate(value: unknown, field: string): asserts value is Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new BadRequestException(`${field} must be a valid Date`);
  }
}

function parseMoney(value: string, label: string): number {
  return parseSafeBigInt(BigInt(value), label);
}

function parseSafeBigInt(value: bigint, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Stored ${label} exceeds the safe integer range`);
  return parsed;
}

function nextLocalDate(value: string): string {
  return DateTime.fromISO(value, { zone: 'UTC' }).plus({ days: 1 }).toISODate()!;
}

function maxZero(value: bigint): bigint { return value > 0n ? value : 0n; }
function minBigInt(left: bigint, right: bigint): bigint { return left < right ? left : right; }
