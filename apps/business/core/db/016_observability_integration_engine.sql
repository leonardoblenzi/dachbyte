-- Phase D: durable integration engine (accounts, mappings, jobs, webhooks and outbox).
-- Secrets are intentionally NOT stored here; integration_accounts keeps only credential_ref.

create table if not exists volt_core.integration_accounts (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  provider text not null,
  external_account_id text not null default 'default',
  display_name text not null,
  status text not null default 'active' check (status in ('active','disabled','error')),
  credential_ref text,
  config jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, provider, external_account_id),
  unique (company_id, id)
);

create table if not exists volt_core.integration_mappings (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  account_id text not null,
  entity_type text not null,
  internal_id text not null,
  external_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, account_id, entity_type, internal_id),
  unique (company_id, account_id, entity_type, external_id),
  foreign key (company_id, account_id)
    references volt_core.integration_accounts(company_id, id) on delete cascade
);

create table if not exists volt_core.integration_jobs (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  account_id text,
  type text not null,
  status text not null default 'queued'
    check (status in ('queued','processing','retrying','completed','dead_letter','canceled')),
  priority integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  idempotency_key text,
  correlation_id text,
  request_id text,
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts between 1 and 25),
  manual_retries integer not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  last_error_message text,
  completed_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, account_id)
    references volt_core.integration_accounts(company_id, id) on delete restrict
);
create unique index if not exists uq_volt_integration_jobs_idempotency
  on volt_core.integration_jobs(company_id, type, idempotency_key)
  where idempotency_key is not null;
create index if not exists idx_volt_integration_jobs_queue
  on volt_core.integration_jobs(status, available_at, priority desc, created_at)
  where status in ('queued','retrying');
create index if not exists idx_volt_integration_jobs_company_status
  on volt_core.integration_jobs(company_id, status, created_at desc);

create table if not exists volt_core.integration_job_attempts (
  id bigserial primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  job_id text not null,
  attempt integer not null,
  status text not null check (status in ('processing','completed','retrying','dead_letter')),
  worker_id text,
  duration_ms integer,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  foreign key (company_id, job_id)
    references volt_core.integration_jobs(company_id, id) on delete cascade
);
create index if not exists idx_volt_integration_job_attempts_job
  on volt_core.integration_job_attempts(company_id, job_id, attempt desc);

create table if not exists volt_core.integration_webhook_events (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  account_id text,
  provider text not null,
  external_event_id text not null,
  event_type text not null,
  status text not null default 'received'
    check (status in ('received','queued','processed','duplicate','rejected','failed')),
  payload jsonb not null default '{}'::jsonb,
  headers jsonb not null default '{}'::jsonb,
  job_id text,
  error_code text,
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  foreign key (company_id, account_id)
    references volt_core.integration_accounts(company_id, id) on delete restrict,
  foreign key (company_id, job_id)
    references volt_core.integration_jobs(company_id, id) on delete restrict
);
create unique index if not exists uq_volt_integration_webhook_event
  on volt_core.integration_webhook_events(company_id, provider, coalesce(account_id, ''), external_event_id);
create index if not exists idx_volt_integration_webhooks_company
  on volt_core.integration_webhook_events(company_id, received_at desc);

create table if not exists volt_core.integration_outbox_events (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  event_type text not null,
  aggregate_type text,
  aggregate_id text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending','processing','retrying','completed','dead_letter','canceled')),
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts between 1 and 25),
  idempotency_key text,
  correlation_id text,
  request_id text,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  last_error_message text,
  result jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create unique index if not exists uq_volt_outbox_idempotency
  on volt_core.integration_outbox_events(company_id, event_type, idempotency_key)
  where idempotency_key is not null;
create index if not exists idx_volt_outbox_queue
  on volt_core.integration_outbox_events(status, available_at, created_at)
  where status in ('pending','retrying');
create index if not exists idx_volt_outbox_company_status
  on volt_core.integration_outbox_events(company_id, status, created_at desc);

-- New tenant tables are fail-closed just like the rest of the runtime.
DO $$
DECLARE
  table_name text;
  tenant_tables text[] := ARRAY[
    'integration_accounts','integration_mappings','integration_jobs',
    'integration_job_attempts','integration_webhook_events','integration_outbox_events'
  ];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE volt_core.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE volt_core.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON volt_core.%I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON volt_core.%I USING (' ||
      'current_setting(''volt_core.bypass_rls'', true) = ''on'' OR ' ||
      'company_id = nullif(current_setting(''volt_core.company_id'', true), '''')' ||
      ') WITH CHECK (' ||
      'current_setting(''volt_core.bypass_rls'', true) = ''on'' OR ' ||
      'company_id = nullif(current_setting(''volt_core.company_id'', true), '''')' ||
      ')', table_name
    );
  END LOOP;
END $$;
