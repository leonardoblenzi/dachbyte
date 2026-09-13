create table if not exists automation_job_settings (
  job_key text primary key,
  enabled boolean not null default true,
  cron_expression text null,
  periods text[] null,
  account_ids bigint[] null,
  exclude_account_ids bigint[] null,
  include_inactive boolean not null default false,
  concurrency smallint not null default 1
    constraint automation_job_settings_concurrency_check check (concurrency between 1 and 6),
  limit_accounts integer not null default 0
    constraint automation_job_settings_limit_check check (limit_accounts between 0 and 5000),
  fail_on_partial boolean not null default false,
  params_json jsonb not null default '{}'::jsonb,
  updated_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_automation_job_settings_enabled
  on automation_job_settings (enabled);

