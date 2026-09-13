-- Backfill a column omitted when legacy payment_methods tables predated
-- runtime hardening and CREATE TABLE IF NOT EXISTS could not evolve them.
alter table volt_core.payment_methods
  add column if not exists metadata jsonb not null default '{}'::jsonb;
