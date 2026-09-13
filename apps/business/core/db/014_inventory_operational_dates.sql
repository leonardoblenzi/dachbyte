-- Inventory operational dates.
-- This migration intentionally sorts before 014_platform_engine_rls.sql and
-- 015_workspace_v2_indexes.sql so existing databases can add the column before
-- Workspace V2 creates its index. It is additive and safe for databases where
-- the table already contains movements.

alter table volt_core.inventory_movements
  add column if not exists operational_at timestamptz;

update volt_core.inventory_movements
   set operational_at = created_at
 where operational_at is null;

alter table volt_core.inventory_movements
  alter column operational_at set default now();

alter table volt_core.inventory_movements
  alter column operational_at set not null;

create index if not exists idx_volt_core_inventory_company_operational
  on volt_core.inventory_movements(company_id, operational_at desc, created_at desc);
