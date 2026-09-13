alter table volt_core.sales
  add column if not exists payment_timing text not null default 'immediate',
  add column if not exists promised_delivery_date date,
  add column if not exists delivered_at timestamptz;

create index if not exists idx_volt_core_sales_company_delivery
  on volt_core.sales (company_id, status, promised_delivery_date, created_at desc);
