import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { FINANCE_CLOCK, type FinanceClock } from '../finance.constants';
import { ObligationService } from '../obligations/obligation.service';
import { CurrentUserId } from './current-user.decorator';
import { CurrentUserPipe } from './current-user.pipe';
import { CreateObligationDto, UpdateObligationDto } from './dto/obligation.dto';
import { EmptyDto, PaginationDto } from './dto/pagination.dto';
import { Idempotent } from './idempotent.decorator';

const UUID = new ParseUUIDPipe();

@Controller('finance/obligations')
export class ObligationController {
  constructor(
    private readonly obligations: ObligationService,
    @Inject(FINANCE_CLOCK) private readonly clock: FinanceClock,
  ) {}

  @Post() @Idempotent()
  create(@CurrentUserId(CurrentUserPipe) userId: string, @Body() dto: CreateObligationDto,
    @Query() _query: EmptyDto) {
    return this.obligations.create({ userId, ...dto });
  }

  @Get()
  list(@CurrentUserId(CurrentUserPipe) userId: string, @Query() query: PaginationDto) {
    return this.obligations.list(userId, query.cursor);
  }

  @Get(':id')
  get(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Query() _query: EmptyDto) {
    return this.obligations.get(userId, id);
  }

  @Patch(':id') @Idempotent()
  update(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Body() dto: UpdateObligationDto, @Query() _query: EmptyDto) {
    return this.obligations.updateFuture(userId, id, dto);
  }

  @Get(':id/occurrences')
  occurrences(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Query() query: PaginationDto) {
    return this.obligations.listOccurrences(userId, id, query.cursor);
  }

  @Post('occurrences/:id/cancel') @Idempotent()
  cancel(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Body() _body: EmptyDto, @Query() _query: EmptyDto) {
    return this.obligations.cancelOccurrence(userId, id, this.clock());
  }
}
