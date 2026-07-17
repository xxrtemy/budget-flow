import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { SavingsService } from '../savings/savings.service';
import type { SavingsEndpoint } from '../savings/savings.types';
import { CurrentUserId } from './current-user.decorator';
import { CurrentUserPipe } from './current-user.pipe';
import { EmptyDto, PaginationDto } from './dto/pagination.dto';
import { CreateSavingsGoalDto, SavingsEndpointDto, SavingsTransferDto, UpdateSavingsGoalDto } from './dto/savings.dto';
import { Idempotent } from './idempotent.decorator';

const UUID = new ParseUUIDPipe();

@Controller('finance/savings')
export class SavingsController {
  constructor(private readonly savings: SavingsService) {}

  @Post('goals')
  createGoal(@CurrentUserId(CurrentUserPipe) userId: string, @Body() dto: CreateSavingsGoalDto,
    @Query() _query: EmptyDto) {
    return this.savings.createGoal(userId, dto);
  }

  @Get('goals')
  listGoals(@CurrentUserId(CurrentUserPipe) userId: string, @Query() query: PaginationDto) {
    return this.savings.listGoals(userId, query.cursor);
  }

  @Get('goals/:id')
  getGoal(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Query() _query: EmptyDto) {
    return this.savings.getGoal(userId, id);
  }

  @Patch('goals/:id')
  updateGoal(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Body() dto: UpdateSavingsGoalDto, @Query() _query: EmptyDto) {
    return this.savings.updateGoal(userId, id, dto);
  }

  @Delete('goals/:id') @HttpCode(204)
  async archiveGoal(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Body() _body: EmptyDto, @Query() _query: EmptyDto) {
    await this.savings.archiveGoal(userId, id);
  }

  @Post('transfers') @Idempotent()
  transfer(@CurrentUserId(CurrentUserPipe) userId: string, @Body() dto: SavingsTransferDto,
    @Query() _query: EmptyDto) {
    return this.savings.transfer({
      userId,
      from: endpoint(dto.from),
      to: endpoint(dto.to),
      amountMinor: dto.amountMinor,
      effectiveAt: new Date(dto.effectiveAt),
    });
  }
}

function endpoint(dto: SavingsEndpointDto): SavingsEndpoint {
  return dto.type === 'GOAL'
    ? { type: 'GOAL', goalId: dto.goalId ?? '' }
    : { type: dto.type };
}
