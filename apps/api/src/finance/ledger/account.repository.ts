import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';

import { DATABASE } from '../../database/database.constants';
import type { AccountKind, Database } from '../../database/database.types';
import type { LockedAccount } from './ledger.types';

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

export interface AccountIdentity {
  id: string;
  kind: AccountKind;
}

@Injectable()
export class AccountRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async findByKinds(
    userId: string,
    kinds: readonly AccountKind[],
    executor: DatabaseExecutor = this.db,
  ): Promise<AccountIdentity[]> {
    if (kinds.length === 0) {
      return [];
    }

    return executor
      .selectFrom('financial_accounts')
      .select(['id', 'kind'])
      .where('user_id', '=', userId)
      .where('kind', 'in', [...kinds])
      .execute();
  }

  async findByIds(
    userId: string,
    accountIds: readonly string[],
    executor: DatabaseExecutor = this.db,
  ): Promise<AccountIdentity[]> {
    const uniqueIds = uniqueSortedIds(accountIds);
    if (uniqueIds.length === 0) {
      return [];
    }

    return executor
      .selectFrom('financial_accounts')
      .select(['id', 'kind'])
      .where('user_id', '=', userId)
      .where('id', 'in', uniqueIds)
      .orderBy('id')
      .execute();
  }

  async getBalance(
    userId: string,
    accountId: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<number | undefined> {
    const account = await executor
      .selectFrom('financial_accounts')
      .select('id')
      .where('user_id', '=', userId)
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!account) {
      return undefined;
    }

    const row = await executor
      .selectFrom('ledger_postings')
      .select(sql<string>`coalesce(sum(amount_minor), 0)`.as('balance_minor'))
      .where('user_id', '=', userId)
      .where('account_id', '=', accountId)
      .executeTakeFirstOrThrow();
    return parseDatabaseMoney(row.balance_minor);
  }

  async lockAccounts(
    userId: string,
    accountIds: readonly string[],
    trx: Transaction<Database>,
  ): Promise<LockedAccount[]> {
    const uniqueIds = uniqueSortedIds(accountIds);
    if (uniqueIds.length === 0) {
      return [];
    }

    const accounts = await trx
      .selectFrom('financial_accounts')
      .select(['id', 'user_id'])
      .where('user_id', '=', userId)
      .where('id', 'in', uniqueIds)
      .orderBy('id')
      .forUpdate()
      .execute();
    if (accounts.length !== uniqueIds.length) {
      throw new NotFoundException('Financial account not found');
    }

    const balances = await trx
      .selectFrom('ledger_postings')
      .select([
        'account_id',
        sql<string>`sum(amount_minor)`.as('balance_minor'),
      ])
      .where('user_id', '=', userId)
      .where('account_id', 'in', uniqueIds)
      .groupBy('account_id')
      .execute();
    const balanceByAccount = new Map(
      balances.map(({ account_id, balance_minor }) => [
        account_id,
        parseDatabaseMoney(balance_minor),
      ]),
    );

    return accounts.map((account) => ({
      id: account.id,
      userId: account.user_id,
      balanceMinor: balanceByAccount.get(account.id) ?? 0,
    }));
  }
}

function uniqueSortedIds(accountIds: readonly string[]): string[] {
  return [...new Set(accountIds)].sort();
}

function parseDatabaseMoney(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('Stored balance exceeds the safe integer range');
  }
  return parsed;
}
