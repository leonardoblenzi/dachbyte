-- DACHBYTE Seller · Magalu · Etapa 5
-- Motor massivo de Gestão de SKUs com preview, lotes, itens e retenção segura.

create table if not exists magalu.sku_mass_previews (
  id uuid primary key,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  dach_tenant_id text not null,
  dach_user_id text not null,
  action text not null check (action in ('activate','deactivate')),
  selection_mode text not null check (selection_mode in ('explicit','all_filtered')),
  filter_payload jsonb not null default '{}'::jsonb,
  rows jsonb not null default '[]'::jsonb,
  selected_count integer not null default 0 check (selected_count >= 0 and selected_count <= 5000),
  change_count integer not null default 0 check (change_count >= 0 and change_count <= 5000),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  constraint ck_magalu_sku_mass_previews_rows_array check (jsonb_typeof(rows) = 'array')
);
create index if not exists idx_magalu_sku_mass_previews_identity
  on magalu.sku_mass_previews(dach_tenant_id,dach_user_id,account_id,created_at desc);
create index if not exists idx_magalu_sku_mass_previews_expiry
  on magalu.sku_mass_previews(expires_at) where used_at is null;

create table if not exists magalu.mass_operation_batches (
  id uuid primary key,
  preview_id uuid references magalu.sku_mass_previews(id) on delete set null,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  dach_tenant_id text not null,
  dach_user_id text not null,
  operation_type text not null default 'sku_status' check (operation_type = 'sku_status'),
  action text not null check (action in ('activate','deactivate')),
  status text not null default 'queued'
    check (status in ('queued','running','completed','partial','failed','canceled')),
  total_count integer not null default 0,
  success_count integer not null default 0,
  failed_count integer not null default 0,
  stale_count integer not null default 0,
  uncertain_count integer not null default 0,
  divergent_count integer not null default 0,
  canceled_count integer not null default 0,
  pending_count integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_magalu_mass_batches_account_created
  on magalu.mass_operation_batches(account_id,created_at desc);
create index if not exists idx_magalu_mass_batches_tenant_created
  on magalu.mass_operation_batches(dach_tenant_id,created_at desc);
create index if not exists idx_magalu_mass_batches_status
  on magalu.mass_operation_batches(status,created_at asc);

create table if not exists magalu.mass_operation_items (
  id bigserial primary key,
  idempotency_key uuid not null unique,
  batch_id uuid not null references magalu.mass_operation_batches(id) on delete cascade,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  dach_tenant_id text not null,
  dach_user_id text not null,
  sku text not null,
  action text not null check (action in ('activate','deactivate')),
  status text not null default 'queued'
    check (status in ('queued','running','dispatching','accepted','succeeded','stale','failed','divergent','uncertain','canceled')),
  request_hash text not null,
  before_payload jsonb not null default '{}'::jsonb,
  requested_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb,
  after_payload jsonb,
  response_status integer,
  request_id text,
  error_code text,
  error_message text,
  remote_accepted_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_magalu_mass_items_batch
  on magalu.mass_operation_items(batch_id,id);
create index if not exists idx_magalu_mass_items_account_created
  on magalu.mass_operation_items(account_id,created_at desc);
create index if not exists idx_magalu_mass_items_status
  on magalu.mass_operation_items(status,created_at asc);
create index if not exists idx_magalu_mass_items_sku
  on magalu.mass_operation_items(account_id,lower(sku));
create unique index if not exists uq_magalu_mass_active_sku
  on magalu.mass_operation_items(account_id,sku)
  where status in ('queued','running','dispatching','accepted','divergent','uncertain');

-- Retenção: itens concluídos com sucesso 30d; falhas/stale/cancelados 60d;
-- uncertain/divergent 90d. Batches completed 60d; partial/failed/canceled 90d.
-- A limpeza é executada pelo job de retenção do próprio magalu-sku-update.
