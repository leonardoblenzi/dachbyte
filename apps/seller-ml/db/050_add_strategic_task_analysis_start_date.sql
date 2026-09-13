begin;

alter table if exists ml_strategic_task_batches
  add column if not exists analysis_start_date date;

alter table if exists ml_strategic_tasks
  add column if not exists analysis_start_date date;

update ml_strategic_task_batches b
   set analysis_start_date = t.first_analysis_start_date
  from (
    select task_batch_id,
           account_key,
           min(analysis_start_date) filter (where analysis_start_date is not null) as first_analysis_start_date
      from ml_strategic_tasks
     where task_batch_id is not null
     group by task_batch_id, account_key
  ) t
 where b.id = t.task_batch_id
   and b.account_key = t.account_key
   and b.analysis_start_date is null
   and t.first_analysis_start_date is not null;

create index if not exists ix_ml_strategic_task_batches_analysis_start
  on ml_strategic_task_batches (account_key, analysis_start_date);

create index if not exists ix_ml_strategic_tasks_analysis_start
  on ml_strategic_tasks (account_key, analysis_start_date);

commit;
