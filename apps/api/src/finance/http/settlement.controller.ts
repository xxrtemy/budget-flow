import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';

import { FINANCE_CLOCK, type FinanceClock } from '../finance.constants';
import { SettlementService } from '../settlement/settlement.service';
import { CurrentUserId } from './current-user.decorator';
import { CurrentUserPipe } from './current-user.pipe';
import { EmptyDto, PaginationDto } from './dto/pagination.dto';
import { AcceptSettlementDto } from './dto/settlement.dto';
import { Idempotent } from './idempotent.decorator';

const UUID = new ParseUUIDPipe();

@Controller('finance/settlement-offers')
export class SettlementController {
  constructor(
    private readonly settlement: SettlementService,
    @Inject(FINANCE_CLOCK) private readonly clock: FinanceClock,
  ) {}

  @Get()
  list(@CurrentUserId(CurrentUserPipe) userId: string, @Query() query: PaginationDto) {
    return this.settlement.listOffers(userId, query.cursor);
  }

  @Post(':id/accept') @Idempotent()
  accept(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Body() dto: AcceptSettlementDto, @Query() _query: EmptyDto) {
    return this.settlement.acceptOffer({
      userId, offerId: id, amountMinor: dto.amountMinor, acceptedAt: this.clock(),
    });
  }
}
