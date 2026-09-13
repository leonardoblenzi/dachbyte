-- Suggested Davantti Log schema.
-- These tables mirror the product documentation and are intentionally isolated
-- from the demo API until the production database migration is approved.

create table if not exists log_reconciliation_batches (
  id uuid primary key,
  company_id text not null,
  account_id text,
  start_date date not null,
  end_date date not null,
  status text not null,
  source text not null,
  total_orders integer not null default 0,
  total_carrier_amount numeric(14,2) not null default 0,
  total_tms_amount numeric(14,2) not null default 0,
  total_customer_amount numeric(14,2) not null default 0,
  total_davantti_expected_amount numeric(14,2) not null default 0,
  total_difference numeric(14,2) not null default 0,
  created_by text not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists log_reconciliation_items (
  id uuid primary key,
  batch_id uuid references log_reconciliation_batches(id),
  company_id text not null,
  account_id text,
  order_id text not null,
  marketplace_order_number text,
  intelipost_order_number text,
  sales_channel text,
  carrier_id text,
  delivery_method_id text,
  tracking_code text,
  invoice_key text,
  cte_key text,
  customer_paid_shipping_amount numeric(14,2),
  tms_expected_amount numeric(14,2),
  carrier_charged_amount numeric(14,2),
  davantti_expected_amount numeric(14,2),
  tms_difference_amount numeric(14,2),
  davantti_difference_amount numeric(14,2),
  freight_margin_amount numeric(14,2),
  status text not null,
  applied_rule_snapshot jsonb not null default '{}'::jsonb,
  tolerance_snapshot jsonb not null default '{}'::jsonb,
  source_payload_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_log_reconciliation_items_company_batch
  on log_reconciliation_items (company_id, batch_id);

create index if not exists idx_log_reconciliation_items_company_order
  on log_reconciliation_items (company_id, order_id);

create index if not exists idx_log_reconciliation_items_company_invoice
  on log_reconciliation_items (company_id, invoice_key);

create index if not exists idx_log_reconciliation_items_company_status
  on log_reconciliation_items (company_id, status);

create table if not exists log_billing_rules (
  id uuid primary key,
  company_id text not null,
  name text not null,
  description text,
  active boolean not null default true,
  priority integer not null default 100,
  rule_type text not null,
  operation text not null,
  value_type text not null,
  value numeric(14,4),
  start_date date,
  end_date date,
  conditions_json jsonb not null default '{}'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_log_billing_rules_company_active
  on log_billing_rules (company_id, active, priority);

create table if not exists log_rule_nodes (
  id uuid primary key,
  company_id text not null,
  rule_id uuid references log_billing_rules(id),
  parent_node_id uuid references log_rule_nodes(id),
  node_type text not null,
  label text not null,
  config_json jsonb not null default '{}'::jsonb,
  position_x numeric(10,2) not null default 0,
  position_y numeric(10,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_log_rule_nodes_company_rule
  on log_rule_nodes (company_id, rule_id);

create table if not exists log_import_files (
  id uuid primary key,
  company_id text not null,
  file_name text not null,
  file_type text not null,
  file_hash text not null,
  source text not null,
  status text not null,
  total_rows integer not null default 0,
  processed_rows integer not null default 0,
  error_rows integer not null default 0,
  mapping_json jsonb not null default '{}'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (company_id, file_hash)
);

create index if not exists idx_log_import_files_company_status
  on log_import_files (company_id, status);

create table if not exists log_intelipost_integrations (
  id uuid primary key,
  company_id text not null,
  account_id text,
  client_id text,
  api_key_secret_ref text,
  api_key_ciphertext text,
  rest_base_url text not null default 'https://api.intelipost.com.br/api/v1',
  tracking_graphql_url text not null default 'https://tracking-graphql.intelipost.com.br/',
  shipment_search_path text not null default '/shipment_order',
  sync_enabled boolean not null default false,
  last_sync_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, account_id)
);

create table if not exists log_intelipost_sync_runs (
  id uuid primary key,
  company_id text not null,
  account_id text,
  sync_type text not null,
  status text not null,
  parameters_json jsonb not null default '{}'::jsonb,
  processed_rows integer not null default 0,
  success_rows integer not null default 0,
  error_rows integer not null default 0,
  errors_json jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_by text not null
);

create index if not exists idx_log_intelipost_sync_runs_company_started
  on log_intelipost_sync_runs (company_id, started_at desc);

create table if not exists log_reconciliation_actions (
  id uuid primary key,
  item_id uuid references log_reconciliation_items(id),
  action_type text not null,
  old_status text,
  new_status text,
  reason text,
  notes text,
  amount_before numeric(14,2),
  amount_after numeric(14,2),
  created_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_log_reconciliation_actions_item_created
  on log_reconciliation_actions (item_id, created_at desc);
