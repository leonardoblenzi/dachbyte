create table if not exists volt_core.product_brands (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  name text not null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_volt_core_product_brands_company_name
  on volt_core.product_brands(company_id, lower(name));

alter table volt_core.products
  add column if not exists ean text,
  add column if not exists brand text,
  add column if not exists brand_id text references volt_core.product_brands(id) on delete set null;

create unique index if not exists uq_volt_core_products_company_ean
  on volt_core.products(company_id, ean)
  where nullif(trim(ean), '') is not null;

create index if not exists idx_volt_core_products_brand
  on volt_core.products(company_id, brand_id);

insert into volt_core.product_brands (id, company_id, name)
select
  'brd_' || substr(md5(company_id || ':' || lower(brand)), 1, 20),
  company_id,
  brand
from volt_core.products
where nullif(trim(brand), '') is not null
group by company_id, brand
on conflict do nothing;

update volt_core.products p
set brand_id = b.id
from volt_core.product_brands b
where b.company_id = p.company_id
  and lower(b.name) = lower(p.brand)
  and p.brand_id is null;
