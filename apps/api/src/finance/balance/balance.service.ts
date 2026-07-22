import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';

import { DATABASE } from '../../database/database.constants';
import type { AccountKind, Database } from '../../database/database.types';
import type { CalculationPeriod } from '../profile/profile.types';
import { ReconciliationService } from '../settlement/reconciliation.service';
import type { SettlementOffer } from '../settlement/settlement.service';

const ASSET_KINDS: AccountKind[] = [
  'FREE', 'OBLIGATION_RESERVE', 'BUDGET_RESERVE', 'SAVINGS_GENERAL', 'SAVINGS_GOAL',
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BalanceProjection {
  asOf: Date;
  currency: 'RUB';
  actualMinor: number;
  freeMinor: number;
  obligationReserveMinor: number;
  budgetReserveMinor: number;
  savingsMinor: number;
  savingsGeneralMinor: number;
  goals: Array<{
    id: string;
    name: string;
    balanceMinor: number;
    targetMinor: number | null;
  }>;
  deficitMinor: number;
  currentPeriod: CalculationPeriod;
  pendingSettlementOffers: SettlementOffer[];
}

@Injectable()
export class BalanceService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    private readonly reconciliation: ReconciliationService,
  ) {}

  async get(userId: string, now: Date): Promise<BalanceProjection> {
    validate(userId, now);
    await this.reconciliation.reconcileUser(userId, now);
    return this.getWithoutReconciliation(userId, now);
  }

  async getWithoutReconciliation(userId: string, now: Date): Promise<BalanceProjection> {
    validate(userId, now);
    const profile = await this.db.selectFrom('financial_profiles').select(['user_id', 'currency'])
      .where('user_id', '=', userId).executeTakeFirst();
    if (!profile) throw new NotFoundException('Financial profile not found');
    const period = await this.db.selectFrom('calculation_periods').selectAll()
      .where('user_id', '=', userId).where('status', '=', 'OPEN')
      .orderBy('starts_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
    if (!period) throw new NotFoundException('Current calculation period not found');

    const rows = await this.db.selectFrom('financial_accounts as account')
      .leftJoin('ledger_postings as posting', (join) => join
        .onRef('posting.account_id', '=', 'account.id')
        .onRef('posting.user_id', '=', 'account.user_id'))
      .select([
        'account.id', 'account.kind', 'account.name', 'account.target_amount_minor',
        'account.archived_at',
        sql<string>`coalesce(sum(posting.amount_minor), 0)::text`.as('balance_minor'),
      ])
      .where('account.user_id', '=', userId)
      .where('account.kind', 'in', ASSET_KINDS)
      .groupBy([
        'account.id', 'account.kind', 'account.name', 'account.target_amount_minor',
        'account.archived_at',
      ])
      .execute();

    let actual = 0n;
    let free = 0n;
    let obligationReserve = 0n;
    let budgetReserve = 0n;
    let savingsGeneral = 0n;
    let savingsGoals = 0n;
    const goals: BalanceProjection['goals'] = [];
    for (const row of rows) {
      const amount = BigInt(row.balance_minor);
      actual += amount;
      if (row.kind === 'FREE') free += amount;
      if (row.kind === 'OBLIGATION_RESERVE') obligationReserve += amount;
      if (row.kind === 'BUDGET_RESERVE') budgetReserve += amount;
      if (row.kind === 'SAVINGS_GENERAL') savingsGeneral += amount;
      if (row.kind === 'SAVINGS_GOAL') {
        savingsGoals += amount;
        if (row.archived_at === null) {
          if (row.name === null) throw new Error('Savings goal name is missing');
          goals.push({
            id: row.id,
            name: row.name,
            balanceMinor: safe(amount, 'goal balance'),
            targetMinor: row.target_amount_minor === null
              ? null : safe(BigInt(row.target_amount_minor), 'goal target'),
          });
        }
      }
    }
    goals.sort((left, right) => left.id.localeCompare(right.id));

    const offerRows = await this.db.selectFrom('settlement_offers').selectAll()
      .where('user_id', '=', userId).where('status', '=', 'PENDING')
      .orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
    return {
      asOf: now,
      currency: profile.currency,
      actualMinor: safe(actual, 'actual balance'),
      freeMinor: safe(free, 'free balance'),
      obligationReserveMinor: safe(obligationReserve, 'obligation reserve'),
      budgetReserveMinor: safe(budgetReserve, 'budget reserve'),
      savingsMinor: safe(savingsGeneral + savingsGoals, 'savings balance'),
      savingsGeneralMinor: safe(savingsGeneral, 'general savings balance'),
      goals,
      deficitMinor: safe(free < 0n ? -free : 0n, 'deficit'),
      currentPeriod: {
        id: period.id, userId: period.user_id, startsAt: period.starts_at,
        endsAtExclusive: period.ends_at_exclusive, endsOnLocal: period.ends_on_local,
        timezone: period.timezone, status: period.status, closedAt: period.closed_at,
        createdAt: period.created_at,
      },
      pendingSettlementOffers: offerRows.map((offer) => ({
        id: offer.id, userId: offer.user_id, periodId: offer.period_id,
        offeredAmountMinor: safe(BigInt(offer.offered_amount_minor), 'offered amount'),
        acceptedAmountMinor: offer.accepted_amount_minor === null
          ? null : safe(BigInt(offer.accepted_amount_minor), 'accepted amount'),
        status: offer.status, acceptedAt: offer.accepted_at,
        transferTransactionId: offer.transfer_transaction_id, createdAt: offer.created_at,
      })),
    };
  }
}

function validate(userId: unknown, now: unknown): asserts userId is string {
  if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) {
    throw new BadRequestException('userId must be a valid UUID');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new BadRequestException('now must be a valid Date');
  }
}

function safe(value: bigint, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Stored ${label} exceeds the safe integer range`);
  return parsed;
}
