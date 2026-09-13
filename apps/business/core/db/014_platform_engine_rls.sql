-- Platform engine foundation: tenant RLS + reusable custom fields + workflow history.

-- Expand JSON custom fields beyond customers/products without destructive schema changes.
alter table volt_core.sales add column if not exists custom_fields jsonb not null default '{}'::jsonb;
alter table volt_core.service_orders add column if not exists custom_fields jsonb not null default '{}'::jsonb;
alter table volt_core.optical_prescriptions add column if not exists custom_fields jsonb not null default '{}'::jsonb;
alter table volt_core.receivables add column if not exists custom_fields jsonb not null default '{}'::jsonb;
alter table volt_core.expenses add column if not exists custom_fields jsonb not null default '{}'::jsonb;

create table if not exists volt_core.workflow_events (
  id bigserial primary key,
  company_id text not null references volt_core.companies(id) on delete cascade,
  workflow_key text not null,
  entity_type text not null,
  entity_id text not null,
  from_status text,
  to_status text not null,
  actor_user_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_volt_workflow_events_entity
  on volt_core.workflow_events(company_id, entity_type, entity_id, created_at desc);

-- RLS is fail-closed for tenant tables. Queries outside a tenant-scoped request
-- explicitly receive volt_core.bypass_rls=on from db/db.js (auth/master/migrations).
DO $$
DECLARE
  table_name text;
  tenant_tables text[] := ARRAY[
    'company_configurations','customers','products','product_categories','product_brands',
    'inventory_movements','sales','sale_items','cash_sessions','cash_movements','receivables',
    'receipts','expenses','service_orders','optical_prescriptions','optical_laboratories',
    'optical_orders','fiscal_documents','payment_methods','user_companies',
    'user_permission_overrides','onboarding_checklists','data_exchange_jobs',
    'operational_counters','events','audit_logs','workflow_events'
  ];
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
