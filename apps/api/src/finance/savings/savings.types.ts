import type { LedgerTransaction } from '../ledger/ledger.types';

export type SavingsEndpoint =
  | { type: 'FREE' }
  | { type: 'GENERAL' }
  | { type: 'GOAL'; goalId: string };

export interface SavingsGoal {
  id: string;
  userId: string;
  name: string;
  targetMinor: number | null;
  balanceMinor: number;
  createdAt: Date;
}

export interface CreateSavingsGoalInput {
  name: string;
  targetMinor?: number;
}

export interface UpdateSavingsGoalInput {
  name?: string;
  targetMinor?: number | null;
}

export interface SavingsTransferInput {
  userId: string;
  from: SavingsEndpoint;
  to: SavingsEndpoint;
  amountMinor: number;
  effectiveAt: Date;
}

export type SavingsTransfer = LedgerTransaction;
