-- DACH Hub · Fase 3 / P2: status internos, etiquetas e automações (evento → condição → ação).

-- Status internos da empresa (fluxo da operação), separados da situação que vem do canal.
create table if not exists hub.order_statuses (
  id bigserial primary key,
  tenant_id text not null,
  name text not null,
  color text not null default 'violet' check (color in ('violet','blue','green','yellow','orange','red','gray')),
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_hub_order_statuses_name on hub.order_statuses(tenant_id, lower(name));

alter table hub.channel_orders
  add column if not exists custom_status_id bigint references hub.order_statuses(id) on delete set null,
  add column if not exists custom_status_at timestamptz,
  add column if not exists tags text[] not null default '{}'::text[];
create index if not exists idx_hub_channel_orders_custom_status on hub.channel_orders(custom_status_id);

-- Linha do tempo: também status interno, etiquetas e automações.
alter table hub.order_events drop constraint if exists order_events_kind_check;
alter table hub.order_events add constraint order_events_kind_check
  check (kind in ('received','stage','stock','custom_status','tags','automation'));

-- Regras: quando (evento) + se (condições, todas) → então (ações, em ordem).
create table if not exists hub.automation_rules (
  id bigserial primary key,
  tenant_id text not null,
  name text not null,
  active boolean not null default true,
  event text not null check (event in ('order_received','stage_changed','custom_status_changed','ship_by_soon','order_late','manual')),
  event_params jsonb not null default '{}'::jsonb,
  conditions jsonb not null default '[]'::jsonb,
  actions jsonb not null,
  position integer not null default 0,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_hub_automation_rules_event on hub.automation_rules(tenant_id, event) where active;

-- Execuções: uma por regra + pedido + ocorrência do evento (reprocessar não repete as ações).
create table if not exists hub.automation_runs (
  id bigserial primary key,
  tenant_id text not null,
  rule_id bigint not null references hub.automation_rules(id) on delete cascade,
  order_id bigint not null references hub.channel_orders(id) on delete cascade,
  event text not null,
  event_key text not null,
  status text not null check (status in ('done','skipped','failed')),
  results jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  constraint uq_hub_automation_run unique (rule_id, order_id, event, event_key)
);
create index if not exists idx_hub_automation_runs_rule on hub.automation_runs(rule_id, created_at desc);

-- Avisos para a equipe (ação "avisar a equipe").
create table if not exists hub.notifications (
  id bigserial primary key,
  tenant_id text not null,
  title text not null,
  body text,
  order_id bigint references hub.channel_orders(id) on delete cascade,
  rule_id bigint references hub.automation_rules(id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_hub_notifications_unread on hub.notifications(tenant_id, created_at desc) where read_at is null;

-- Segredo para assinar os webhooks das automações (gerado no primeiro uso).
alter table hub.tenant_settings add column if not exists webhook_secret text;
