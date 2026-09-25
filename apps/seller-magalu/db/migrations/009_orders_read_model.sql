-- DACHBYTE Seller · Magalu · Etapa 7
-- Pedidos/entregas em modo somente leitura. Nenhuma operação remota de escrita é criada.

alter table magalu.accounts
  add column if not exists orders_sync_status text not null default 'idle'
    check (orders_sync_status in ('idle','queued','running','success','partial','failed')),
  add column if not exists orders_last_synced_at timestamptz,
  add column if not exists orders_last_error text;

create index if not exists idx_magalu_accounts_orders_sync
  on magalu.accounts(orders_sync_status, updated_at desc);

create table if not exists magalu.orders (
  id bigserial primary key,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  code text not null,
  remote_id text,
  channel_id text,
  status text,
  purchased_at timestamptz,
  remote_updated_at timestamptz,
  amount_total bigint,
  amount_currency text,
  amount_normalizer integer,
  item_count integer not null default 0,
  delivery_count integer not null default 0,
  operational_payload jsonb not null default '{}'::jsonb,
  is_present boolean not null default true,
  last_seen_at timestamptz,
  last_synced_at timestamptz not null default now(),
  last_http_status integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_magalu_orders_account_code unique(account_id, code)
);
create index if not exists idx_magalu_orders_account_purchase
  on magalu.orders(account_id, purchased_at desc nulls last, updated_at desc);
create index if not exists idx_magalu_orders_account_status
  on magalu.orders(account_id, status, purchased_at desc nulls last);
create index if not exists idx_magalu_orders_account_channel
  on magalu.orders(account_id, channel_id) where channel_id is not null;
create index if not exists idx_magalu_orders_search
  on magalu.orders(account_id, lower(code), lower(coalesce(remote_id,'')));

create table if not exists magalu.order_items (
  id bigserial primary key,
  order_id bigint not null references magalu.orders(id) on delete cascade,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  item_key text not null,
  sku text,
  remote_item_id text,
  name text,
  brand text,
  quantity numeric(18,4),
  measure_unit text,
  unit_price bigint,
  amount_total bigint,
  amount_currency text,
  amount_normalizer integer,
  operational_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_magalu_order_items_order_key unique(order_id, item_key)
);
create index if not exists idx_magalu_order_items_account_sku
  on magalu.order_items(account_id, lower(coalesce(sku,'')));

create table if not exists magalu.deliveries (
  id bigserial primary key,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  order_id bigint references magalu.orders(id) on delete set null,
  remote_id text not null,
  order_code text,
  channel_id text,
  status text,
  purchased_at timestamptz,
  handling_limit_at timestamptz,
  delivery_limit_at date,
  posting_at timestamptz,
  provider_id text,
  provider_name text,
  shipping_type text,
  shipping_name text,
  is_mle boolean,
  is_fulfillment boolean,
  tracking_code text,
  tracking_url text,
  amount_total bigint,
  amount_freight bigint,
  amount_discount bigint,
  amount_currency text,
  amount_normalizer integer,
  item_count integer not null default 0,
  operational_payload jsonb not null default '{}'::jsonb,
  is_present boolean not null default true,
  last_seen_at timestamptz,
  last_synced_at timestamptz not null default now(),
  last_http_status integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_magalu_deliveries_account_remote unique(account_id, remote_id)
);
create index if not exists idx_magalu_deliveries_account_order
  on magalu.deliveries(account_id, order_code, purchased_at desc nulls last);
create index if not exists idx_magalu_deliveries_account_status
  on magalu.deliveries(account_id, status, purchased_at desc nulls last);
create index if not exists idx_magalu_deliveries_channel
  on magalu.deliveries(account_id, channel_id) where channel_id is not null;

create table if not exists magalu.delivery_items (
  id bigserial primary key,
  delivery_id bigint not null references magalu.deliveries(id) on delete cascade,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  item_key text not null,
  sku text,
  remote_item_id text,
  name text,
  brand text,
  quantity numeric(18,4),
  measure_unit text,
  unit_price bigint,
  amount_total bigint,
  amount_currency text,
  amount_normalizer integer,
  operational_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_magalu_delivery_items_delivery_key unique(delivery_id, item_key)
);
create index if not exists idx_magalu_delivery_items_account_sku
  on magalu.delivery_items(account_id, lower(coalesce(sku,'')));

-- A réplica de pedidos é operacional e não deve armazenar PII bruta do comprador.
comment on column magalu.orders.operational_payload is 'Payload operacional sanitizado: documentos, email, telefone e endereço detalhado do comprador são removidos no Node antes da persistência.';
comment on column magalu.deliveries.operational_payload is 'Payload operacional sanitizado: documentos, email, telefone e endereço detalhado do comprador são removidos no Node antes da persistência.';
