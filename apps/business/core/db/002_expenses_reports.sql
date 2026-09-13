create table if not exists volt_core.expenses (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  number integer not null,
  name text not null,
  category text not null default 'Operacional',
  supplier text,
  due_date date not null,
  amount numeric(14,2) not null,
  paid_amount numeric(14,2) not null default 0,
  remaining_amount numeric(14,2) not null default 0,
  status text not null default 'open',
  payment_method text,
  paid_at timestamptz,
  canceled_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, number)
);

create index if not exists idx_volt_core_expenses_company_status_due
  on volt_core.expenses(company_id, status, due_date);

create index if not exists idx_volt_core_expenses_company_category
  on volt_core.expenses(company_id, category);
