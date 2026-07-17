import { NotFoundException } from '@nestjs/common';
import type { Selectable, Transaction } from 'kysely';

import type {
  BudgetPlansTable,
  Database,
} from '../../database/database.types';
import { AccountRepository } from '../ledger/account.repository';
import { LedgerService } from '../ledger/ledger.service';

export type LockedBudgetPlan = Selectable<BudgetPlansTable>;

/**
 * Task 4 lock order is: calculation period (reconcile only), category UUIDs,
 * budget-plan UUIDs, then financial-account UUIDs. Every lifecycle operation
 * uses the applicable suffix of this order, so reconcile, update, archive,
 * category archive, plan creation and expenses cannot form a lock cycle.
 */
export async function lockActiveCategory(
  userId: string,
  categoryId: string,
  trx: Transaction<Database>,
): Promise<void> {
  const category = await trx.selectFrom('categories')
    .select('id')
    .where('user_id', '=', userId)
    .where('id', '=', categoryId)
    .where('archived_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!category) {
    throw new NotFoundException('Category not found');
  }
}

export async function lockActiveBudgetPlan(
  userId: string,
  planId: string,
  trx: Transaction<Database>,
): Promise<LockedBudgetPlan> {
  const identity = await trx.selectFrom('budget_plans')
    .select('category_id')
    .where('user_id', '=', userId)
    .where('id', '=', planId)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (!identity) {
    throw new NotFoundException('Budget plan not found');
  }
  await lockActiveCategory(userId, identity.category_id, trx);
  const plan = await trx.selectFrom('budget_plans')
    .selectAll()
    .where('user_id', '=', userId)
    .where('id', '=', planId)
    .where('category_id', '=', identity.category_id)
    .where('archived_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!plan) {
    throw new NotFoundException('Budget plan not found');
  }
  return plan;
}

export async function lockActiveCategoryPlans(
  userId: string,
  categoryId: string,
  trx: Transaction<Database>,
): Promise<LockedBudgetPlan[]> {
  await lockActiveCategory(userId, categoryId, trx);
  return trx.selectFrom('budget_plans')
    .selectAll()
    .where('user_id', '=', userId)
    .where('category_id', '=', categoryId)
    .where('archived_at', 'is', null)
    .orderBy('id')
    .forUpdate()
    .execute();
}

export async function lockAllActiveBudgetPlans(
  userId: string,
  trx: Transaction<Database>,
): Promise<LockedBudgetPlan[]> {
  await trx.selectFrom('categories')
    .select('id')
    .where('user_id', '=', userId)
    .where('archived_at', 'is', null)
    .orderBy('id')
    .forUpdate()
    .execute();
  return trx.selectFrom('budget_plans')
    .innerJoin('categories', (join) => join
      .onRef('categories.id', '=', 'budget_plans.category_id')
      .onRef('categories.user_id', '=', 'budget_plans.user_id'))
    .selectAll('budget_plans')
    .where('budget_plans.user_id', '=', userId)
    .where('budget_plans.archived_at', 'is', null)
    .where('categories.archived_at', 'is', null)
    .orderBy('budget_plans.id')
    .forUpdate('budget_plans')
    .execute();
}

export async function releaseAndArchiveBudgetPlans(
  userId: string,
  plans: readonly LockedBudgetPlan[],
  archivedAt: Date,
  trx: Transaction<Database>,
): Promise<void> {
  if (plans.length === 0) {
    return;
  }
  const planIds = plans.map(({ id }) => id);
  const reserveAccounts = await trx.selectFrom('financial_accounts')
    .select(['id', 'reference_id'])
    .where('user_id', '=', userId)
    .where('kind', '=', 'BUDGET_RESERVE')
    .where('reference_id', 'in', planIds)
    .where('archived_at', 'is', null)
    .orderBy('id')
    .execute();
  if (reserveAccounts.length !== plans.length) {
    throw new NotFoundException('Budget reserve account not found');
  }
  const freeAccount = await trx.selectFrom('financial_accounts')
    .select('id')
    .where('user_id', '=', userId)
    .where('kind', '=', 'FREE')
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (!freeAccount) {
    throw new NotFoundException('Financial profile not found');
  }
  const accounts = new AccountRepository(trx);
  const lockedAccounts = await accounts.lockAccounts(
    userId,
    [freeAccount.id, ...reserveAccounts.map(({ id }) => id)],
    trx,
  );
  const balanceById = new Map(lockedAccounts.map(({ id, balanceMinor }) => [id, balanceMinor]));
  const reserveByPlan = new Map(reserveAccounts.map(({ id, reference_id }) => [reference_id!, id]));
  const ledger = new LedgerService(trx);
  for (const plan of plans) {
    const reserveAccountId = reserveByPlan.get(plan.id);
    if (!reserveAccountId) {
      throw new NotFoundException('Budget reserve account not found');
    }
    const balanceMinor = balanceById.get(reserveAccountId) ?? 0;
    if (balanceMinor > 0) {
      await ledger.post({
        userId,
        type: 'BUDGET_RELEASE',
        effectiveAt: archivedAt,
        metadata: { budgetPlanId: plan.id },
        postings: [
          { accountId: reserveAccountId, amountMinor: -balanceMinor },
          { accountId: freeAccount.id, amountMinor: balanceMinor },
        ],
      }, trx);
    }
  }
  await trx.updateTable('financial_accounts')
    .set({ archived_at: archivedAt })
    .where('user_id', '=', userId)
    .where('id', 'in', reserveAccounts.map(({ id }) => id))
    .execute();
  await trx.updateTable('budget_plans')
    .set({ archived_at: archivedAt, updated_at: archivedAt })
    .where('user_id', '=', userId)
    .where('id', 'in', planIds)
    .execute();
}
