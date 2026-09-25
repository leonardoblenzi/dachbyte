-- DACHBYTE Seller · Magalu · Etapa 4
-- Auditoria V2 + políticas de retenção + histórico de manutenção.

alter table magalu.audit_events
  add column if not exists event_key text,
  add column if not exists category text,
  add column if not exists severity text,
  add column if not exists outcome text,
  add column if not exists magalu_tenant_id text,
  add column if not exists batch_id text,
  add column if not exists request_id text,
  add column if not exists source text;

update magalu.audit_events e
   set event_key = coalesce(nullif(e.event_key,''), lower(regexp_replace(coalesce(e.action,'event'), '[^a-zA-Z0-9]+', '_', 'g'))),
       category = coalesce(nullif(e.category,''),
         case
           when upper(coalesce(e.action,'')) like 'MASTER_%' then 'admin'
           when upper(coalesce(e.action,'')) like 'WRITE_%' then 'write'
           when upper(coalesce(e.action,'')) like 'ACCOUNT_%' then 'account'
           when upper(coalesce(e.action,'')) like '%OAUTH%' then 'oauth'
           when upper(coalesce(e.action,'')) like '%SYNC%' then 'sync'
           when upper(coalesce(e.action,'')) like '%WEBHOOK%' then 'webhook'
           else 'normal'
         end),
       severity = coalesce(nullif(e.severity,''),
         case
           when upper(coalesce(e.action,'')) like '%FAILED%' then 'error'
           when upper(coalesce(e.action,'')) like '%UNCERTAIN%' or upper(coalesce(e.action,'')) like '%DIVERGENT%' then 'warning'
           else 'info'
         end),
       outcome = coalesce(nullif(e.outcome,''),
         case
           when upper(coalesce(e.action,'')) like '%UNCERTAIN%' then 'uncertain'
           when upper(coalesce(e.action,'')) like '%DIVERGENT%' then 'divergent'
           when upper(coalesce(e.action,'')) like '%FAILED%' then 'failure'
           when upper(coalesce(e.action,'')) like '%STALE%' then 'stale'
           when upper(coalesce(e.action,'')) like '%SUCCEEDED%' or upper(coalesce(e.action,'')) like '%VERIFIED%' or upper(coalesce(e.action,'')) like '%ACCEPTED%' then 'success'
           else 'info'
         end),
       magalu_tenant_id = coalesce(nullif(e.magalu_tenant_id,''), a.magalu_tenant_id),
       request_id = coalesce(nullif(e.request_id,''), nullif(e.details->>'request_id','')),
       source = coalesce(nullif(e.source,''), 'seller-magalu')
  from magalu.accounts a
 where e.account_id = a.id;

update magalu.audit_events e
   set batch_id = coalesce(nullif(e.batch_id,''), w.preview_id::text),
       request_id = coalesce(nullif(e.request_id,''), w.request_id)
  from magalu.write_operations w
 where e.operation_id = w.id;

update magalu.audit_events e
   set event_key = coalesce(nullif(e.event_key,''), lower(regexp_replace(coalesce(e.action,'event'), '[^a-zA-Z0-9]+', '_', 'g'))),
       category = coalesce(nullif(e.category,''), 'normal'),
       severity = coalesce(nullif(e.severity,''), 'info'),
       outcome = coalesce(nullif(e.outcome,''), 'info'),
       source = coalesce(nullif(e.source,''), 'seller-magalu')
 where e.event_key is null or e.category is null or e.severity is null or e.outcome is null or e.source is null;

alter table magalu.audit_events
  alter column event_key set not null,
  alter column category set not null,
  alter column severity set not null,
  alter column outcome set not null,
  alter column source set not null;

create index if not exists idx_magalu_audit_created on magalu.audit_events(created_at desc);
create index if not exists idx_magalu_audit_event_key on magalu.audit_events(event_key, created_at desc);
create index if not exists idx_magalu_audit_category on magalu.audit_events(category, created_at desc);
create index if not exists idx_magalu_audit_outcome on magalu.audit_events(outcome, created_at desc);
create index if not exists idx_magalu_audit_tenant on magalu.audit_events(dach_tenant_id, created_at desc);
create index if not exists idx_magalu_audit_request on magalu.audit_events(request_id) where request_id is not null;
create index if not exists idx_magalu_audit_batch on magalu.audit_events(batch_id) where batch_id is not null;

create table if not exists magalu.audit_retention_rules (
  rule_key text primary key,
  category text,
  severity text,
  outcome text,
  event_key text,
  retention_days integer not null,
  min_days integer not null,
  max_days integer not null,
  priority integer not null default 0,
  enabled boolean not null default true,
  description text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_magalu_audit_retention_days check (retention_days between 1 and 90),
  constraint ck_magalu_audit_retention_bounds check (min_days between 1 and 90 and max_days between 1 and 90 and min_days <= max_days and retention_days between min_days and max_days)
);

insert into magalu.audit_retention_rules(rule_key, category, severity, outcome, event_key, retention_days, min_days, max_days, priority, description)
values
  ('critical', null, 'critical', null, null, 90, 90, 90, 100, 'Eventos críticos: retenção fixa de 90 dias.'),
  ('uncertain', null, null, 'uncertain', null, 90, 90, 90, 95, 'Operações com resultado remoto incerto: 90 dias.'),
  ('divergent', null, null, 'divergent', null, 90, 90, 90, 95, 'Operações divergentes: 90 dias.'),
  ('admin', 'admin', null, null, null, 90, 90, 90, 90, 'Ações administrativas: retenção fixa de 90 dias.'),
  ('failure', null, null, 'failure', null, 60, 30, 60, 80, 'Falhas operacionais: configurável entre 30 e 60 dias.'),
  ('default', null, null, null, null, 30, 15, 30, 0, 'Eventos comuns: configurável entre 15 e 30 dias.')
on conflict (rule_key) do nothing;

create table if not exists magalu.audit_maintenance_runs (
  id bigserial primary key,
  run_mode text not null check (run_mode in ('scheduled','manual','dry_run')),
  status text not null default 'running' check (status in ('running','success','failed')),
  actor_user_id text,
  scanned_count integer not null default 0,
  eligible_count integer not null default 0,
  deleted_count integer not null default 0,
  summary jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_magalu_audit_maintenance_runs_created on magalu.audit_maintenance_runs(created_at desc);

-- Top-level scrub defensivo de chaves historicamente sensíveis. Novos eventos passam pelo sanitizer central em Node.
update magalu.audit_events
   set details = details
      - 'access_token' - 'refresh_token' - 'client_secret' - 'authorization'
      - 'cookie' - 'password' - 'pkce_verifier' - 'access_token_ciphertext'
      - 'refresh_token_ciphertext' - 'secret_ciphertext'
 where details ?| array['access_token','refresh_token','client_secret','authorization','cookie','password','pkce_verifier','access_token_ciphertext','refresh_token_ciphertext','secret_ciphertext'];
