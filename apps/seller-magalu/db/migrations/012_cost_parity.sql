create table if not exists magalu.finance_settings (
  account_id bigint primary key references magalu.accounts(id) on delete cascade,
  aliquota numeric(7,4) not null default 0 check (aliquota >= 0 and aliquota <= 100),
  updated_by text,
  updated_at timestamptz not null default now()
);

create table if not exists magalu.finance_settings_history (
  id bigserial primary key,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  previous_rate numeric(7,4),
  new_rate numeric(7,4) not null,
  changed_by text,
  created_at timestamptz not null default now()
);
create index if not exists finance_settings_history_account_idx
  on magalu.finance_settings_history(account_id, created_at desc);

create table if not exists magalu.sku_cost_history (
  id bigserial primary key,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  sku text not null,
  previous_cost numeric(14,2),
  new_cost numeric(14,2) not null check (new_cost >= 0),
  previous_components jsonb not null default '{}'::jsonb,
  new_components jsonb not null default '{}'::jsonb,
  source text not null check (source in ('manual', 'xlsx')),
  changed_by text,
  created_at timestamptz not null default now(),
  foreign key (account_id, sku) references magalu.skus(account_id, sku) on delete cascade
);
create index if not exists sku_cost_history_account_sku_idx
  on magalu.sku_cost_history(account_id, sku, created_at desc);
