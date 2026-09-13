create table if not exists ml_strategic_round_task_reviews (
  id bigserial primary key,
  round_id bigint not null references ml_strategic_rounds(id) on delete cascade,
  task_id bigint null references ml_strategic_tasks(id) on delete set null,
  account_key text not null,
  mlb text not null,
  reopen_flags jsonb not null default '{}'::jsonb,
  reason text,
  status text not null default 'open',
  requested_by_user_id bigint null references usuarios(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_ml_strategic_round_task_reviews_status check (status in ('open', 'resolved', 'canceled'))
);

create index if not exists ix_ml_strategic_round_task_reviews_round_status
  on ml_strategic_round_task_reviews (round_id, status, created_at desc);

create index if not exists ix_ml_strategic_round_task_reviews_task_status
  on ml_strategic_round_task_reviews (task_id, status, created_at desc);

create index if not exists ix_ml_strategic_round_task_reviews_account_mlb
  on ml_strategic_round_task_reviews (account_key, mlb, status, created_at desc);
