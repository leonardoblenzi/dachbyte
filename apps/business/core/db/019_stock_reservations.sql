-- Stock reservations for future-fulfillment sales.
-- Reservations are commitments, not physical inventory movements.

create table if not exists volt_core.stock_reservations (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  product_id text not null references volt_core.products(id) on delete restrict,
  sale_id text not null references volt_core.sales(id) on delete cascade,
  quantity numeric(14,3) not null check (quantity > 0),
  status text not null default 'active' check (status in ('active','consumed','released')),
  reserved_at timestamptz not null default now(),
  released_at timestamptz,
  release_reason text,
  actor_user_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, sale_id, product_id)
);

create index if not exists idx_volt_core_stock_reservations_company_product_active
  on volt_core.stock_reservations(company_id, product_id, status, reserved_at desc);
create index if not exists idx_volt_core_stock_reservations_company_sale
  on volt_core.stock_reservations(company_id, sale_id, status);

-- Existing pending-delivery sales in older versions already produced an inventory
-- exit. Restore that physical quantity and reclassify the historical exit before
-- creating the active reservation, so delivery can consume stock exactly once.
insert into volt_core.inventory_movements (
  id, company_id, product_id, type, quantity, reason, source_type, source_id, actor_user_id, operational_at
)
select
  'inv_resbackfill_' || md5(s.company_id || ':' || s.id || ':' || m.product_id),
  s.company_id,
  m.product_id,
  'entry',
  abs(sum(m.quantity)),
  'Conversao de baixa antecipada para reserva de estoque',
  'stock_reservation_backfill',
  s.id,
  null,
  now()
from volt_core.sales s
join volt_core.inventory_movements m
  on m.company_id=s.company_id and m.source_type='sale' and m.source_id=s.id and m.quantity < 0
where s.status='pending_delivery' and s.payment_timing='delivery'
group by s.company_id,s.id,m.product_id
on conflict (id) do nothing;

update volt_core.inventory_movements m
set source_type='sale_reservation_legacy'
from volt_core.sales s
where m.company_id=s.company_id
  and m.source_type='sale'
  and m.source_id=s.id
  and m.quantity < 0
  and s.status='pending_delivery'
  and s.payment_timing='delivery';

insert into volt_core.stock_reservations (
  id, company_id, product_id, sale_id, quantity, status, reserved_at, metadata
)
select
  'res_' || md5(s.company_id || ':' || s.id || ':' || si.product_id),
  s.company_id,
  si.product_id,
  s.id,
  sum(si.quantity),
  'active',
  coalesce(s.created_at, now()),
  jsonb_build_object('source','migration_019','saleNumber',s.number)
from volt_core.sales s
join volt_core.sale_items si on si.company_id=s.company_id and si.sale_id=s.id
join volt_core.products p on p.company_id=s.company_id and p.id=si.product_id and p.track_stock=true
where s.status='pending_delivery' and s.payment_timing='delivery'
group by s.company_id,s.id,s.number,s.created_at,si.product_id
on conflict (company_id,sale_id,product_id) do nothing;

alter table volt_core.stock_reservations enable row level security;
alter table volt_core.stock_reservations force row level security;
drop policy if exists tenant_isolation on volt_core.stock_reservations;
create policy tenant_isolation on volt_core.stock_reservations
  using (
    current_setting('volt_core.bypass_rls', true) = 'on'
    or company_id = nullif(current_setting('volt_core.company_id', true), '')
  )
  with check (
    current_setting('volt_core.bypass_rls', true) = 'on'
    or company_id = nullif(current_setting('volt_core.company_id', true), '')
  );
