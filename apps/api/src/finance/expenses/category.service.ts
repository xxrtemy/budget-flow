import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';

import { DATABASE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';

const PAGE_SIZE = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Category {
  id: string;
  userId: string;
  name: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface CategoryCursor {
  createdAtMicros: string;
  id: string;
}

@Injectable()
export class CategoryService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async create(userId: string, name: string): Promise<Category> {
    const normalizedName = validateName(name);
    const row = await this.db.insertInto('categories').values({
      id: randomUUID(),
      user_id: userId,
      name: normalizedName,
      archived_at: null,
    }).returningAll().executeTakeFirstOrThrow();
    return toCategory(row);
  }

  async list(userId: string, cursor?: string): Promise<{
    items: Category[];
    nextCursor: string | null;
  }> {
    const decoded = cursor ? decodeCursor(cursor) : undefined;
    let query = this.db.selectFrom('categories')
      .selectAll()
      .select(
        sql<string>`((extract(epoch from created_at) * 1000000)::bigint)::text`
          .as('cursor_created_at_micros'),
      )
      .where('user_id', '=', userId)
      .where('archived_at', 'is', null);
    if (decoded) {
      const createdAt = microsToTimestamp(decoded.createdAtMicros);
      query = query.where(({ and, eb, or }) => or([
        eb('created_at', '<', createdAt),
        and([
          eb('created_at', '=', createdAt),
          eb('id', '<', decoded.id),
        ]),
      ]));
    }
    const rows = await query.orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(PAGE_SIZE + 1)
      .execute();
    const pageRows = rows.slice(0, PAGE_SIZE);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toCategory),
      nextCursor: rows.length > PAGE_SIZE && last
        ? encodeCursor({
            createdAtMicros: last.cursor_created_at_micros,
            id: last.id,
          })
        : null,
    };
  }

  async update(userId: string, id: string, name: string): Promise<Category> {
    const row = await this.db.updateTable('categories')
      .set({ name: validateName(name), updated_at: new Date() })
      .where('user_id', '=', userId)
      .where('id', '=', id)
      .where('archived_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new NotFoundException('Category not found');
    }
    return toCategory(row);
  }

  async archive(userId: string, id: string): Promise<void> {
    const row = await this.db.updateTable('categories')
      .set({ archived_at: new Date(), updated_at: new Date() })
      .where('user_id', '=', userId)
      .where('id', '=', id)
      .where('archived_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!row) {
      throw new NotFoundException('Category not found');
    }
  }
}

function validateName(name: string): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new BadRequestException('name must be a non-empty string');
  }
  return name.trim();
}

function toCategory(row: {
  id: string;
  user_id: string;
  name: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): Category {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encodeCursor(cursor: CategoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(cursor: string): CategoryCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      createdAtMicros?: unknown;
      id?: unknown;
    };
    if (typeof value.createdAtMicros !== 'string'
      || !/^[1-9][0-9]{0,15}$/.test(value.createdAtMicros)
      || BigInt(value.createdAtMicros) > BigInt(Number.MAX_SAFE_INTEGER)
      || typeof value.id !== 'string'
      || !UUID_PATTERN.test(value.id)
      || encodeCursor({ createdAtMicros: value.createdAtMicros, id: value.id }) !== cursor) {
      throw new Error('Invalid cursor');
    }
    return { createdAtMicros: value.createdAtMicros, id: value.id };
  } catch {
    throw new BadRequestException('Invalid category cursor');
  }
}

function microsToTimestamp(value: string) {
  const micros = BigInt(value);
  return sql<Date>`
    timestamptz 'epoch'
    + ${(micros / 1_000_000n).toString()}::bigint * interval '1 second'
    + ${(micros % 1_000_000n).toString()}::integer * interval '1 microsecond'
  `;
}
