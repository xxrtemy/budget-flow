import { createHash } from 'node:crypto';

import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUUID } from 'class-validator';
import { from, lastValueFrom, map, type Observable } from 'rxjs';

import { IDEMPOTENT_METADATA } from './idempotent.decorator';
import { IdempotencyService } from './idempotency.service';
import { validateUserIdHeader } from './current-user.pipe';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_METADATA, [
      context.getHandler(), context.getClass(),
    ]);
    if (!required) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const userId = validateUserIdHeader(request.headers['x-user-id']);
    if (Object.values(request.params).some((value) => !isUUID(value, 'all'))) {
      throw new BadRequestException('Path parameters must be valid UUIDs');
    }
    const key = idempotencyKey(request);
    const route = `${request.method.toUpperCase()} ${request.baseUrl}${request.route.path}`;
    const payloadHash = createHash('sha256').update(stableJson({
      method: request.method.toUpperCase(),
      route,
      body: request.body ?? null,
      params: request.params ?? {},
      query: request.query ?? {},
    })).digest('hex');

    return from(this.idempotency.execute({ userId, key, route, payloadHash }, async () => ({
      status: response.statusCode,
      body: await lastValueFrom(next.handle()),
    }))).pipe(map((result) => {
      response.status(result.status);
      return result.body;
    }));
  }
}

interface HttpRequest {
  method: string;
  baseUrl: string;
  route: { path: string };
  body?: unknown;
  params: Record<string, string>;
  query?: unknown;
  rawHeaders: string[];
  headers: Record<string, string | string[] | undefined>;
}

interface HttpResponse {
  statusCode: number;
  status(code: number): unknown;
}

function idempotencyKey(request: HttpRequest): string {
  const repeated = request.rawHeaders.filter((value, index) =>
    index % 2 === 0 && value.toLowerCase() === 'idempotency-key').length;
  const value = request.headers['idempotency-key'];
  if (repeated !== 1 || typeof value !== 'string' || value.trim().length === 0
    || value.length > 200) {
    throw new BadRequestException('Idempotency-Key must be one non-empty scalar up to 200 chars');
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]));
  }
  return value;
}
