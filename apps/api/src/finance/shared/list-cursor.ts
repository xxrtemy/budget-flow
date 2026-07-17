import { BadRequestException } from '@nestjs/common';
import { sql } from 'kysely';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_MICROS_PATTERN = /^[1-9][0-9]{0,15}$/;
const MAX_CURSOR_MICROS = BigInt(Number.MAX_SAFE_INTEGER);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ListCursor {
  createdAtMicros: string;
  id: string;
}

export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeListCursor(cursor: string): ListCursor {
  try {
    if (!BASE64URL_PATTERN.test(cursor)) {
      throw new Error('Invalid base64url');
    }
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      createdAtMicros?: unknown;
      id?: unknown;
    };
    if (typeof value.createdAtMicros !== 'string'
      || !CURSOR_MICROS_PATTERN.test(value.createdAtMicros)
      || BigInt(value.createdAtMicros) > MAX_CURSOR_MICROS
      || typeof value.id !== 'string'
      || !UUID_PATTERN.test(value.id)) {
      throw new Error('Invalid cursor payload');
    }
    const decoded = { createdAtMicros: value.createdAtMicros, id: value.id };
    if (encodeListCursor(decoded) !== cursor) {
      throw new Error('Non-canonical cursor');
    }
    return decoded;
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

export function listCursorTimestamp(value: string) {
  const micros = BigInt(value);
  return sql<Date>`
    timestamptz 'epoch'
    + ${(micros / 1_000_000n).toString()}::bigint * interval '1 second'
    + ${(micros % 1_000_000n).toString()}::integer * interval '1 microsecond'
  `;
}
