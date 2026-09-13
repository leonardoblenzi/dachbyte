begin;

alter table if exists ml_strategic_tasks
  add column if not exists execution_payload jsonb not null default '{"entries":[]}'::jsonb;

alter table if exists ml_strategic_tasks
  add column if not exists task_batch_id text,
  add column if not exists task_batch_name text,
  add column if not exists task_batch_created_at timestamptz;

update ml_strategic_tasks
   set execution_payload = '{"entries":[]}'::jsonb
 where execution_payload is null;

create index if not exists ix_ml_strategic_tasks_account_batch
  on ml_strategic_tasks (account_key, task_batch_id, status, created_at desc);

commit;
