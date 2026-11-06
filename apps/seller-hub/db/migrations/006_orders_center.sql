-- DACH Hub · Fase 3 / P1: central de pedidos (pedido completo, linha do tempo) e medição de vendas (GMV) para a cobrança.

-- Situação padronizada (igual para todos os canais) e dados do pedido. "status" (open/cancelled) continua
-- sendo o que decide a baixa de estoque; "stage" é o andamento que o seller acompanha.
alter table hub.channel_orders
  add column if not exists stage text not null default 'paid'
    check (stage in ('new','paid','invoiced','ready_to_ship','shipped','delivered','cancelled','returned')),
  add column if not exists stage_updated_at timestamptz,
  add column if not exists products_total numeric(14,2),
  add column if not exists shipping_paid numeric(14,2),
  add column if not exists fees_total numeric(14,2),
  add column if not exists discount_total numeric(14,2),
  add column if not exists net_total numeric(14,2),
  add column if not exists ship_by timestamptz,
  add column if not exists shipped_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists logistic_type text,
  add column if not exists carrier text,
  add column if not exists tracking_code text,
  add column if not exists shipment_id text,
  add column if not exists invoice_number text,
  add column if not exists invoice_key text,
  add column if not exists buyer_name text,
  add column if not exists buyer_city text,
  add column if not exists buyer_state text;
create index if not exists idx_hub_channel_orders_stage on hub.channel_orders(channel_account_id, stage, ship_by);

-- Tarifa do marketplace por item (comissão), quando o canal informa.
alter table hub.order_lines add column if not exists sale_fee numeric(14,2);

-- Linha do tempo do pedido: recebido, mudanças de situação, baixa e devolução de estoque.
create table if not exists hub.order_events (
  id bigserial primary key,
  order_id bigint not null references hub.channel_orders(id) on delete cascade,
  kind text not null check (kind in ('received','stage','stock')),
  stage text,
  channel_status text,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_hub_order_events_order on hub.order_events(order_id, id);

-- Fechamento mensal das vendas (base da cobrança por %). Mês no fuso de São Paulo, valor dos produtos sem frete.
-- Cancelamento/devolução de pedido de mês já fechado vira crédito no mês em que aconteceu.
create table if not exists hub.gmv_closings (
  tenant_id text not null,
  month date not null,
  orders integer not null,
  gmv numeric(14,2) not null,
  credits numeric(14,2) not null default 0,
  closed_at timestamptz not null default now(),
  primary key (tenant_id, month)
);
