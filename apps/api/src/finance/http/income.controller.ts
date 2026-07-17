import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { IncomeService } from '../income/income.service';
import { CurrentUserId } from './current-user.decorator';
import { CurrentUserPipe } from './current-user.pipe';
import { CreateIncomeDto } from './dto/income.dto';
import { CreateIncomeScheduleDto, UpdateIncomeScheduleDto } from './dto/income-schedule.dto';
import { EmptyDto, PaginationDto } from './dto/pagination.dto';
import { Idempotent } from './idempotent.decorator';

const UUID = new ParseUUIDPipe();

@Controller('finance')
export class IncomeController {
  constructor(private readonly incomes: IncomeService) {}

  @Post('incomes') @Idempotent()
  createIncome(@CurrentUserId(CurrentUserPipe) userId: string, @Body() dto: CreateIncomeDto,
    @Query() _query: EmptyDto) {
    return this.incomes.createOneOff({ userId, ...dto, effectiveAt: new Date(dto.effectiveAt) });
  }

  @Get('incomes')
  listIncomes(@CurrentUserId(CurrentUserPipe) userId: string, @Query() query: PaginationDto) {
    return this.incomes.listOneOff(userId, query.cursor);
  }

  @Post('income-schedules')
  createSchedule(@CurrentUserId(CurrentUserPipe) userId: string, @Body() dto: CreateIncomeScheduleDto,
    @Query() _query: EmptyDto) {
    return this.incomes.createSchedule({ userId, ...dto });
  }

  @Get('income-schedules')
  listSchedules(@CurrentUserId(CurrentUserPipe) userId: string, @Query() query: PaginationDto) {
    return this.incomes.listSchedules(userId, query.cursor);
  }

  @Get('income-schedules/:id')
  getSchedule(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Query() _query: EmptyDto) {
    return this.incomes.getSchedule(userId, id);
  }

  @Patch('income-schedules/:id') @Idempotent()
  updateSchedule(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Body() dto: UpdateIncomeScheduleDto, @Query() _query: EmptyDto) {
    return this.incomes.updateSchedule(userId, id, dto);
  }

  @Delete('income-schedules/:id') @HttpCode(204) @Idempotent()
  async deleteSchedule(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Body() _body: EmptyDto, @Query() _query: EmptyDto) {
    await this.incomes.archiveSchedule(userId, id);
  }
}
