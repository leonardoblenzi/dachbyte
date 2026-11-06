-- DACH Hub · Fase 3 / P3: expedição (lotes de separação, conferência com bipagem e foto, coletas).

-- Lote de separação: um grupo de pedidos separados juntos (a lista de separação soma por SKU).
create table if not exists hub.picking_batches (
  id bigserial primary key,
  tenant_id text not null,
  status text not null default 'open' check (status in ('open','done','cancelled')),
  note text,
  created_by text,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists idx_hub_picking_batches_tenant on hub.picking_batches(tenant_id, status, id desc);

-- Coleta: pacotes entregues a uma transportadora/marketplace numa data.
create table if not exists hub.pickups (
  id bigserial primary key,
  tenant_id text not null,
  carrier text not null,
  scheduled_for date not null,
  status text not null default 'open' check (status in ('open','closed')),
  created_by text,
  created_at timestamptz not null default now(),
  closed_by text,
  closed_at timestamptz
);
create index if not exists idx_hub_pickups_tenant on hub.pickups(tenant_id, status, scheduled_for desc);

alter table hub.channel_orders
  add column if not exists picking_batch_id bigint references hub.picking_batches(id) on delete set null,
  add column if not exists packed_at timestamptz,
  add column if not exists packed_by text,
  add column if not exists pack_issue text,
  add column if not exists pickup_id bigint references hub.pickups(id) on delete set null,
  add column if not exists handed_over_at timestamptz;
create index if not exists idx_hub_channel_orders_to_pack on hub.channel_orders(channel_account_id, ship_by) where packed_at is null;
create index if not exists idx_hub_channel_orders_batch on hub.channel_orders(picking_batch_id);
create index if not exists idx_hub_channel_orders_pickup on hub.channel_orders(pickup_id);

-- Foto do pacote embalado (prova em reclamação). JPEG reduzido no navegador (~150 KB).
create table if not exists hub.order_photos (
  id bigserial primary key,
  tenant_id text not null,
  order_id bigint not null references hub.channel_orders(id) on delete cascade,
  mime text not null check (mime in ('image/jpeg','image/png','image/webp')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 3000000),
  content bytea not null,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists idx_hub_order_photos_order on hub.order_photos(order_id);

-- Linha do tempo: eventos da expedição.
alter table hub.order_events drop constraint if exists order_events_kind_check;
alter table hub.order_events add constraint order_events_kind_check
  check (kind in ('received','stage','stock','custom_status','tags','automation','expedition'));

-- Automações: novo gatilho "pedido conferido".
alter table hub.automation_rules drop constraint if exists automation_rules_event_check;
alter table hub.automation_rules add constraint automation_rules_event_check
  check (event in ('order_received','stage_changed','custom_status_changed','ship_by_soon','order_late','manual','order_packed'));
