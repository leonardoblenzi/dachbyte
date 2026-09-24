alter table magalu.accounts
  add column if not exists catalog_sync_status text not null default 'idle'
    check (catalog_sync_status in ('idle','queued','running','success','partial','failed')),
  add column if not exists catalog_last_synced_at timestamptz,
  add column if not exists catalog_last_error text;

create table if not exists magalu.skus (
  id bigserial primary key,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  sku text not null,
  title text,
  status text,
  active boolean,
  brand text,
  group_id text,
  category_id text,
  fulfillment boolean,
  payload jsonb not null default '{}'::jsonb,
  magalu_created_at timestamptz,
  magalu_updated_at timestamptz,
  is_present boolean not null default true,
  last_seen_at timestamptz,
  last_synced_at timestamptz not null default now(),
  last_http_status integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_magalu_skus_account_sku unique (account_id, sku)
);
create index if not exists idx_magalu_skus_account_status on magalu.skus(account_id, status, updated_at desc);
create index if not exists idx_magalu_skus_account_group on magalu.skus(account_id, group_id) where group_id is not null;
create index if not exists idx_magalu_skus_search on magalu.skus(account_id, lower(sku), lower(coalesce(title,'')));

create table if not exists magalu.prices (
  id bigserial primary key,
  account_id bigint not null,
  sku text not null,
  price numeric(18,4),
  list_price numeric(18,4),
  payload jsonb not null default '{}'::jsonb,
  is_present boolean not null default true,
  last_http_status integer,
  last_error text,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_magalu_prices_sku foreign key (account_id, sku) references magalu.skus(account_id, sku) on delete cascade,
  constraint uq_magalu_prices_account_sku unique (account_id, sku)
);
create index if not exists idx_magalu_prices_account on magalu.prices(account_id, updated_at desc);

create table if not exists magalu.stocks (
  id bigserial primary key,
  account_id bigint not null,
  sku text not null,
  quantity numeric(18,4),
  payload jsonb not null default '{}'::jsonb,
  is_present boolean not null default true,
  last_http_status integer,
  last_error text,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_magalu_stocks_sku foreign key (account_id, sku) references magalu.skus(account_id, sku) on delete cascade,
  constraint uq_magalu_stocks_account_sku unique (account_id, sku)
);
create index if not exists idx_magalu_stocks_account on magalu.stocks(account_id, updated_at desc);

alter table magalu.webhook_events
  add column if not exists account_id bigint references magalu.accounts(id) on delete set null;
create index if not exists idx_magalu_webhook_events_account on magalu.webhook_events(account_id, received_at desc);
