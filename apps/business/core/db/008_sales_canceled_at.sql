alter table volt_core.sales
  add column if not exists canceled_at timestamptz;

update volt_core.sales
   set canceled_at = coalesce(canceled_at, cancelled_at)
 where canceled_at is null
   and cancelled_at is not null;
