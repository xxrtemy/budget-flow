import { Controller, Get, Query } from '@nestjs/common';

import { CurrentUserId } from './current-user.decorator';
import { CurrentUserPipe } from './current-user.pipe';
import { EmptyDto, PaginationDto } from './dto/pagination.dto';
import { PeriodQueryService } from './period-query.service';

@Controller('finance/periods')
export class PeriodController {
  constructor(private readonly periods: PeriodQueryService) {}

  @Get('current')
  current(@CurrentUserId(CurrentUserPipe) userId: string, @Query() _query: EmptyDto) {
    return this.periods.current(userId);
  }

  @Get()
  list(@CurrentUserId(CurrentUserPipe) userId: string, @Query() query: PaginationDto) {
    return this.periods.list(userId, query.cursor);
  }
}
