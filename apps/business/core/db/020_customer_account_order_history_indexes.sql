-- Customer account + complete order history read paths.
-- Additive/index-only migration; no data rewrite.

create index if not exists idx_volt_core_cash_movements_company_source
  on volt_core.cash_movements (company_id, source_type, source_id, operational_at desc, created_at desc);

create index if not exists idx_volt_core_receivables_company_sale
  on volt_core.receivables (company_id, sale_id, due_date, created_at);

create index if not exists idx_volt_core_receipts_company_sale
  on volt_core.receipts (company_id, sale_id, created_at);

create index if not exists idx_volt_core_inventory_company_source
  on volt_core.inventory_movements (company_id, source_type, source_id, created_at);

create index if not exists idx_volt_core_audit_logs_company_entity
  on volt_core.audit_logs (company_id, entity_type, entity_id, created_at);

create index if not exists idx_volt_core_audit_logs_company_sale_metadata
  on volt_core.audit_logs (company_id, ((metadata ->> 'saleId')), created_at)
  where metadata ? 'saleId';

create index if not exists idx_volt_core_workflow_events_company_sale_metadata
  on volt_core.workflow_events (company_id, ((metadata ->> 'saleId')), created_at)
  where metadata ? 'saleId';
