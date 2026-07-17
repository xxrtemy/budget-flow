export const LEDGER_TRANSACTION_TYPES = [
  'OPENING_BALANCE',
  'INCOME',
  'ORDINARY_EXPENSE',
  'OBLIGATION_RESERVATION',
  'OBLIGATION_RELEASE',
  'OBLIGATION_PAYMENT',
  'BUDGET_RESERVATION',
  'BUDGET_RELEASE',
  'SAVINGS_TRANSFER',
  'SETTLEMENT_TRANSFER',
  'REVERSAL',
] as const;

export type LedgerTransactionType = (typeof LEDGER_TRANSACTION_TYPES)[number];

export interface LedgerPostingInput {
  accountId: string;
  amountMinor: number;
}

export interface PostLedgerInput {
  userId: string;
  type: LedgerTransactionType;
  effectiveAt: Date;
  postings: ReadonlyArray<LedgerPostingInput>;
  metadata?: Record<string, unknown>;
  sourceOccurrenceId?: string;
}

export interface LedgerPosting {
  id: string;
  transactionId: string;
  userId: string;
  accountId: string;
  amountMinor: number;
  createdAt: Date;
}

export interface LedgerTransaction {
  id: string;
  userId: string;
  type: LedgerTransactionType;
  effectiveAt: Date;
  reversalOf: string | null;
  sourceOccurrenceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  postings: LedgerPosting[];
}

export interface LockedAccount {
  id: string;
  userId: string;
  balanceMinor: number;
}
