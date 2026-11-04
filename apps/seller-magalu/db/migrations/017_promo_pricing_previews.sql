create table if not exists magalu.promo_pricing_previews (
  id uuid primary key,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  dach_tenant_id text not null,
  dach_user_id text not null,
  filters jsonb not null,
  terms jsonb not null,
  total_count integer not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now()+interval '2 hours')
);
create table if not exists magalu.promo_pricing_preview_rows (
  preview_id uuid not null references magalu.promo_pricing_previews(id) on delete cascade,
  sku text not null,
  source jsonb not null,
  terms_override jsonb not null default '{}'::jsonb,
  price_override numeric(18,2),
  result jsonb not null,
  primary key(preview_id,sku)
);
create index if not exists promo_pricing_previews_owner_idx on magalu.promo_pricing_previews(account_id,dach_tenant_id,dach_user_id,expires_at);
