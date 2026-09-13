BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS tenant_global_id text;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS user_global_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_tenant_global_id
  ON tenants (tenant_global_id)
  WHERE tenant_global_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_user_global_id
  ON users (tenant_id, user_global_id)
  WHERE user_global_id IS NOT NULL;

COMMIT;
