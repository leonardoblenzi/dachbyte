alter table volt_core.sales
  add column if not exists sold_at timestamptz;

update volt_core.sales
   set sold_at = created_at
 where sold_at is null;

alter table volt_core.sales
  alter column sold_at set default now();

alter table volt_core.sales
  alter column sold_at set not null;

alter table volt_core.cash_movements
  add column if not exists operational_at timestamptz;

update volt_core.cash_movements
   set operational_at = created_at
 where operational_at is null;

alter table volt_core.cash_movements
  alter column operational_at set default now();

alter table volt_core.cash_movements
  alter column operational_at set not null;

create index if not exists idx_volt_core_sales_company_sold_at
  on volt_core.sales(company_id, sold_at desc);

create index if not exists idx_volt_core_cash_movements_company_operational
  on volt_core.cash_movements(company_id, operational_at desc);
