create table if not exists volt_core.roles (
  id text primary key,
  company_id text references volt_core.companies(id) on delete cascade,
  name text not null,
  description text,
  system_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, system_key)
);

create table if not exists volt_core.role_permissions (
  role_id text not null references volt_core.roles(id) on delete cascade,
  permission_key text not null,
  allowed boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_key)
);

create table if not exists volt_core.user_permission_overrides (
  user_id text not null references volt_core.users(id) on delete cascade,
  company_id text not null references volt_core.companies(id) on delete cascade,
  permission_key text not null,
  allowed boolean not null,
  reason text,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (user_id, company_id, permission_key)
);

create table if not exists volt_core.onboarding_checklists (
  company_id text primary key references volt_core.companies(id) on delete cascade,
  steps jsonb not null default '[]'::jsonb,
  completed_at timestamptz,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists volt_core.data_exchange_jobs (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  type text not null,
  entity text not null,
  status text not null default 'queued',
  filename text,
  total_rows integer not null default 0,
  processed_rows integer not null default 0,
  error_rows integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table volt_core.fiscal_documents
  add column if not exists external_id text,
  add column if not exists access_key text,
  add column if not exists provider text,
  add column if not exists issued_at timestamptz,
  add column if not exists canceled_at timestamptz;

create index if not exists idx_volt_core_audit_logs_company_action
  on volt_core.audit_logs(company_id, action, created_at desc);

create index if not exists idx_volt_core_data_exchange_jobs_company
  on volt_core.data_exchange_jobs(company_id, created_at desc);


insert into volt_core.roles (id, company_id, name, description, system_key)
values
  ('role_owner', null, 'Owner', 'Acesso total ao ambiente da empresa.', 'owner'),
  ('role_manager', null, 'Gerente', 'Gestao operacional, relatorios, caixa e configuracoes.', 'manager'),
  ('role_operator', null, 'Operador', 'PDV, clientes, consultas e rotinas basicas.', 'operator'),
  ('role_stock', null, 'Estoque', 'Produtos, inventario e movimentacoes.', 'stock'),
  ('role_finance', null, 'Financeiro', 'Caixa, recebiveis, despesas e relatorios financeiros.', 'finance')
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  system_key = excluded.system_key,
  updated_at = now();

insert into volt_core.role_permissions (role_id, permission_key, allowed)
values ('role_owner', '*', true)
on conflict (role_id, permission_key) do update set allowed = excluded.allowed;

insert into volt_core.role_permissions (role_id, permission_key, allowed)
select 'role_manager', permission_key, true
from (values
  ('dashboard:read'), ('customers:read'), ('customers:write'),
  ('products:read'), ('products:write'), ('inventory:read'), ('inventory:write'),
  ('sales:read'), ('sales:write'), ('payments:read'), ('payments:write'),
  ('receivables:read'), ('receivables:write'), ('cash_register:read'), ('cash_register:write'),
  ('receipts:read'), ('expenses:read'), ('expenses:write'),
  ('reports:read'), ('reports:export'), ('imports:write'),
  ('settings:read'), ('settings:write'),
  ('service_orders:read'), ('service_orders:write'),
  ('optical_prescriptions:read'), ('optical_prescriptions:write'),
  ('fiscal:read'), ('fiscal:write')
) as p(permission_key)
on conflict (role_id, permission_key) do update set allowed = excluded.allowed;

insert into volt_core.role_permissions (role_id, permission_key, allowed)
select 'role_operator', permission_key, true
from (values
  ('dashboard:read'), ('customers:read'), ('customers:write'),
  ('products:read'), ('inventory:read'), ('sales:read'), ('sales:write'),
  ('payments:read'), ('receivables:read'), ('cash_register:read'), ('cash_register:write'),
  ('receipts:read'), ('reports:read'), ('service_orders:read'), ('optical_prescriptions:read')
) as p(permission_key)
on conflict (role_id, permission_key) do update set allowed = excluded.allowed;

insert into volt_core.role_permissions (role_id, permission_key, allowed)
select 'role_stock', permission_key, true
from (values
  ('dashboard:read'), ('products:read'), ('products:write'),
  ('inventory:read'), ('inventory:write'), ('reports:read'), ('reports:export')
) as p(permission_key)
on conflict (role_id, permission_key) do update set allowed = excluded.allowed;

insert into volt_core.role_permissions (role_id, permission_key, allowed)
select 'role_finance', permission_key, true
from (values
  ('dashboard:read'), ('payments:read'), ('receivables:read'), ('receivables:write'),
  ('cash_register:read'), ('cash_register:write'), ('receipts:read'),
  ('expenses:read'), ('expenses:write'), ('reports:read'), ('reports:export'),
  ('fiscal:read'), ('audit:read')
) as p(permission_key)
on conflict (role_id, permission_key) do update set allowed = excluded.allowed;

update volt_core.user_companies
set permissions = case
      when lower(role) in ('admin', 'administrador', 'owner', 'dono') then '["*"]'::jsonb
      when lower(role) in ('manager', 'gerente') then '["dashboard:read","customers:read","customers:write","products:read","products:write","inventory:read","inventory:write","sales:read","sales:write","payments:read","payments:write","receivables:read","receivables:write","cash_register:read","cash_register:write","receipts:read","expenses:read","expenses:write","reports:read","reports:export","imports:write","settings:read","settings:write","service_orders:read","service_orders:write","optical_prescriptions:read","optical_prescriptions:write","fiscal:read","fiscal:write"]'::jsonb
      when lower(role) in ('stock', 'estoque') then '["dashboard:read","products:read","products:write","inventory:read","inventory:write","reports:read","reports:export"]'::jsonb
      when lower(role) in ('finance', 'financeiro') then '["dashboard:read","payments:read","receivables:read","receivables:write","cash_register:read","cash_register:write","receipts:read","expenses:read","expenses:write","reports:read","reports:export","fiscal:read","audit:read"]'::jsonb
      else '["dashboard:read","customers:read","customers:write","products:read","inventory:read","sales:read","sales:write","payments:read","receivables:read","cash_register:read","cash_register:write","receipts:read","reports:read","service_orders:read","optical_prescriptions:read"]'::jsonb
    end
where permissions = '[]'::jsonb;

update volt_core.user_companies
set screens = case
      when lower(role) in ('admin', 'administrador', 'owner', 'dono') then '["*"]'::jsonb
      when lower(role) in ('manager', 'gerente') then '["dashboard","sales","customers","products","inventory","payments","receivables","cash_register","receipts","finance","reports","settings","service_orders","optical_prescriptions","fiscal"]'::jsonb
      when lower(role) in ('stock', 'estoque') then '["dashboard","products","inventory","reports"]'::jsonb
      when lower(role) in ('finance', 'financeiro') then '["dashboard","payments","receivables","cash_register","receipts","finance","reports","fiscal"]'::jsonb
      else '["dashboard","sales","customers","products","inventory","receivables","cash_register","receipts","reports","service_orders","optical_prescriptions"]'::jsonb
    end
where screens = '[]'::jsonb;

update volt_core.company_configurations cfg
set screens = (
  select jsonb_agg(screen_key order by screen_key)
  from (
    select distinct screen_key
    from jsonb_array_elements_text(
      coalesce(cfg.screens, '[]'::jsonb)
      || '["dashboard","sales","customers","products","inventory","payments","receivables","cash_register","receipts","finance","fiscal","reports","settings","users"]'::jsonb
    ) as screen_keys(screen_key)
  ) normalized
);
