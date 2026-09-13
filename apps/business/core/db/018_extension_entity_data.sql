-- Phase E.1: generic extension-owned entity data.
-- Optional modules persist their entity-specific payloads here instead of
-- adding new fields to Core payloads/tables for every vertical/service.

create table if not exists volt_core.entity_extension_data (
  company_id text not null references volt_core.companies(id) on delete cascade,
  entity_type text not null,
  entity_id text not null,
  extension_key text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, entity_type, entity_id, extension_key)
);

create index if not exists idx_volt_entity_extension_lookup
  on volt_core.entity_extension_data(company_id, extension_key, entity_type, entity_id);

-- Preserve existing optical catalog metadata when switching the runtime to
-- extension-owned payloads. Legacy columns are intentionally left in place for
-- rollback/compatibility, but the new runtime no longer needs to write them.
--
-- IMPORTANT: do not infer optical ownership from generic Core fields such as
-- category/name/type. A product is backfilled into vertical.optical only when
-- it already contains explicit legacy optical metadata.
insert into volt_core.entity_extension_data (
  company_id, entity_type, entity_id, extension_key, data, created_at, updated_at
)
select p.company_id,
       'product',
       p.id,
       'vertical.optical',
       jsonb_strip_nulls(jsonb_build_object(
         'opticalType', nullif(p.optical_type, ''),
         'opticalSpecs', case when coalesce(p.optical_specs, '{}'::jsonb) = '{}'::jsonb then null else p.optical_specs end,
         'catalogType', case
           when p.optical_type = 'frame' then 'Armacao'
           when p.optical_type = 'lens' and lower(coalesce(p.type,'')) = 'service' then 'Lente encomendada'
           when p.optical_type = 'lens' then 'Lente em estoque'
           else null
         end
       )),
       coalesce(p.created_at, now()),
       now()
  from volt_core.products p
 where nullif(p.optical_type, '') is not null
    or coalesce(p.optical_specs, '{}'::jsonb) <> '{}'::jsonb
on conflict (company_id, entity_type, entity_id, extension_key) do update set
  data = volt_core.entity_extension_data.data || excluded.data,
  updated_at = now();

alter table volt_core.entity_extension_data enable row level security;
alter table volt_core.entity_extension_data force row level security;
drop policy if exists tenant_isolation on volt_core.entity_extension_data;
create policy tenant_isolation on volt_core.entity_extension_data
using (
  current_setting('volt_core.bypass_rls', true) = 'on'
  or company_id = nullif(current_setting('volt_core.company_id', true), '')
)
with check (
  current_setting('volt_core.bypass_rls', true) = 'on'
  or company_id = nullif(current_setting('volt_core.company_id', true), '')
);
