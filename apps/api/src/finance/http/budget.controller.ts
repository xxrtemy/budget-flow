import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { BudgetService } from '../budgets/budget.service';
import { FINANCE_CLOCK, type FinanceClock } from '../finance.constants';
import { CurrentUserId } from './current-user.decorator';
import { CurrentUserPipe } from './current-user.pipe';
import { CreateBudgetDto, UpdateBudgetDto } from './dto/budget.dto';
import { EmptyDto, PaginationDto } from './dto/pagination.dto';
import { Idempotent } from './idempotent.decorator';

const UUID = new ParseUUIDPipe();

@Controller('finance/budgets')
export class BudgetController {
  constructor(
    private readonly budgets: BudgetService,
    @Inject(FINANCE_CLOCK) private readonly clock: FinanceClock,
  ) {}

  @Post() @Idempotent()
  create(@CurrentUserId(CurrentUserPipe) userId: string, @Body() dto: CreateBudgetDto,
    @Query() _query: EmptyDto) {
    return this.budgets.create({ userId, ...dto });
  }

  @Get()
  list(@CurrentUserId(CurrentUserPipe) userId: string, @Query() query: PaginationDto) {
    return this.budgets.list(userId, query.cursor);
  }

  @Get(':id')
  get(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Query() _query: EmptyDto) {
    return this.budgets.get(userId, id);
  }

  @Patch(':id') @Idempotent()
  update(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Body() dto: UpdateBudgetDto, @Query() _query: EmptyDto) {
    return this.budgets.update(userId, id, dto, this.clock());
  }

  @Delete(':id') @HttpCode(204) @Idempotent()
  async archive(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Body() _body: EmptyDto, @Query() _query: EmptyDto) {
    await this.budgets.archive(userId, id);
  }
}
