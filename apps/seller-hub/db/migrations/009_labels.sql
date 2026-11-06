-- DACH Hub · Fase 3 / P4: etiquetas de envio por canal (baixadas em lote e guardadas por 7 dias).

-- Referências do canal para pedir a etiqueta (ML: envio; Magalu: canal + entregas; Shopee: pacotes).
alter table hub.channel_orders
  add column if not exists channel_refs jsonb not null default '{}'::jsonb,
  add column if not exists label_printed_at timestamptz,
  add column if not exists label_prints integer not null default 0;

-- Cada pedido de impressão gera um arquivo por conta (o canal devolve o próprio PDF/ZPL).
create table if not exists hub.label_batches (
  id bigserial primary key,
  tenant_id text not null,
  format text not null check (format in ('pdf','zpl')),
  orders integer not null default 0,
  failures jsonb not null default '[]'::jsonb,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists idx_hub_label_batches_tenant on hub.label_batches(tenant_id, id desc);

create table if not exists hub.label_files (
  id bigserial primary key,
  batch_id bigint not null references hub.label_batches(id) on delete cascade,
  tenant_id text not null,
  channel_account_id bigint references hub.channel_accounts(id) on delete set null,
  channel text not null,
  filename text not null,
  content_type text not null,
  size_bytes integer not null,
  content bytea not null,
  orders integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_hub_label_files_batch on hub.label_files(batch_id);
create index if not exists idx_hub_label_files_created on hub.label_files(created_at);
