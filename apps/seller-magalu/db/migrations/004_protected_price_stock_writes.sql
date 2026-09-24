-- DACHBYTE Seller · Magalu · Etapa 4
-- Escritas protegidas de preço/estoque com preview persistido, idempotência e auditoria.

create table if not exists magalu.write_previews (
  id uuid primary key,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  dach_tenant_id text not null,
  dach_user_id text not null,
  resource_type text not null check (resource_type in ('price','stock')),
  rows jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  constraint ck_magalu_write_previews_rows_array check (jsonb_typeof(rows) = 'array')
);
create index if not exists idx_magalu_write_previews_lookup
  on magalu.write_previews(dach_tenant_id, dach_user_id, account_id, expires_at desc);

create table if not exists magalu.write_operations (
  id bigserial primary key,
  idempotency_key uuid not null unique,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  preview_id uuid references magalu.write_previews(id) on delete set null,
  dach_tenant_id text not null,
  dach_user_id text not null,
  resource_type text not null check (resource_type in ('price','stock')),
  sku text not null,
  request_hash text not null,
  intended_method text check (intended_method in ('POST','PATCH')),
  actual_method text check (actual_method in ('POST','PATCH')),
  status text not null default 'queued' check (status in ('queued','running','dispatching','accepted','succeeded','divergent','uncertain','stale','failed')),
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
create index if not exists idx_magalu_write_operations_account_created
  on magalu.write_operations(account_id, created_at desc);
create index if not exists idx_magalu_write_operations_status
  on magalu.write_operations(status, created_at asc);
create index if not exists idx_magalu_write_request_hash
  on magalu.write_operations(account_id, resource_type, sku, request_hash);
create unique index if not exists uq_magalu_write_active_resource
  on magalu.write_operations(account_id, resource_type, sku)
  where status in ('queued','running','dispatching','accepted','divergent','uncertain');

create table if not exists magalu.audit_events (
  id bigserial primary key,
  account_id bigint references magalu.accounts(id) on delete set null,
  operation_id bigint references magalu.write_operations(id) on delete set null,
  dach_tenant_id text,
  dach_user_id text,
  action text not null,
  resource_type text,
  sku text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_magalu_audit_account_created
  on magalu.audit_events(account_id, created_at desc);
