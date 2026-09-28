create table if not exists magalu.sku_costs (
  id bigserial primary key,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  sku text not null,
  unit_cost numeric(14,2) not null check (unit_cost >= 0),
  tax_rate numeric(7,4) not null default 0 check (tax_rate >= 0),
  packaging_cost numeric(14,2) not null default 0 check (packaging_cost >= 0),
  operational_cost numeric(14,2) not null default 0 check (operational_cost >= 0),
  other_cost numeric(14,2) not null default 0 check (other_cost >= 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id, sku)
);
create index if not exists sku_costs_account_idx on magalu.sku_costs(account_id, updated_at desc);
