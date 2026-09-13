create table if not exists report_automations (
  id bigserial primary key,
  empresa_id bigint not null references empresas(id) on delete cascade,
  meli_conta_id bigint not null references meli_contas(id) on delete cascade,
  created_by_user_id bigint references usuarios(id) on delete set null,
  name text not null,
  report_type text not null default 'listing',
  base_status text not null default 'active',
  mlb_ids text[] null,
  enrichment text not null default 'none',
  period_type text not null default 'none',
  recipients_json jsonb not null default '[]'::jsonb,
  frequency text not null default 'daily',
  weekday smallint null,
  time_of_day time not null,
  timezone text not null default 'America/Sao_Paulo',
  next_run_at timestamptz null,
  active boolean not null default true,
  last_run_at timestamptz null,
  last_status text null,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint report_automations_report_type_check
    check (report_type in ('listing')),
  constraint report_automations_base_status_check
    check (base_status in ('active', 'paused', 'all', 'mlb_list')),
  constraint report_automations_enrichment_check
    check (enrichment in ('none', 'category', 'visits', 'ads', 'promos', 'variations')),
  constraint report_automations_period_type_check
    check (period_type in ('none', 'last_7_days', 'last_30_days', 'current_month', 'previous_month')),
  constraint report_automations_frequency_check
    check (frequency in ('daily', 'weekdays', 'weekly')),
  constraint report_automations_weekday_check
    check (weekday is null or weekday between 0 and 6),
  constraint report_automations_name_length_check
    check (char_length(trim(name)) between 3 and 120)
);

create index if not exists ix_report_automations_scope
  on report_automations (empresa_id, meli_conta_id, active);

create index if not exists ix_report_automations_due
  on report_automations (next_run_at)
  where active = true and next_run_at is not null;

create table if not exists report_automation_runs (
  id bigserial primary key,
  automation_id bigint not null references report_automations(id) on delete cascade,
  empresa_id bigint not null references empresas(id) on delete cascade,
  meli_conta_id bigint not null references meli_contas(id) on delete cascade,
  status text not null default 'scheduled',
  scheduled_for timestamptz not null default now(),
  started_at timestamptz null,
  finished_at timestamptz null,
  query_job_id text null,
  csv_job_id text null,
  csv_url text null,
  rows_count integer null,
  recipients_json jsonb not null default '[]'::jsonb,
  email_result_json jsonb not null default '{}'::jsonb,
  error_message text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint report_automation_runs_status_check
    check (status in (
      'scheduled',
      'queued',
      'running',
      'generating_csv',
      'sending_email',
      'sent',
      'failed',
      'skipped'
    ))
);

create index if not exists ix_report_automation_runs_automation
  on report_automation_runs (automation_id, created_at desc);

create index if not exists ix_report_automation_runs_scope
  on report_automation_runs (empresa_id, meli_conta_id, created_at desc);
