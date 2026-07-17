import { randomUUID } from 'node:crypto';

import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';

import { DATABASE } from '../../database/database.constants';
import type { Database, JsonValue } from '../../database/database.types';

export interface IdempotentRequest {
  userId: string;
  key: string;
  route: string;
  payloadHash: string;
}

export interface HttpResult<T> {
  status: number;
  body: T;
  replayed?: boolean;
}

@Injectable()
export class IdempotencyService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async execute<T>(
    request: IdempotentRequest,
    work: () => Promise<HttpResult<T>>,
    canRetryStale = true,
  ): Promise<HttpResult<T>> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await trx.insertInto('idempotency_records').values({
          id: randomUUID(),
          user_id: request.userId,
          idempotency_key: request.key,
          route: request.route,
          payload_hash: request.payloadHash,
          state: 'PROCESSING',
          response_status: null,
          response_body: null,
        }).execute();

        const result = await work();
        const body = jsonValue(result.body);
        await trx.updateTable('idempotency_records').set({
          state: 'COMPLETED',
          response_status: result.status,
          response_body: body,
          updated_at: new Date(),
        }).where('user_id', '=', request.userId)
          .where('idempotency_key', '=', request.key)
          .where('state', '=', 'PROCESSING')
          .executeTakeFirstOrThrow();
        return result;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.db.selectFrom('idempotency_records').selectAll()
        .where('user_id', '=', request.userId)
        .where('idempotency_key', '=', request.key)
        .executeTakeFirst();
      if (!existing) {
        if (canRetryStale) return this.execute(request, work, false);
        throw new ConflictException('Idempotency request could not be resolved');
      }
      if (existing.route !== request.route || existing.payload_hash !== request.payloadHash) {
        throw new ConflictException('Idempotency-Key was already used for another request');
      }
      if (existing.state === 'COMPLETED' && existing.response_status !== null) {
        return {
          status: existing.response_status,
          body: existing.response_body as T,
          replayed: true,
        };
      }

      const staleBefore = new Date(Date.now() - 5 * 60_000);
      const deleted = await this.db.deleteFrom('idempotency_records')
        .where('user_id', '=', request.userId)
        .where('idempotency_key', '=', request.key)
        .where('state', '=', 'PROCESSING')
        .where('updated_at', '<', staleBefore)
        .executeTakeFirst();
      if (canRetryStale && deleted.numDeletedRows === 1n) {
        return this.execute(request, work, false);
      }
      throw new ConflictException('Idempotency request is still processing');
    }
  }
}

function jsonValue(value: unknown): JsonValue | null {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: unknown }).code === '23505';
}
