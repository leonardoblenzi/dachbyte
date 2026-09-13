-- Phase E: commercial composition for Volt Core + optional verticals, services and channels.

create table if not exists volt_core.company_product_subscriptions (
  id text primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  product_key text not null,
  plan_key text,
  status text not null default 'contracted'
    check (status in ('contracted','configuring','active','suspended')),
  contracted_at timestamptz,
  activated_at timestamptz,
  suspended_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, product_key),
  unique (company_id, id)
);

create index if not exists idx_volt_company_product_subscriptions_status
  on volt_core.company_product_subscriptions(company_id, status, product_key);

create table if not exists volt_core.service_usage_counters (
  company_id text not null references volt_core.companies(id) on delete cascade,
  product_key text not null,
  metric_key text not null,
  period_start date not null,
  used_count bigint not null default 0 check (used_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (company_id, product_key, metric_key, period_start)
);

create index if not exists idx_volt_service_usage_period
  on volt_core.service_usage_counters(company_id, period_start desc, product_key, metric_key);

-- Volt Core is always active. Existing optical companies receive the optical
-- vertical explicitly so commercial gating does not change their operation.
insert into volt_core.company_product_subscriptions (
  id, company_id, product_key, plan_key, status, contracted_at, activated_at, metadata, updated_by
)
select 'sub_core_' || c.id,
       c.id,
       'core',
       coalesce(c.plan_key, 'starter'),
       'active',
       now(),
       now(),
       '{"source":"phase_e_backfill"}'::jsonb,
       'migration:017'
  from volt_core.companies c
on conflict (company_id, product_key) do update set
  plan_key = excluded.plan_key,
  status = 'active',
  activated_at = coalesce(volt_core.company_product_subscriptions.activated_at, excluded.activated_at),
  suspended_at = null,
  updated_at = now();

insert into volt_core.company_product_subscriptions (
  id, company_id, product_key, plan_key, status, contracted_at, activated_at, metadata, updated_by
)
select 'sub_optical_' || c.id,
       c.id,
       'vertical.optical',
       'standard',
       'active',
       now(),
       now(),
       '{"source":"legacy_segment"}'::jsonb,
       'migration:017'
  from volt_core.companies c
 where lower(coalesce(c.segment_key,'')) = 'optical'
on conflict (company_id, product_key) do nothing;

DO $$
DECLARE
  table_name text;
  tenant_tables text[] := ARRAY['company_product_subscriptions','service_usage_counters'];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE volt_core.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE volt_core.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON volt_core.%I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON volt_core.%I USING (' ||
      'current_setting(''volt_core.bypass_rls'', true) = ''on'' OR ' ||
      'company_id = nullif(current_setting(''volt_core.company_id'', true), '''')' ||
      ') WITH CHECK (' ||
      'current_setting(''volt_core.bypass_rls'', true) = ''on'' OR ' ||
      'company_id = nullif(current_setting(''volt_core.company_id'', true), '''')' ||
      ')', table_name
    );
  END LOOP;
END $$;
