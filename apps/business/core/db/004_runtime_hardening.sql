create table if not exists volt_core.operational_counters (
  company_id text not null references volt_core.companies(id) on delete cascade,
  counter_key text not null,
  current_value integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (company_id, counter_key)
);

create table if not exists volt_core.payment_methods (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  name text not null,
  method_key text not null,
  kind text not null default 'immediate',
  fee numeric(8,4) not null default 0,
  settlement_days integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, method_key)
);

create table if not exists volt_core.service_orders (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  number integer not null,
  customer_id text references volt_core.customers(id) on delete set null,
  service text,
  owner_name text,
  due_date date,
  status text not null default 'open',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, number)
);

create table if not exists volt_core.optical_prescriptions (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  customer_id text references volt_core.customers(id) on delete set null,
  doctor text,
  right_eye text,
  left_eye text,
  valid_until date,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists volt_core.fiscal_documents (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  sale_id text references volt_core.sales(id) on delete set null,
  customer_id text references volt_core.customers(id) on delete set null,
  model text not null,
  status text not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_volt_core_service_orders_company_status
  on volt_core.service_orders(company_id, status, due_date);

create index if not exists idx_volt_core_prescriptions_company_customer
  on volt_core.optical_prescriptions(company_id, customer_id, created_at desc);

create index if not exists idx_volt_core_fiscal_company_status
  on volt_core.fiscal_documents(company_id, status, created_at desc);
