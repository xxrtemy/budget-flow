import { Body, Controller, Get, Inject, NotFoundException, Post, Put, Query } from '@nestjs/common';

import { BalanceService } from '../balance/balance.service';
import { LedgerService } from '../ledger/ledger.service';
import { ProfileService } from '../profile/profile.service';
import { FINANCE_CLOCK, type FinanceClock } from '../finance.constants';
import { CurrentUserId } from './current-user.decorator';
import { CurrentUserPipe } from './current-user.pipe';
import { Idempotent } from './idempotent.decorator';
import { OpeningBalanceDto } from './dto/opening-balance.dto';
import { UpsertProfileDto } from './dto/profile.dto';
import { EmptyDto } from './dto/pagination.dto';

@Controller('finance')
export class ProfileController {
  constructor(
    private readonly profiles: ProfileService,
    private readonly ledger: LedgerService,
    private readonly balance: BalanceService,
    @Inject(FINANCE_CLOCK) private readonly clock: FinanceClock,
  ) {}

  @Get('profile')
  async getProfile(@CurrentUserId(CurrentUserPipe) userId: string, @Query() _query: EmptyDto) {
    const profile = await this.profiles.get(userId);
    if (!profile) throw new NotFoundException('Financial profile not found');
    return profile;
  }

  @Put('profile')
  upsertProfile(
    @CurrentUserId(CurrentUserPipe) userId: string,
    @Body() dto: UpsertProfileDto,
    @Query() _query: EmptyDto,
  ) {
    return this.profiles.upsert({ userId, ...dto });
  }

  @Post('opening-balance')
  @Idempotent()
  openingBalance(
    @CurrentUserId(CurrentUserPipe) userId: string,
    @Body() dto: OpeningBalanceDto,
    @Query() _query: EmptyDto,
  ) {
    return this.ledger.createOpeningBalance(userId, dto.amountMinor, new Date(dto.effectiveAt));
  }

  @Get('balance')
  getBalance(@CurrentUserId(CurrentUserPipe) userId: string, @Query() _query: EmptyDto) {
    return this.balance.get(userId, this.clock());
  }
}
