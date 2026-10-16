alter table volt_core.cash_movements
  add column if not exists idempotency_key text,
  add column if not exists idempotency_fingerprint text;

create unique index if not exists uq_volt_core_receivable_settlement_idempotency
  on volt_core.cash_movements (company_id, source_id, idempotency_key)
  where source_type = 'receivable' and idempotency_key is not null;
