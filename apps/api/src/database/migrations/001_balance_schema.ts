import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table financial_profiles (
      user_id uuid primary key,
      currency text not null,
      timezone text not null,
      cadence text not null check (cadence in ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL')),
      next_period_ends_on date not null,
      cycle_anchor_day smallint not null check (cycle_anchor_day between 1 and 31),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table financial_accounts (
      id uuid primary key,
      user_id uuid not null,
      kind text not null check (kind in (
        'FREE', 'OBLIGATION_RESERVE', 'BUDGET_RESERVE', 'SAVINGS_GENERAL',
        'SAVINGS_GOAL', 'OPENING_EQUITY', 'INCOME_SOURCE', 'EXPENSE_SINK'
      )),
      reference_id uuid null,
      name text null,
      target_amount_minor bigint null check (target_amount_minor > 0),
      archived_at timestamptz null,
      created_at timestamptz not null default now()
    );

    create table ledger_transactions (
      id uuid primary key,
      user_id uuid not null,
      type text not null check (type in (
        'OPENING_BALANCE', 'INCOME', 'ORDINARY_EXPENSE', 'OBLIGATION_RESERVATION',
        'OBLIGATION_RELEASE', 'OBLIGATION_PAYMENT', 'BUDGET_RESERVATION',
        'BUDGET_RELEASE', 'SAVINGS_TRANSFER', 'SETTLEMENT_TRANSFER', 'REVERSAL'
      )),
      effective_at timestamptz not null,
      reversal_of uuid null references ledger_transactions(id),
      source_occurrence_id uuid null,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create table ledger_postings (
      id uuid primary key,
      transaction_id uuid not null references ledger_transactions(id),
      user_id uuid not null,
      account_id uuid not null references financial_accounts(id),
      amount_minor bigint not null check (amount_minor <> 0),
      created_at timestamptz not null default now()
    );

    create table calculation_periods (
      id uuid primary key,
      user_id uuid not null,
      starts_at timestamptz not null,
      ends_at_exclusive timestamptz not null,
      ends_on_local date not null,
      timezone text not null,
      status text not null check (status in ('OPEN', 'CLOSED')),
      closed_at timestamptz null,
      created_at timestamptz not null default now(),
      check (starts_at < ends_at_exclusive),
      check ((status = 'OPEN' and closed_at is null) or (status = 'CLOSED' and closed_at is not null))
    );

    create table categories (
      id uuid primary key,
      user_id uuid not null,
      name text not null,
      archived_at timestamptz null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table income_schedules (
      id uuid primary key,
      user_id uuid not null,
      name text not null,
      amount_minor bigint not null check (amount_minor > 0),
      starts_on date not null,
      cadence text not null check (cadence in ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL')),
      archived_at timestamptz null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table obligation_schedules (
      id uuid primary key,
      user_id uuid not null,
      name text not null,
      amount_minor bigint not null check (amount_minor > 0),
      starts_on date not null,
      cadence text not null check (cadence in ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table schedule_occurrences (
      id uuid primary key,
      user_id uuid not null,
      schedule_type text not null check (schedule_type in ('INCOME', 'OBLIGATION')),
      schedule_id uuid not null,
      due_at timestamptz not null,
      status text not null check (status in ('PENDING', 'RESERVED', 'APPLIED', 'CANCELLED')),
      reservation_transaction_id uuid null references ledger_transactions(id),
      applied_transaction_id uuid null references ledger_transactions(id),
      cancelled_at timestamptz null,
      created_at timestamptz not null default now(),
      check ((status = 'CANCELLED' and cancelled_at is not null) or (status <> 'CANCELLED' and cancelled_at is null))
    );

    alter table ledger_transactions
      add constraint ledger_transactions_source_occurrence_fk
      foreign key (source_occurrence_id) references schedule_occurrences(id);

    create table budget_plans (
      id uuid primary key,
      user_id uuid not null,
      category_id uuid not null references categories(id),
      amount_minor bigint not null check (amount_minor > 0),
      starts_on date not null,
      cadence text not null check (cadence in ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL')),
      archived_at timestamptz null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table budget_allocations (
      id uuid primary key,
      user_id uuid not null,
      budget_plan_id uuid not null references budget_plans(id),
      period_id uuid not null references calculation_periods(id),
      occurrence_on date not null,
      amount_minor bigint not null check (amount_minor > 0),
      reservation_transaction_id uuid not null references ledger_transactions(id),
      released_transaction_id uuid null references ledger_transactions(id),
      created_at timestamptz not null default now()
    );

    create table settlement_offers (
      id uuid primary key,
      user_id uuid not null,
      period_id uuid not null references calculation_periods(id),
      offered_amount_minor bigint not null check (offered_amount_minor > 0),
      accepted_amount_minor bigint null check (accepted_amount_minor > 0),
      status text not null check (status in ('PENDING', 'ACCEPTED')),
      accepted_at timestamptz null,
      transfer_transaction_id uuid null references ledger_transactions(id),
      created_at timestamptz not null default now(),
      check (accepted_amount_minor is null or accepted_amount_minor <= offered_amount_minor),
      check (
        (status = 'PENDING' and accepted_amount_minor is null and accepted_at is null and transfer_transaction_id is null)
        or
        (status = 'ACCEPTED' and accepted_amount_minor is not null and accepted_at is not null and transfer_transaction_id is not null)
      )
    );

    create table idempotency_records (
      id uuid primary key,
      user_id uuid not null,
      idempotency_key text not null,
      route text not null,
      payload_hash text not null,
      state text not null check (state in ('PROCESSING', 'COMPLETED')),
      response_status integer null check (response_status between 100 and 599),
      response_body jsonb null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (
        (state = 'PROCESSING' and response_status is null and response_body is null)
        or
        (state = 'COMPLETED' and response_status is not null)
      )
    );

    create index financial_profiles_user_id_idx on financial_profiles(user_id);
    create index financial_accounts_user_id_idx on financial_accounts(user_id);
    create index ledger_transactions_user_id_idx on ledger_transactions(user_id);
    create index ledger_postings_user_id_idx on ledger_postings(user_id);
    create index calculation_periods_user_id_idx on calculation_periods(user_id);
    create index categories_user_id_idx on categories(user_id);
    create index income_schedules_user_id_idx on income_schedules(user_id);
    create index obligation_schedules_user_id_idx on obligation_schedules(user_id);
    create index schedule_occurrences_user_id_idx on schedule_occurrences(user_id);
    create index budget_plans_user_id_idx on budget_plans(user_id);
    create index budget_allocations_user_id_idx on budget_allocations(user_id);
    create index settlement_offers_user_id_idx on settlement_offers(user_id);
    create index idempotency_records_user_id_idx on idempotency_records(user_id);

    create unique index financial_accounts_user_kind_reference_key
      on financial_accounts(user_id, kind, reference_id) nulls not distinct;
    create unique index ledger_transactions_user_reversal_key
      on ledger_transactions(user_id, reversal_of) where reversal_of is not null;
    create unique index schedule_occurrences_schedule_due_key
      on schedule_occurrences(user_id, schedule_type, schedule_id, due_at);
    create unique index budget_allocations_occurrence_key
      on budget_allocations(user_id, budget_plan_id, period_id, occurrence_on);
    create unique index settlement_offers_period_key
      on settlement_offers(user_id, period_id);
    create unique index idempotency_records_user_key
      on idempotency_records(user_id, idempotency_key);

    create function enforce_balanced_ledger_transaction() returns trigger as $$
    declare
      checked_transaction_id uuid;
      posting_sum bigint;
    begin
      if tg_table_name = 'ledger_transactions' then
        checked_transaction_id := new.id;
      elsif tg_op = 'DELETE' or tg_argv[0] = 'OLD' then
        checked_transaction_id := old.transaction_id;
      else
        checked_transaction_id := new.transaction_id;
      end if;

      if exists (select 1 from ledger_transactions where id = checked_transaction_id) then
        select sum(amount_minor) into posting_sum
        from ledger_postings
        where transaction_id = checked_transaction_id;

        if posting_sum is distinct from 0 then
          raise exception 'ledger transaction % is not balanced', checked_transaction_id
            using errcode = '23514';
        end if;
      end if;

      return null;
    end;
    $$ language plpgsql;

    create constraint trigger ledger_transactions_balanced
      after insert or update on ledger_transactions
      deferrable initially deferred
      for each row execute function enforce_balanced_ledger_transaction();

    create constraint trigger ledger_postings_balanced
      after insert or update or delete on ledger_postings
      deferrable initially deferred
      for each row execute function enforce_balanced_ledger_transaction();

    create constraint trigger ledger_postings_previous_transaction_balanced
      after update on ledger_postings
      deferrable initially deferred
      for each row execute function enforce_balanced_ledger_transaction('OLD');
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop trigger if exists ledger_postings_previous_transaction_balanced on ledger_postings;
    drop trigger if exists ledger_postings_balanced on ledger_postings;
    drop trigger if exists ledger_transactions_balanced on ledger_transactions;
    drop function if exists enforce_balanced_ledger_transaction();
    drop table if exists idempotency_records;
    drop table if exists settlement_offers;
    drop table if exists budget_allocations;
    drop table if exists budget_plans;
    alter table if exists ledger_transactions drop constraint if exists ledger_transactions_source_occurrence_fk;
    drop table if exists schedule_occurrences;
    drop table if exists obligation_schedules;
    drop table if exists income_schedules;
    drop table if exists categories;
    drop table if exists calculation_periods;
    drop table if exists ledger_postings;
    drop table if exists ledger_transactions;
    drop table if exists financial_accounts;
    drop table if exists financial_profiles;
  `.execute(db);
}
