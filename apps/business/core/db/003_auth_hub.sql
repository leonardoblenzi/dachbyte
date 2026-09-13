alter table volt_core.companies
  add column if not exists tenant_global_id text,
  add column if not exists document_type text,
  add column if not exists document_number text;

create unique index if not exists idx_volt_core_companies_tenant_global_id
  on volt_core.companies(tenant_global_id)
  where tenant_global_id is not null;

create table if not exists volt_core.users (
  id text primary key,
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null default 'operator',
  status text not null default 'active',
  user_global_id text,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_volt_core_users_user_global_id
  on volt_core.users(user_global_id)
  where user_global_id is not null;

create table if not exists volt_core.user_companies (
  user_id text not null references volt_core.users(id) on delete cascade,
  company_id text not null references volt_core.companies(id) on delete cascade,
  role text not null default 'operator',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, company_id)
);

create index if not exists idx_volt_core_user_companies_company
  on volt_core.user_companies(company_id);

create table if not exists volt_core.hub_access_cache (
  id bigserial primary key,
  user_id text not null references volt_core.users(id) on delete cascade,
  company_id text references volt_core.companies(id) on delete cascade,
  module text not null,
  allow boolean not null default false,
  reason text,
  hub_status text,
  checked_at timestamptz not null default now(),
  expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (user_id, company_id, module)
);
