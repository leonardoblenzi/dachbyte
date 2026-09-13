begin;

create table if not exists empresa_integracoes (
  id bigserial primary key,
  empresa_id bigint not null references empresas(id) on delete cascade,
  meli_conta_id bigint null references meli_contas(id) on delete set null,
  provider text not null,
  status text not null default 'disabled',
  api_base_url text null,
  credentials_encrypted text null,
  webhook_secret_encrypted text null,
  config jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz null,
  last_test_at timestamptz null,
  last_error text null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint ck_empresa_integracoes_provider
    check (provider ~ '^[a-z0-9_.-]+$'),
  constraint ck_empresa_integracoes_status
    check (status in ('disabled', 'active', 'error'))
);

create unique index if not exists ux_empresa_integracoes_empresa_conta_provider
  on empresa_integracoes (empresa_id, coalesce(meli_conta_id, 0), provider);

create index if not exists ix_empresa_integracoes_empresa_status
  on empresa_integracoes (empresa_id, status, provider);

create table if not exists ml_external_task_links (
  id bigserial primary key,
  empresa_integracao_id bigint null references empresa_integracoes(id) on delete set null,
  task_id bigint null references ml_strategic_tasks(id) on delete cascade,
  provider text not null,
  source_module text not null default 'estrategicos',
  source_entity_type text not null default 'task',
  source_entity_id text null,
  external_task_id text null,
  external_url text null,
  external_status text null,
  external_payload jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz null,
  last_error text null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint ck_ml_external_task_links_provider
    check (provider ~ '^[a-z0-9_.-]+$')
);

create unique index if not exists ux_ml_external_task_links_provider_external
  on ml_external_task_links (provider, external_task_id)
  where external_task_id is not null and external_task_id <> '';

create index if not exists ix_ml_external_task_links_task
  on ml_external_task_links (task_id, provider);

create index if not exists ix_ml_external_task_links_source
  on ml_external_task_links (source_module, source_entity_type, source_entity_id);

create table if not exists ml_integration_events (
  id bigserial primary key,
  empresa_integracao_id bigint null references empresa_integracoes(id) on delete set null,
  provider text not null,
  external_event_id text null,
  task_link_id bigint null references ml_external_task_links(id) on delete set null,
  task_id bigint null references ml_strategic_tasks(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz null,
  criado_em timestamptz not null default now(),
  constraint ck_ml_integration_events_provider
    check (provider ~ '^[a-z0-9_.-]+$')
);

create unique index if not exists ux_ml_integration_events_provider_event
  on ml_integration_events (provider, external_event_id)
  where external_event_id is not null and external_event_id <> '';

create index if not exists ix_ml_integration_events_task
  on ml_integration_events (task_id, provider, criado_em desc);

commit;
