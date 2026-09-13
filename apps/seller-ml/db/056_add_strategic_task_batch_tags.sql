begin;

alter table if exists ml_strategic_task_batches
  add column if not exists tags text[] not null default '{}'::text[];

alter table if exists ml_strategic_task_batches
  add column if not exists tag_colors jsonb not null default '{}'::jsonb;

update ml_strategic_task_batches
   set tags = coalesce(tags, '{}'::text[]),
       tag_colors = case
         when jsonb_typeof(tag_colors) = 'object' then tag_colors
         else '{}'::jsonb
       end;

create index if not exists ix_ml_strategic_task_batches_tags_gin
  on ml_strategic_task_batches using gin (tags);

commit;
