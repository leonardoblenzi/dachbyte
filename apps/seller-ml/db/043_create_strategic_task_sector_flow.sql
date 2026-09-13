begin;

alter table if exists ml_strategic_tasks
  add column if not exists canceled_by_user_id bigint references usuarios(id) on delete set null,
  add column if not exists canceled_at timestamptz,
  add column if not exists cancel_reason text;

create table if not exists ml_strategic_task_sectors (
  id bigserial primary key,
  task_id bigint not null references ml_strategic_tasks(id) on delete cascade,
  setor text not null,
  label text not null,
  status text not null default 'pending',
  assigned_user_id bigint references usuarios(id) on delete set null,
  assigned_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ux_ml_strategic_task_sectors_task_setor unique (task_id, setor),
  constraint ck_ml_strategic_task_sectors_status check (status in ('pending','in_progress','review','completed','canceled'))
);

create index if not exists ix_ml_strategic_task_sectors_task
  on ml_strategic_task_sectors (task_id, status);

create index if not exists ix_ml_strategic_task_sectors_assigned
  on ml_strategic_task_sectors (assigned_user_id, status);

create table if not exists ml_strategic_task_sector_events (
  id bigserial primary key,
  task_id bigint not null references ml_strategic_tasks(id) on delete cascade,
  setor text,
  user_id bigint references usuarios(id) on delete set null,
  action text not null,
  note text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ix_ml_strategic_task_sector_events_task
  on ml_strategic_task_sector_events (task_id, created_at desc);

insert into ml_strategic_task_sectors (task_id, setor, label, status, assigned_user_id, assigned_at, completed_at)
select
  t.id,
  'marketing',
  'Marketing',
  case
    when t.status = 'completed' then 'completed'
    when t.status = 'canceled' then 'canceled'
    when t.status = 'review' then 'review'
    when t.status = 'in_progress' then 'in_progress'
    else 'pending'
  end,
  t.assigned_to_user_id,
  t.started_at,
  case when t.status = 'completed' then t.completed_at else null end
from ml_strategic_tasks t
where coalesce(t.task_flags ->> 'photo', 'false') = 'true'
   or coalesce(t.task_flags ->> 'clips', 'false') = 'true'
   or exists (
     select 1
       from jsonb_array_elements(coalesce(t.execution_payload -> 'entries', '[]'::jsonb)) entry
      where coalesce(entry -> 'materials_created' ->> 'photos', 'false') = 'true'
         or coalesce(entry -> 'materials_created' ->> 'clips_video', 'false') = 'true'
   )
on conflict (task_id, setor) do nothing;

insert into ml_strategic_task_sectors (task_id, setor, label, status, assigned_user_id, assigned_at, completed_at)
select
  t.id,
  'cadastro',
  'Cadastro',
  case
    when t.status = 'completed' then 'completed'
    when t.status = 'canceled' then 'canceled'
    when t.status = 'review' then 'review'
    when t.status = 'in_progress' then 'in_progress'
    else 'pending'
  end,
  t.assigned_to_user_id,
  t.started_at,
  case when t.status = 'completed' then t.completed_at else null end
from ml_strategic_tasks t
where coalesce(t.task_flags ->> 'title', 'false') = 'true'
   or coalesce(t.task_flags ->> 'description', 'false') = 'true'
   or coalesce(t.task_flags ->> 'attributes', 'false') = 'true'
   or coalesce(t.task_flags ->> 'model', 'false') = 'true'
   or coalesce(t.task_flags ->> 'lead_time', 'false') = 'true'
   or coalesce(t.task_flags ->> 'price', 'false') = 'true'
   or coalesce(t.task_flags ->> 'stock', 'false') = 'true'
   or coalesce(t.task_flags ->> 'promotion', 'false') = 'true'
   or coalesce(t.task_flags ->> 'ads', 'false') = 'true'
   or coalesce(t.task_flags ->> 'shipping', 'false') = 'true'
   or coalesce(t.task_flags ->> 'other', 'false') = 'true'
   or exists (
     select 1
       from jsonb_array_elements(coalesce(t.execution_payload -> 'entries', '[]'::jsonb)) entry
      where entry ? 'listing_changes'
        and entry -> 'listing_changes' <> '{}'::jsonb
   )
on conflict (task_id, setor) do nothing;

insert into ml_strategic_task_sectors (task_id, setor, label, status, assigned_user_id, assigned_at, completed_at)
select
  t.id,
  'cadastro',
  'Cadastro',
  case
    when t.status = 'completed' then 'completed'
    when t.status = 'canceled' then 'canceled'
    when t.status = 'review' then 'review'
    when t.status = 'in_progress' then 'in_progress'
    else 'pending'
  end,
  t.assigned_to_user_id,
  t.started_at,
  case when t.status = 'completed' then t.completed_at else null end
from ml_strategic_tasks t
where not exists (
  select 1
    from ml_strategic_task_sectors s
   where s.task_id = t.id
)
on conflict (task_id, setor) do nothing;

commit;
