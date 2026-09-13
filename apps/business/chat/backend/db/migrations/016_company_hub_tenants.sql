-- Vincula cada empresa do VoltChat ao tenant global usado pelo Hub e pelos demais modulos.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tenant_global_id VARCHAR(64);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS hub_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS hub_synced_at TIMESTAMPTZ;

UPDATE companies
SET tenant_global_id = id
WHERE tenant_global_id IS NULL OR tenant_global_id = '';

ALTER TABLE companies ALTER COLUMN tenant_global_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_tenant_global_id ON companies (tenant_global_id);
CREATE INDEX IF NOT EXISTS ix_companies_hub_enabled ON companies (hub_enabled);
