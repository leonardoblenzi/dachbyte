begin;

create table if not exists ml_strategic_task_batches (
  id text primary key,
  account_key text not null,
  name text not null,
  status text not null default 'active',
  priority text not null default 'medium',
  due_date date,
  group_id bigint references ml_strategic_groups(id) on delete set null,
  created_by_user_id bigint references usuarios(id) on delete set null,
  archived_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_ml_strategic_task_batches_status check (status in ('active', 'archived', 'canceled')),
  constraint ck_ml_strategic_task_batches_priority check (priority in ('low', 'medium', 'high'))
);

insert into ml_strategic_task_batches
  (id, account_key, name, status, priority, due_date, group_id, created_by_user_id, created_at, updated_at)
select
  t.task_batch_id,
  t.account_key,
  coalesce(max(t.task_batch_name), 'Lote de tarefas') as name,
  case
    when count(*) filter (where t.status in ('pending','in_progress','review')) > 0 then 'active'
    else 'archived'
  end as status,
  coalesce((array_agg(t.priority order by case t.priority when 'high' then 0 when 'medium' then 1 else 2 end))[1], 'medium') as priority,
  min(t.due_date) filter (where t.status in ('pending','in_progress','review')) as due_date,
  (array_agg(t.group_id order by t.created_at asc))[1] as group_id,
  (array_agg(t.created_by_user_id order by t.created_at asc))[1] as created_by_user_id,
  min(coalesce(t.task_batch_created_at, t.created_at)) as created_at,
  max(t.updated_at) as updated_at
from ml_strategic_tasks t
where t.task_batch_id is not null
group by t.account_key, t.task_batch_id
on conflict (id) do update set
  name = excluded.name,
  priority = excluded.priority,
  due_date = excluded.due_date,
  group_id = excluded.group_id,
  updated_at = excluded.updated_at;

create index if not exists ix_ml_strategic_task_batches_account_status
  on ml_strategic_task_batches (account_key, status, updated_at desc);

create index if not exists ix_ml_strategic_task_batches_group
  on ml_strategic_task_batches (account_key, group_id, created_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'fk_ml_strategic_tasks_batch'
  ) then
    alter table ml_strategic_tasks
      add constraint fk_ml_strategic_tasks_batch
      foreign key (task_batch_id)
      references ml_strategic_task_batches(id)
      on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'fk_ml_strategic_rounds_batch'
  ) then
    alter table ml_strategic_rounds
      add constraint fk_ml_strategic_rounds_batch
      foreign key (task_batch_id)
      references ml_strategic_task_batches(id)
      on delete set null;
  end if;
end $$;

commit;
