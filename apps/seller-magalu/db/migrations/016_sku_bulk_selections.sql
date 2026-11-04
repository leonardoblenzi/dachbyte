create table if not exists magalu.sku_bulk_selections (
  id uuid primary key,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  dach_tenant_id text not null,
  dach_user_id text not null,
  search_type text not null check (search_type in ('sku','ean','group')),
  status_filter text,
  active_filter boolean,
  state text not null default 'building' check (state in ('building','ready')),
  identifier_count integer not null default 0,
  matched_count integer not null default 0,
  missing_count integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours')
);
create table if not exists magalu.sku_bulk_identifiers (
  selection_id uuid not null references magalu.sku_bulk_selections(id) on delete cascade,
  identifier text not null,
  primary key(selection_id,identifier)
);
create unique index if not exists sku_bulk_identifiers_folded_idx on magalu.sku_bulk_identifiers(selection_id,lower(identifier));
create table if not exists magalu.sku_bulk_matches (
  selection_id uuid not null references magalu.sku_bulk_selections(id) on delete cascade,
  sku text not null,
  primary key(selection_id,sku)
);
create table if not exists magalu.sku_bulk_found_identifiers (
  selection_id uuid not null references magalu.sku_bulk_selections(id) on delete cascade,
  identifier text not null,
  primary key(selection_id,identifier)
);
create index if not exists sku_bulk_matches_page_idx on magalu.sku_bulk_matches(selection_id,sku);
create table if not exists magalu.sku_bulk_groups (
  id uuid primary key,
  selection_id uuid references magalu.sku_bulk_selections(id) on delete set null,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  dach_tenant_id text not null,
  dach_user_id text not null,
  action text not null check (action in ('activate','deactivate')),
  preview_ids uuid[] not null,
  total_count integer not null check (total_count > 0),
  status text not null default 'prepared' check (status in ('prepared','queued','running','enqueued','failed')),
  error_message text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  applied_at timestamptz
);
alter table magalu.mass_operation_batches add column if not exists group_id uuid references magalu.sku_bulk_groups(id) on delete set null;
create index if not exists mass_operation_batches_group_idx on magalu.mass_operation_batches(group_id);
