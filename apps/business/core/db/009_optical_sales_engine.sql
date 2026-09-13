alter table volt_core.sales
  add column if not exists notes text;

alter table volt_core.products
  add column if not exists optical_type text,
  add column if not exists optical_specs jsonb not null default '{}'::jsonb;

alter table volt_core.optical_prescriptions
  add column if not exists exam_date date,
  add column if not exists doctor_crm text,
  add column if not exists doctor_uf text,
  add column if not exists prescription_type text not null default 'distance',
  add column if not exists right_spherical numeric(7,2),
  add column if not exists right_cylindrical numeric(7,2),
  add column if not exists right_axis integer,
  add column if not exists right_addition numeric(7,2),
  add column if not exists right_prism numeric(7,2),
  add column if not exists right_base text,
  add column if not exists right_dnp numeric(7,2),
  add column if not exists right_height numeric(7,2),
  add column if not exists left_spherical numeric(7,2),
  add column if not exists left_cylindrical numeric(7,2),
  add column if not exists left_axis integer,
  add column if not exists left_addition numeric(7,2),
  add column if not exists left_prism numeric(7,2),
  add column if not exists left_base text,
  add column if not exists left_dnp numeric(7,2),
  add column if not exists left_height numeric(7,2),
  add column if not exists pupillary_distance numeric(7,2),
  add column if not exists visual_acuity_right text,
  add column if not exists visual_acuity_left text,
  add column if not exists notes text,
  add column if not exists attachment_url text;

create table if not exists volt_core.optical_laboratories (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  name text not null,
  document text,
  contact_name text,
  phone text,
  email text,
  default_lead_days integer not null default 7,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name)
);

create table if not exists volt_core.optical_orders (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  number integer not null,
  sale_id text not null references volt_core.sales(id) on delete restrict,
  customer_id text not null references volt_core.customers(id) on delete restrict,
  prescription_id text references volt_core.optical_prescriptions(id) on delete set null,
  service_order_id text references volt_core.service_orders(id) on delete set null,
  laboratory_id text references volt_core.optical_laboratories(id) on delete set null,
  frame_product_id text references volt_core.products(id) on delete set null,
  lens_product_id text references volt_core.products(id) on delete set null,
  status text not null default 'awaiting_lab',
  promised_date date,
  sent_to_lab_at timestamptz,
  received_from_lab_at timestamptz,
  ready_at timestamptz,
  delivered_at timestamptz,
  technical_measurements jsonb not null default '{}'::jsonb,
  lens_details jsonb not null default '{}'::jsonb,
  frame_details jsonb not null default '{}'::jsonb,
  quality_check jsonb not null default '{}'::jsonb,
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, number),
  unique (company_id, sale_id)
);

create index if not exists idx_volt_core_optical_orders_status
  on volt_core.optical_orders(company_id, status, promised_date);

alter table volt_core.service_orders
  add column if not exists sale_id text references volt_core.sales(id) on delete set null,
  add column if not exists prescription_id text references volt_core.optical_prescriptions(id) on delete set null,
  add column if not exists laboratory_id text references volt_core.optical_laboratories(id) on delete set null,
  add column if not exists optical_order_id text references volt_core.optical_orders(id) on delete set null;
