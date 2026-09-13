create schema if not exists volt_core;

create table if not exists volt_core.migrations (
  id bigserial primary key,
  filename text not null unique,
  applied_at timestamptz not null default now()
);

create table if not exists volt_core.companies (
  id text primary key,
  name text not null,
  document text,
  phone text,
  address text,
  segment_key text not null default 'general',
  plan_key text not null default 'starter',
  status text not null default 'active',
  timezone text not null default 'America/Sao_Paulo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists volt_core.company_configurations (
  company_id text primary key references volt_core.companies(id) on delete cascade,
  segment_key text not null,
  plan_key text not null default 'starter',
  modules jsonb not null default '[]'::jsonb,
  screens jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  overrides jsonb not null default '{}'::jsonb,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists volt_core.customers (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  number integer not null,
  name text not null,
  phone text,
  document text,
  email text,
  address text,
  notes text,
  active boolean not null default true,
  custom_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, number)
);

create index if not exists idx_volt_core_customers_company_name
  on volt_core.customers(company_id, lower(name));

create table if not exists volt_core.products (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  number integer not null,
  sku text,
  name text not null,
  category text not null default 'Produtos',
  type text not null default 'product',
  sale_price numeric(14,2) not null default 0,
  cost_price numeric(14,2) not null default 0,
  minimum_stock numeric(14,3) not null default 0,
  track_stock boolean not null default true,
  active boolean not null default true,
  custom_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, number),
  unique (company_id, sku)
);

create index if not exists idx_volt_core_products_company_name
  on volt_core.products(company_id, lower(name));

create table if not exists volt_core.inventory_movements (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  product_id text not null references volt_core.products(id) on delete restrict,
  type text not null,
  quantity numeric(14,3) not null,
  reason text not null,
  source_type text,
  source_id text,
  actor_user_id text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_volt_core_inventory_company_product
  on volt_core.inventory_movements(company_id, product_id, created_at desc);

create table if not exists volt_core.sales (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  number integer not null,
  customer_id text references volt_core.customers(id) on delete set null,
  status text not null default 'finalized',
  subtotal numeric(14,2) not null default 0,
  discount_total numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  payments jsonb not null default '[]'::jsonb,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, number)
);

create table if not exists volt_core.sale_items (
  id text primary key,
  sale_id text not null references volt_core.sales(id) on delete cascade,
  product_id text references volt_core.products(id) on delete set null,
  description text not null,
  quantity numeric(14,3) not null,
  unit_price numeric(14,2) not null,
  discount numeric(14,2) not null default 0,
  total numeric(14,2) not null
);

create table if not exists volt_core.cash_sessions (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  number integer not null,
  status text not null default 'open',
  opening_amount numeric(14,2) not null default 0,
  expected_amount numeric(14,2) not null default 0,
  counted_amount numeric(14,2),
  difference_amount numeric(14,2),
  opened_by text,
  closed_by text,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  notes text,
  unique (company_id, number)
);

create table if not exists volt_core.cash_movements (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  session_id text references volt_core.cash_sessions(id) on delete set null,
  type text not null,
  source_type text not null default 'manual',
  source_id text,
  payment_method text,
  amount numeric(14,2) not null,
  description text not null,
  actor_user_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_volt_core_cash_movements_company
  on volt_core.cash_movements(company_id, created_at desc);

create table if not exists volt_core.receivables (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  customer_id text references volt_core.customers(id) on delete set null,
  sale_id text references volt_core.sales(id) on delete set null,
  type text not null default 'credit',
  status text not null default 'open',
  due_date date not null,
  amount numeric(14,2) not null,
  paid_amount numeric(14,2) not null default 0,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_volt_core_receivables_company_status_due
  on volt_core.receivables(company_id, status, due_date);

create table if not exists volt_core.receipts (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  sale_id text references volt_core.sales(id) on delete set null,
  number integer not null,
  html text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (company_id, number)
);

create table if not exists volt_core.audit_logs (
  id bigserial primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  actor_user_id text,
  action text not null,
  entity_type text,
  entity_id text,
  before_payload jsonb,
  after_payload jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists volt_core.events (
  id bigserial primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
