alter table volt_core.sales
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by text;

create index if not exists idx_volt_core_sales_active_list
  on volt_core.sales (company_id, sold_at desc)
  where archived_at is null;
