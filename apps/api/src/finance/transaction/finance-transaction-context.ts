import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';

import type { Database } from '../../database/database.types';

@Injectable()
export class FinanceTransactionContext {
  private readonly storage = new AsyncLocalStorage<Transaction<Database>>();

  current(): Transaction<Database> | undefined {
    return this.storage.getStore();
  }

  run<T>(transaction: Transaction<Database>, work: () => Promise<T>): Promise<T> {
    return this.storage.run(transaction, work);
  }

  inTransaction<T>(
    db: Kysely<Database>,
    work: (transaction: Transaction<Database>) => Promise<T>,
  ): Promise<T> {
    const current = this.current();
    if (current) return work(current);
    return this.startTransaction(db, work);
  }

  startTransaction<T>(
    db: Kysely<Database>,
    work: (transaction: Transaction<Database>) => Promise<T>,
  ): Promise<T> {
    return db.transaction().execute((transaction) =>
      this.run(transaction, () => work(transaction)));
  }
}
