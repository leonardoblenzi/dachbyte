-- Volt Platform foundation: make sale creation safe to retry.
-- The key is scoped by company so clients/integrations can resend the same request
-- without duplicating stock, cash, receivables or optical production orders.
alter table volt_core.sales
  add column if not exists idempotency_key text,
  add column if not exists idempotency_fingerprint text;

create unique index if not exists ux_volt_core_sales_company_idempotency
  on volt_core.sales(company_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists idx_volt_core_audit_company_created
  on volt_core.audit_logs(company_id, created_at desc);

create index if not exists idx_volt_core_events_company_created
  on volt_core.events(company_id, created_at desc);
