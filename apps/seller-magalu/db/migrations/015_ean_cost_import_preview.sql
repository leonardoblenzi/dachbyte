create table if not exists magalu.ean_cost_import_previews (
  id uuid primary key,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  created_by text,
  rows jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  used_at timestamptz
);
create index if not exists ean_cost_import_previews_expiry_idx
  on magalu.ean_cost_import_previews(expires_at);
