begin;

alter table if exists ml_strategic_rounds
  add column if not exists source_task_id bigint references ml_strategic_tasks(id) on delete set null,
  add column if not exists task_batch_id text,
  add column if not exists task_batch_name text;

create index if not exists ix_ml_strategic_rounds_source_task
  on ml_strategic_rounds (account_key, source_task_id, created_at desc);

create index if not exists ix_ml_strategic_rounds_task_batch
  on ml_strategic_rounds (account_key, task_batch_id, created_at desc);

commit;
