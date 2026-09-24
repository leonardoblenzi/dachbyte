create schema if not exists magalu;

create table if not exists magalu.migrations (
  filename text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);

create table if not exists magalu.accounts (
  id bigserial primary key,
  dach_tenant_id text not null,
  dach_created_by_user_id text,
  magalu_tenant_id text not null,
  magalu_tenant_name text,
  status text not null default 'pending' check (status in ('pending','active','revoked','disabled','error')),
  scopes text[] not null default '{}'::text[],
  metadata jsonb not null default '{}'::jsonb,
  connected_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_magalu_accounts_magalu_tenant unique (magalu_tenant_id)
);
comment on column magalu.accounts.magalu_tenant_id is 'Ownership invariant: one Magalu tenant can belong to only one DACH tenant at a time. OAuth must reject cross-tenant relinking.';
create index if not exists idx_magalu_accounts_dach_tenant on magalu.accounts(dach_tenant_id);

create table if not exists magalu.tokens (
  id bigserial primary key,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  token_type text,
  token_version integer not null default 1,
  last_refresh_at timestamptz,
  last_refresh_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id)
);

create table if not exists magalu.oauth_states (
  id bigserial primary key,
  state_hash text not null unique,
  dach_tenant_id text not null,
  dach_user_id text not null,
  redirect_after text,
  pkce_verifier_ciphertext text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_magalu_oauth_states_expiry on magalu.oauth_states(expires_at) where used_at is null;

create table if not exists magalu.webhook_subscriptions (
  id bigserial primary key,
  account_id bigint references magalu.accounts(id) on delete cascade,
  magalu_tenant_id text not null,
  subscription_external_id text,
  topic text not null,
  webhook_url text not null,
  status text not null default 'pending' check (status in ('pending','active','disabled','error')),
  secret_ciphertext text,
  previous_secret_ciphertext text,
  previous_secret_expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(magalu_tenant_id, topic, webhook_url)
);
create index if not exists idx_magalu_webhook_subscription_lookup
  on magalu.webhook_subscriptions(magalu_tenant_id, topic, status);

create table if not exists magalu.webhook_events (
  id bigserial primary key,
  magalu_tenant_id text not null,
  topic text not null,
  payload jsonb not null,
  raw_body text not null,
  event_hash text not null unique,
  signature_header text not null,
  timestamp_header text not null,
  processing_status text not null default 'validated'
    check (processing_status in ('validated','queued','processing','processed','ignored','failed')),
  attempts integer not null default 0,
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists idx_magalu_webhook_events_pending
  on magalu.webhook_events(processing_status, received_at);
create index if not exists idx_magalu_webhook_events_tenant_topic
  on magalu.webhook_events(magalu_tenant_id, topic, received_at desc);

create table if not exists magalu.sync_runs (
  id bigserial primary key,
  dach_tenant_id text not null,
  account_id bigint references magalu.accounts(id) on delete cascade,
  sync_type text not null,
  status text not null default 'running' check (status in ('running','success','partial','failed','canceled')),
  cursor_in text,
  cursor_out text,
  period_start timestamptz,
  period_end timestamptz,
  scanned_count integer not null default 0,
  created_count integer not null default 0,
  updated_count integer not null default 0,
  failed_count integer not null default 0,
  result jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_magalu_sync_runs_account_type
  on magalu.sync_runs(account_id, sync_type, started_at desc);
