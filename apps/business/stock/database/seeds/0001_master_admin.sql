BEGIN;

WITH tenant_upsert AS (
  INSERT INTO tenants (name, slug, status, settings)
  VALUES ('Volt Stock Master', 'volt-stock-master', 'active', '{"plan":"enterprise","bootstrap":true}')
  ON CONFLICT (slug)
  DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status
  RETURNING id
),
company_upsert AS (
  INSERT INTO companies (tenant_id, legal_name, trade_name, tax_id, status)
  SELECT id, 'Volt Stock Tecnologia Ltda', 'Volt Stock', '00000000000000', 'active'
  FROM tenant_upsert
  ON CONFLICT (tenant_id, tax_id)
  DO UPDATE SET legal_name = EXCLUDED.legal_name, trade_name = EXCLUDED.trade_name, status = EXCLUDED.status
  RETURNING id, tenant_id
),
branch_upsert AS (
  INSERT INTO branches (tenant_id, company_id, code, name, timezone, status)
  SELECT tenant_id, id, 'MATRIZ', 'Matriz Operacional', 'America/Sao_Paulo', 'active'
  FROM company_upsert
  ON CONFLICT (tenant_id, company_id, code)
  DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status
  RETURNING id, tenant_id, company_id
),
admin_upsert AS (
  INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
  SELECT id, 'admin@voltstock.com', crypt('Stock@172839', gen_salt('bf', 12)), 'Admin Master Volt Stock', 'admin', 'active'
  FROM tenant_upsert
  ON CONFLICT (tenant_id, email)
  DO UPDATE SET full_name = EXCLUDED.full_name, role = EXCLUDED.role, status = EXCLUDED.status
  RETURNING id, tenant_id
)
INSERT INTO user_company_access (tenant_id, user_id, company_id, branch_id, role, status)
SELECT a.tenant_id, a.id, c.id, b.id, 'admin', 'active'
FROM admin_upsert a
JOIN company_upsert c ON c.tenant_id = a.tenant_id
JOIN branch_upsert b ON b.tenant_id = a.tenant_id
ON CONFLICT (tenant_id, user_id, company_id, branch_id)
DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status;

WITH tenant_ref AS (
  SELECT id AS tenant_id FROM tenants WHERE slug = 'volt-stock-master'
)
INSERT INTO role_permissions (tenant_id, role, permissions)
SELECT tenant_id, role, permissions::jsonb
FROM tenant_ref
CROSS JOIN (
  VALUES
    ('admin', '["companies.manage","users.manage","map.manage","products.manage","stock.move","stock.adjust","inventory.run","audit.read","integrations.manage","labels.manage"]'),
    ('gestor', '["map.manage","products.manage","stock.move","stock.adjust","inventory.run","audit.read","labels.manage"]'),
    ('operador', '["products.create","stock.move","inventory.run","labels.print"]'),
    ('auditor', '["inventory.run","audit.read"]'),
    ('integrador', '["integrations.manage"]')
) AS perms(role, permissions)
ON CONFLICT (tenant_id, role)
DO UPDATE SET permissions = EXCLUDED.permissions;

INSERT INTO integration_providers (code, name, category)
VALUES
  ('generic-erp', 'ERP Generico', 'erp'),
  ('webhook', 'Webhook HTTP', 'webhook')
ON CONFLICT (code) DO NOTHING;

COMMIT;
