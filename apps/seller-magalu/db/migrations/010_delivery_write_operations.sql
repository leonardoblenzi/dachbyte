-- DACHBYTE Seller · Magalu · Etapa 8
-- Operações protegidas de Entregas: envio de NF-e e finalização.
-- Payload sensível (XML/issuer) nunca é persistido em texto puro.

create table if not exists magalu.delivery_write_previews (
  id uuid primary key,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  dach_tenant_id text not null,
  dach_user_id text not null,
  delivery_id text not null,
  order_code text,
  channel_id text not null,
  action text not null check (action in ('invoice_send','finish_delivery')),
  before_payload jsonb not null default '{}'::jsonb,
  requested_metadata jsonb not null default '{}'::jsonb,
  sensitive_payload_ciphertext text,
  request_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists idx_magalu_delivery_write_previews_identity
  on magalu.delivery_write_previews(dach_tenant_id,dach_user_id,account_id,created_at desc);
create index if not exists idx_magalu_delivery_write_previews_expiry
  on magalu.delivery_write_previews(expires_at) where used_at is null;

create table if not exists magalu.delivery_write_operations (
  id bigserial primary key,
  idempotency_key uuid not null unique,
  preview_id uuid references magalu.delivery_write_previews(id) on delete set null,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  dach_tenant_id text not null,
  dach_user_id text not null,
  delivery_id text not null,
  order_code text,
  channel_id text not null,
  action text not null check (action in ('invoice_send','finish_delivery')),
  status text not null default 'queued'
    check (status in ('queued','running','dispatching','accepted','succeeded','stale','failed','divergent','uncertain','canceled')),
  request_hash text not null,
  before_payload jsonb not null default '{}'::jsonb,
  requested_metadata jsonb not null default '{}'::jsonb,
  sensitive_payload_ciphertext text,
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
create index if not exists idx_magalu_delivery_write_account_created
  on magalu.delivery_write_operations(account_id,created_at desc);
create index if not exists idx_magalu_delivery_write_status
  on magalu.delivery_write_operations(status,created_at asc);
create index if not exists idx_magalu_delivery_write_delivery
  on magalu.delivery_write_operations(account_id,delivery_id,created_at desc);
create unique index if not exists uq_magalu_delivery_write_active
  on magalu.delivery_write_operations(account_id,delivery_id,action)
  where status in ('queued','running','dispatching','accepted','divergent','uncertain');

comment on column magalu.delivery_write_previews.sensitive_payload_ciphertext is
  'AES-256-GCM payload criptografado via MAGALU_ENCRYPTION_KEY. Pode conter XML/issuer de NF-e; nunca expor em UI, logs ou auditoria.';
comment on column magalu.delivery_write_operations.sensitive_payload_ciphertext is
  'AES-256-GCM payload criptografado via MAGALU_ENCRYPTION_KEY. Pode conter XML/issuer de NF-e; nunca expor em UI, logs ou auditoria.';

-- Retenção aplicada pelo scheduler magalu-delivery-write: previews expirados >24h;
-- operações succeeded 30d; failed/stale/canceled 60d; uncertain/divergent 90d.
-- O ciphertext do preview é apagado ao confirmar e o da operação ao entrar em dispatching.
