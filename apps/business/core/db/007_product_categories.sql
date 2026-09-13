create table if not exists volt_core.product_categories (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  name text not null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_volt_core_product_categories_company_name
  on volt_core.product_categories(company_id, lower(name));

insert into volt_core.product_categories (id, company_id, name, description)
select
  'cat_' || substr(md5(c.id || ':' || lower(defaults.name)), 1, 20),
  c.id,
  defaults.name,
  defaults.description
from volt_core.companies c
cross join (values
  ('Produtos', 'Itens fisicos para venda'),
  ('Acessorios', 'Complementos e itens adicionais'),
  ('Servicos', 'Servicos sem controle de estoque')
) as defaults(name, description)
on conflict do nothing;

alter table volt_core.products
  add column if not exists category_id text references volt_core.product_categories(id) on delete set null;

create index if not exists idx_volt_core_products_category
  on volt_core.products(company_id, category_id);

insert into volt_core.product_categories (id, company_id, name)
select
  'cat_' || substr(md5(company_id || ':' || lower(category)), 1, 20),
  company_id,
  category
from volt_core.products
where nullif(trim(category), '') is not null
group by company_id, category
on conflict do nothing;

update volt_core.products p
set category_id = c.id
from volt_core.product_categories c
where c.company_id = p.company_id
  and lower(c.name) = lower(p.category)
  and p.category_id is null;
