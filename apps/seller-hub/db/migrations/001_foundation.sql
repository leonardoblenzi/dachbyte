-- DACH Hub · Etapa E1: contas conectadas, catálogo mestre, anúncios e vínculos.
-- Escrita nos canais ainda não existe nesta etapa (só leitura e modo observação).

create schema if not exists hub;

create table if not exists hub.channel_accounts (
  id bigserial primary key,
  tenant_id text not null,
  channel text not null check (channel in ('mercadolivre','magalu','shopee')),
  external_account_id text not null,
  label text,
  status text not null default 'connected' check (status in ('connected','reconnect_required','disconnected')),
  stock_sync_mode text not null default 'off' check (stock_sync_mode in ('off','observe','active')),
  connected_by text,
  connected_at timestamptz not null default now(),
  last_import_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Uma conta do marketplace pertence a uma única empresa no Hub.
  constraint uq_hub_channel_account unique (channel, external_account_id)
);
create index if not exists idx_hub_channel_accounts_tenant on hub.channel_accounts(tenant_id, channel);

create table if not exists hub.channel_tokens (
  channel_account_id bigint primary key references hub.channel_accounts(id) on delete cascade,
  access_token_enc text not null,
  refresh_token_enc text,
  expires_at timestamptz,
  refresh_expires_at timestamptz,
  scopes text[] not null default '{}'::text[],
  refresh_failures integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists hub.oauth_states (
  state_hash text primary key,
  tenant_id text not null,
  user_id text not null,
  channel text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists hub.items (
  id bigserial primary key,
  tenant_id text not null,
  sku text not null,
  sku_key text not null,
  name text,
  ean text,
  brand text,
  kind text not null default 'simple' check (kind in ('simple','kit')),
  active boolean not null default true,
  origin text not null default 'channel_import' check (origin in ('channel_import','spreadsheet','manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_hub_items_tenant_sku unique (tenant_id, sku_key)
);
create index if not exists idx_hub_items_ean on hub.items(tenant_id, ean) where ean is not null;

create table if not exists hub.kit_components (
  kit_item_id bigint not null references hub.items(id) on delete cascade,
  component_item_id bigint not null references hub.items(id) on delete restrict,
  quantity numeric(14,4) not null check (quantity > 0),
  primary key (kit_item_id, component_item_id)
);

create table if not exists hub.listings (
  id bigserial primary key,
  channel_account_id bigint not null references hub.channel_accounts(id) on delete cascade,
  listing_id text not null,
  variation_id text not null default '',
  channel_sku text,
  sku_key text,
  ean text,
  title text,
  status text,
  fulfillment boolean not null default false,
  channel_stock numeric(14,4),
  price numeric(14,2),
  item_id bigint references hub.items(id) on delete set null,
  link_method text check (link_method in ('auto_sku','auto_ean','manual')),
  link_suggestion_item_id bigint references hub.items(id) on delete set null,
  sync_enabled boolean not null default true,
  seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_hub_listing unique (channel_account_id, listing_id, variation_id)
);
create index if not exists idx_hub_listings_item on hub.listings(item_id);
create index if not exists idx_hub_listings_unlinked on hub.listings(channel_account_id) where item_id is null;

create table if not exists hub.import_runs (
  id bigserial primary key,
  channel_account_id bigint not null references hub.channel_accounts(id) on delete cascade,
  status text not null default 'running' check (status in ('running','succeeded','failed')),
  listings_seen integer not null default 0,
  linked_auto integer not null default 0,
  unlinked integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists hub.audit_events (
  id bigserial primary key,
  tenant_id text not null,
  user_id text,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_hub_audit_tenant on hub.audit_events(tenant_id, created_at desc);
