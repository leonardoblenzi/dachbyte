create table if not exists ml_strategic_watchlist (
  id bigserial primary key,
  item_id bigint null references ml_strategic_items(id) on delete set null,
  account_key text not null,
  account_label text,
  seller_id text,
  mlb text not null,
  sku text,
  title_snapshot text,
  thumbnail_snapshot text,
  reason text,
  notes text,
  status text not null default 'tracking',
  base_metrics jsonb not null default '{}'::jsonb,
  action_flags jsonb not null default '{}'::jsonb,
  last_action_at timestamptz,
  created_by_user_id bigint null references usuarios(id) on delete set null,
  removed_by_user_id bigint null references usuarios(id) on delete set null,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_ml_strategic_watchlist_status check (status in ('tracking', 'no_action', 'action_registered', 'task_open', 'analysis', 'improved', 'worse', 'inconclusive', 'removed'))
);

create unique index if not exists ux_ml_strategic_watchlist_active_account_mlb
  on ml_strategic_watchlist (account_key, mlb)
  where status <> 'removed';

create index if not exists ix_ml_strategic_watchlist_account_status
  on ml_strategic_watchlist (account_key, status, updated_at desc);

create table if not exists ml_strategic_watchlist_events (
  id bigserial primary key,
  watchlist_id bigint not null references ml_strategic_watchlist(id) on delete cascade,
  account_key text not null,
  mlb text not null,
  event_type text not null,
  action_flags jsonb not null default '{}'::jsonb,
  hypothesis text,
  notes text,
  primary_metric text,
  window_days int,
  occurred_on date,
  source_task_id bigint null references ml_strategic_tasks(id) on delete set null,
  source_round_id bigint null references ml_strategic_rounds(id) on delete set null,
  created_by_user_id bigint null references usuarios(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ix_ml_strategic_watchlist_events_watchlist
  on ml_strategic_watchlist_events (watchlist_id, created_at desc);

create index if not exists ix_ml_strategic_watchlist_events_account_mlb
  on ml_strategic_watchlist_events (account_key, mlb, created_at desc);
