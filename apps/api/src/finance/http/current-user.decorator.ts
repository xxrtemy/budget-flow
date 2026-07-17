import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): unknown =>
    context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>()
      .headers['x-user-id'],
);
