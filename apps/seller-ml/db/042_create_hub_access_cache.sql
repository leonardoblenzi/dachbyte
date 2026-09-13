begin;

create table if not exists hub_access_cache (
  id bigserial primary key,
  local_user_id integer not null,
  local_empresa_id integer not null,
  module text not null,
  allow boolean not null default false,
  reason text,
  hub_status text,
  checked_at timestamptz not null default now(),
  expires_at timestamptz not null,
  metadata_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (local_user_id, local_empresa_id, module)
);

create index if not exists ix_hub_access_cache_valid_until
  on hub_access_cache (local_user_id, local_empresa_id, module, expires_at)
  where allow = true;

commit;
