import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { CategoryService } from '../expenses/category.service';
import { ExpenseService } from '../expenses/expense.service';
import { CurrentUserId } from './current-user.decorator';
import { CurrentUserPipe } from './current-user.pipe';
import { CategoryDto } from './dto/category.dto';
import { CreateExpenseDto } from './dto/expense.dto';
import { EmptyDto, PaginationDto } from './dto/pagination.dto';
import { Idempotent } from './idempotent.decorator';

const UUID = new ParseUUIDPipe();

@Controller('finance')
export class ExpenseController {
  constructor(private readonly categories: CategoryService, private readonly expenses: ExpenseService) {}

  @Post('expenses') @Idempotent()
  createExpense(@CurrentUserId(CurrentUserPipe) userId: string, @Body() dto: CreateExpenseDto,
    @Query() _query: EmptyDto) {
    return this.expenses.create({ userId, ...dto, occurredAt: new Date(dto.occurredAt) });
  }

  @Get('expenses')
  listExpenses(@CurrentUserId(CurrentUserPipe) userId: string, @Query() query: PaginationDto) {
    return this.expenses.list(userId, query.cursor);
  }

  @Post('categories')
  createCategory(@CurrentUserId(CurrentUserPipe) userId: string, @Body() dto: CategoryDto,
    @Query() _query: EmptyDto) {
    return this.categories.create(userId, dto.name);
  }

  @Get('categories')
  listCategories(@CurrentUserId(CurrentUserPipe) userId: string, @Query() query: PaginationDto) {
    return this.categories.list(userId, query.cursor);
  }

  @Patch('categories/:id')
  updateCategory(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Body() dto: CategoryDto, @Query() _query: EmptyDto) {
    return this.categories.update(userId, id, dto.name);
  }

  @Delete('categories/:id') @HttpCode(204)
  async deleteCategory(@CurrentUserId(CurrentUserPipe) userId: string, @Param('id', UUID) id: string,
    @Body() _body: EmptyDto, @Query() _query: EmptyDto) {
    await this.categories.archive(userId, id);
  }
}
