-- Cash-session schema hardening for databases created from older revisions of
-- 001_initial_schema.sql. CREATE TABLE IF NOT EXISTS does not backfill columns
-- added later to that file, so make the runtime contract explicit here.

alter table volt_core.cash_sessions
  add column if not exists status text not null default 'open',
  add column if not exists opening_amount numeric(14,2) not null default 0,
  add column if not exists expected_amount numeric(14,2) not null default 0,
  add column if not exists counted_amount numeric(14,2),
  add column if not exists difference_amount numeric(14,2),
  add column if not exists opened_by text,
  add column if not exists closed_by text,
  add column if not exists opened_at timestamptz not null default now(),
  add column if not exists closed_at timestamptz,
  add column if not exists notes text;

update volt_core.cash_sessions
   set expected_amount = coalesce(expected_amount, opening_amount, 0)
 where expected_amount is null;

alter table volt_core.cash_movements
  add column if not exists operational_at timestamptz;

update volt_core.cash_movements
   set operational_at = created_at
 where operational_at is null;

alter table volt_core.cash_movements
  alter column operational_at set default now();

alter table volt_core.cash_movements
  alter column operational_at set not null;

create index if not exists idx_volt_core_cash_sessions_company_status
  on volt_core.cash_sessions(company_id, status, opened_at desc);

create index if not exists idx_volt_core_cash_movements_company_operational
  on volt_core.cash_movements(company_id, operational_at desc);
