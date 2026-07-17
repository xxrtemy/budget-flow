import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';

import { FINANCE_CLOCK, type FinanceClock } from '../finance.constants';
import { LedgerService } from '../ledger/ledger.service';
import { CurrentUserId } from './current-user.decorator';
import { CurrentUserPipe } from './current-user.pipe';
import { EmptyDto, PaginationDto } from './dto/pagination.dto';
import { Idempotent } from './idempotent.decorator';

const UUID = new ParseUUIDPipe();

@Controller('finance/ledger')
export class LedgerController {
  constructor(
    private readonly ledger: LedgerService,
    @Inject(FINANCE_CLOCK) private readonly clock: FinanceClock,
  ) {}

  @Get()
  list(@CurrentUserId(CurrentUserPipe) userId: string, @Query() query: PaginationDto) {
    return this.ledger.list(userId, query.cursor);
  }

  @Post(':transactionId/reverse') @Idempotent()
  reverse(@CurrentUserId(CurrentUserPipe) userId: string,
    @Param('transactionId', UUID) transactionId: string,
    @Body() _body: EmptyDto, @Query() _query: EmptyDto) {
    return this.ledger.reverse(userId, transactionId, this.clock());
  }
}
