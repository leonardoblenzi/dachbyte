-- DACH Hub · Etapa E3: pedidos (baixa e devolução), webhooks e envio de estoque com verificação.
-- Só contas em modo "active" recebem escrita; a pausa geral da empresa para tudo na hora.

-- Pausa geral por empresa (botão único que para todos os envios).
create table if not exists hub.tenant_settings (
  tenant_id text primary key,
  stock_paused boolean not null default false,
  paused_by text,
  paused_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Quem ativou a escrita na conta, quando, e até onde os pedidos já foram lidos (polling de segurança).
alter table hub.channel_accounts
  add column if not exists activated_at timestamptz,
  add column if not exists activated_by text,
  add column if not exists orders_synced_at timestamptz;

-- O que o Hub enviou por último para o anúncio.
alter table hub.listings
  add column if not exists last_pushed_stock numeric(14,4),
  add column if not exists last_pushed_at timestamptz;

-- Notificações recebidas dos canais. dedupe_key absorve reenvios em rajada; o processamento é idempotente.
create table if not exists hub.webhook_events (
  id bigserial primary key,
  channel text not null,
  external_account_id text,
  topic text not null,
  resource_id text not null,
  dedupe_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'received' check (status in ('received','processed','ignored','failed')),
  attempts integer not null default 0,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint uq_hub_webhook_dedupe unique (dedupe_key)
);
create index if not exists idx_hub_webhook_events_status on hub.webhook_events(status, id);

-- Pedidos dos canais, já no formato comum. status: open (conta como venda) | cancelled.
create table if not exists hub.channel_orders (
  id bigserial primary key,
  channel_account_id bigint not null references hub.channel_accounts(id) on delete cascade,
  external_order_id text not null,
  status text not null check (status in ('open','cancelled')),
  channel_status text,
  fulfillment boolean not null default false,
  total numeric(14,2),
  ordered_at timestamptz,
  channel_updated_at timestamptz,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_hub_channel_order unique (channel_account_id, external_order_id)
);
create index if not exists idx_hub_channel_orders_account on hub.channel_orders(channel_account_id, ordered_at desc);

-- Itens do pedido. A baixa é por item (idempotente pela chave do movimento); sem vínculo fica pendente
-- e é aplicada na hora em que o anúncio for vinculado.
create table if not exists hub.order_lines (
  id bigserial primary key,
  order_id bigint not null references hub.channel_orders(id) on delete cascade,
  line_key text not null,
  listing_id text not null,
  variation_id text not null default '',
  channel_sku text,
  title text,
  quantity numeric(14,4) not null check (quantity > 0),
  unit_price numeric(14,2),
  item_id bigint references hub.items(id) on delete set null,
  sale_applied boolean not null default false,
  cancel_applied boolean not null default false,
  pending_link boolean not null default false,
  constraint uq_hub_order_line unique (order_id, line_key)
);
create index if not exists idx_hub_order_lines_pending on hub.order_lines(listing_id, variation_id) where pending_link;

-- Fila de envios de estoque. Um envio aberto por anúncio (o novo valor substitui o pendente).
create table if not exists hub.stock_pushes (
  id bigserial primary key,
  tenant_id text not null,
  listing_id bigint not null references hub.listings(id) on delete cascade,
  channel_account_id bigint not null references hub.channel_accounts(id) on delete cascade,
  desired numeric(14,4) not null check (desired >= 0),
  previous numeric(14,4),
  observed numeric(14,4),
  -- Valor novo que chegou enquanto este envio estava em andamento: vira o próximo envio.
  followup numeric(14,4),
  reason text,
  state text not null default 'pending' check (state in ('pending','sending','verified','divergent','failed','skipped')),
  attempts integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  verified_at timestamptz
);
create unique index if not exists uq_hub_stock_pushes_open on hub.stock_pushes(listing_id) where state in ('pending','sending');
create index if not exists idx_hub_stock_pushes_account on hub.stock_pushes(channel_account_id, state, id);
create index if not exists idx_hub_stock_pushes_tenant on hub.stock_pushes(tenant_id, id desc);
