-- Ranking de anuncios: configuracao por conta (modo performance) e fotos mensais.
-- As fotos guardam o Top N de cada mes fechado, por faturamento e por quantidade,
-- com os totais do mes (para a participacao continuar correta).
-- As mesmas tabelas tambem sao garantidas em runtime por rankingRepository.

create table if not exists magalu.ranking_settings (
  account_id bigint primary key references magalu.accounts(id) on delete cascade,
  persist_enabled boolean not null default false,
  snapshot_limit integer not null default 30 check (snapshot_limit in (30, 50, 100)),
  updated_by_user_id text,
  updated_at timestamptz not null default now()
);

create table if not exists magalu.ranking_snapshots (
  id bigserial primary key,
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  ranking_type text not null check (ranking_type in ('faturamento', 'quantidade')),
  snapshot_limit integer not null,
  total_revenue numeric(18,2) not null default 0,
  total_units numeric(18,4) not null default 0,
  products_sold integer not null default 0,
  generated_at timestamptz not null default now(),
  constraint uq_magalu_ranking_snapshot unique (account_id, period_start, period_end, ranking_type)
);

create table if not exists magalu.ranking_snapshot_items (
  snapshot_id bigint not null references magalu.ranking_snapshots(id) on delete cascade,
  position integer not null,
  sku text not null,
  title text,
  brand text,
  image_url text,
  marketplace_url text,
  fulfillment boolean not null default false,
  units numeric(18,4) not null default 0,
  revenue numeric(18,2) not null default 0,
  orders integer not null default 0,
  primary key (snapshot_id, position)
);

create index if not exists idx_magalu_ranking_snapshots_account
  on magalu.ranking_snapshots (account_id, period_start desc);
