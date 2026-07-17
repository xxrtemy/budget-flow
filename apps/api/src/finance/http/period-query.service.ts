import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';

import { DATABASE } from '../../database/database.constants';
import type { Database } from '../../database/database.types';
import type { CalculationPeriod } from '../profile/profile.types';
import { decodeListCursor, encodeListCursor, listCursorTimestamp } from '../shared/list-cursor';

const PAGE_SIZE = 50;

@Injectable()
export class PeriodQueryService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async list(userId: string, cursor?: string): Promise<{ items: CalculationPeriod[]; nextCursor: string | null }> {
    const decoded = cursor ? decodeListCursor(cursor) : undefined;
    let query = this.db.selectFrom('calculation_periods').selectAll()
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
      items: page.map(toPeriod),
      nextCursor: rows.length > PAGE_SIZE && last
        ? encodeListCursor({ createdAtMicros: last.cursor_created_at_micros, id: last.id })
        : null,
    };
  }

  async current(userId: string): Promise<CalculationPeriod> {
    const row = await this.db.selectFrom('calculation_periods').selectAll()
      .where('user_id', '=', userId).where('status', '=', 'OPEN')
      .orderBy('starts_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
    if (!row) throw new NotFoundException('Current calculation period not found');
    return toPeriod(row);
  }
}

function toPeriod(row: {
  id: string; user_id: string; starts_at: Date; ends_at_exclusive: Date;
  ends_on_local: string; timezone: string; status: 'OPEN' | 'CLOSED';
  closed_at: Date | null; created_at: Date;
}): CalculationPeriod {
  return {
    id: row.id, userId: row.user_id, startsAt: row.starts_at,
    endsAtExclusive: row.ends_at_exclusive, endsOnLocal: row.ends_on_local,
    timezone: row.timezone, status: row.status, closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}
