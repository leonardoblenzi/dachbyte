BEGIN;

WITH refs AS (
  SELECT
    t.id AS tenant_id,
    c.id AS company_id,
    b.id AS branch_id,
    u.id AS user_id
  FROM tenants t
  JOIN companies c ON c.tenant_id = t.id
  JOIN branches b ON b.tenant_id = t.id AND b.company_id = c.id
  JOIN users u ON u.tenant_id = t.id AND u.email = 'admin@voltstock.com'
  WHERE t.slug = 'volt-stock-master'
  LIMIT 1
),
facility_upsert AS (
  INSERT INTO facilities (tenant_id, company_id, branch_id, code, name, facility_type, status, dimensions)
  SELECT tenant_id, company_id, branch_id, 'H01', 'Hangar 01 - Operacao Principal', 'warehouse', 'active', '{"width":80,"depth":48,"height":12}'::jsonb
  FROM refs
  ON CONFLICT (tenant_id, company_id, code)
  DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status
  RETURNING id, tenant_id, company_id, branch_id
),
hangar AS (
  INSERT INTO locations (tenant_id, company_id, branch_id, facility_id, code, name, location_type, path, depth, coordinates, status)
  SELECT tenant_id, company_id, branch_id, id, 'H01', 'Hangar 01', 'hangar', 'H01', 0, '{"x":0,"y":0,"z":0}'::jsonb, 'available'
  FROM facility_upsert
  ON CONFLICT (tenant_id, facility_id, code)
  DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status
  RETURNING *
),
rua AS (
  INSERT INTO locations (tenant_id, company_id, branch_id, facility_id, parent_id, code, name, location_type, path, depth, coordinates, status)
  SELECT tenant_id, company_id, branch_id, facility_id, id, 'H01-RB', 'Rua B', 'aisle', 'H01/H01-RB', 1, '{"x":12,"y":0,"z":0}'::jsonb, 'available'
  FROM hangar
  ON CONFLICT (tenant_id, facility_id, code)
  DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status
  RETURNING *
),
rack AS (
  INSERT INTO locations (tenant_id, company_id, branch_id, facility_id, parent_id, code, name, location_type, path, depth, capacity_quantity, coordinates, status)
  SELECT tenant_id, company_id, branch_id, facility_id, id, 'H01-RB-EST03', 'Estante 03', 'rack', 'H01/H01-RB/H01-RB-EST03', 2, 1200, '{"x":18,"y":0,"z":6}'::jsonb, 'partial'
  FROM rua
  ON CONFLICT (tenant_id, facility_id, code)
  DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status
  RETURNING *
),
bin_a AS (
  INSERT INTO locations (tenant_id, company_id, branch_id, facility_id, parent_id, code, name, location_type, path, depth, capacity_quantity, coordinates, status)
  SELECT tenant_id, company_id, branch_id, facility_id, id, 'H01-RB-EST03-C01-N01-BIN01', 'C01 N01 Bin 01', 'bin', 'H01/H01-RB/H01-RB-EST03/H01-RB-EST03-C01-N01-BIN01', 3, 300, '{"x":18,"y":1,"z":6}'::jsonb, 'partial'
  FROM rack
  ON CONFLICT (tenant_id, facility_id, code)
  DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status
  RETURNING *
),
bin_b AS (
  INSERT INTO locations (tenant_id, company_id, branch_id, facility_id, parent_id, code, name, location_type, path, depth, capacity_quantity, coordinates, status)
  SELECT tenant_id, company_id, branch_id, facility_id, id, 'H01-RB-EST03-C02-N02-BIN02', 'C02 N02 Bin 02', 'bin', 'H01/H01-RB/H01-RB-EST03/H01-RB-EST03-C02-N02-BIN02', 3, 450, '{"x":22,"y":2,"z":6}'::jsonb, 'available'
  FROM rack
  ON CONFLICT (tenant_id, facility_id, code)
  DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status
  RETURNING *
),
product_a AS (
  INSERT INTO products (tenant_id, company_id, product_code, sku, barcode, name, category, brand, unit, tracking_mode, cost_amount, status)
  SELECT tenant_id, company_id, 'EMB-PAP-3020', 'EMB-PAP-3020', '7891234567890', 'Embalagem Papel 30x20', 'Embalagens', 'Volt Supply', 'un', 'none', 0.42, 'active'
  FROM refs
  ON CONFLICT (tenant_id, product_code)
  DO UPDATE SET name = EXCLUDED.name, sku = EXCLUDED.sku, barcode = EXCLUDED.barcode, status = EXCLUDED.status
  RETURNING *
),
product_b AS (
  INSERT INTO products (tenant_id, company_id, product_code, sku, barcode, name, category, brand, unit, tracking_mode, cost_amount, status)
  SELECT tenant_id, company_id, 'PAR-HEX-M8', 'PAR-HEX-M8', '7899876543210', 'Parafuso Hexagonal M8', 'Fixadores', 'AcoMax', 'un', 'lot', 0.18, 'active'
  FROM refs
  ON CONFLICT (tenant_id, product_code)
  DO UPDATE SET name = EXCLUDED.name, sku = EXCLUDED.sku, barcode = EXCLUDED.barcode, status = EXCLUDED.status
  RETURNING *
),
balance_a AS (
  INSERT INTO stock_balances (tenant_id, company_id, product_id, location_id, quantity, reserved_quantity)
  SELECT p.tenant_id, p.company_id, p.id, l.id, 860, 120
  FROM product_a p
  CROSS JOIN bin_a l
  ON CONFLICT (tenant_id, product_id, location_scope, container_scope, lot_scope)
  DO UPDATE SET quantity = EXCLUDED.quantity, reserved_quantity = EXCLUDED.reserved_quantity, updated_at = now()
  RETURNING *
),
balance_b AS (
  INSERT INTO stock_balances (tenant_id, company_id, product_id, location_id, lot_code, quantity, reserved_quantity)
  SELECT p.tenant_id, p.company_id, p.id, l.id, 'L2026-06', 1840, 0
  FROM product_b p
  CROSS JOIN bin_b l
  ON CONFLICT (tenant_id, product_id, location_scope, container_scope, lot_scope)
  DO UPDATE SET quantity = EXCLUDED.quantity, reserved_quantity = EXCLUDED.reserved_quantity, updated_at = now()
  RETURNING *
)
INSERT INTO stock_movements (tenant_id, company_id, product_id, to_location_id, quantity, movement_type, reason, source, user_id, metadata)
SELECT p.tenant_id, p.company_id, p.id, b.location_id, b.quantity, 'entrada', 'Carga inicial demonstrativa', 'seed', r.user_id, '{"bootstrap":true}'::jsonb
FROM balance_a b
JOIN product_a p ON p.id = b.product_id
CROSS JOIN refs r
WHERE NOT EXISTS (
  SELECT 1 FROM stock_movements sm WHERE sm.tenant_id = p.tenant_id AND sm.product_id = p.id AND sm.source = 'seed'
)
UNION ALL
SELECT p.tenant_id, p.company_id, p.id, b.location_id, b.quantity, 'entrada', 'Carga inicial demonstrativa', 'seed', r.user_id, '{"bootstrap":true}'::jsonb
FROM balance_b b
JOIN product_b p ON p.id = b.product_id
CROSS JOIN refs r
WHERE NOT EXISTS (
  SELECT 1 FROM stock_movements sm WHERE sm.tenant_id = p.tenant_id AND sm.product_id = p.id AND sm.source = 'seed'
);

WITH entities AS (
  SELECT tenant_id, company_id, 'product' AS entity_type, id AS entity_id, 'VS-PROD-' || product_code AS human_code
  FROM products
  WHERE product_code IN ('EMB-PAP-3020', 'PAR-HEX-M8')
  UNION ALL
  SELECT tenant_id, company_id, 'location', id, 'VS-LOC-' || code
  FROM locations
  WHERE code IN ('H01', 'H01-RB', 'H01-RB-EST03', 'H01-RB-EST03-C01-N01-BIN01', 'H01-RB-EST03-C02-N02-BIN02')
)
INSERT INTO qr_codes (tenant_id, company_id, entity_type, entity_id, qr_token, human_code, payload)
SELECT tenant_id, company_id, entity_type, entity_id, 'VS-' || upper(entity_type) || '-' || encode(gen_random_bytes(18), 'hex'), human_code, jsonb_build_object('source', 'seed')
FROM entities
ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING;

INSERT INTO product_identifiers (tenant_id, company_id, product_id, identifier_type, raw_value, normalized_value, source, is_primary, status)
SELECT tenant_id, company_id, id, 'barcode', barcode, regexp_replace(upper(barcode), '\s+', '', 'g'), 'seed', true, 'active'
FROM products
WHERE barcode IS NOT NULL
ON CONFLICT (tenant_id, identifier_type, normalized_value, source) DO NOTHING;

WITH refs AS (
  SELECT t.id AS tenant_id, c.id AS company_id, u.id AS user_id
  FROM tenants t
  JOIN companies c ON c.tenant_id = t.id
  JOIN users u ON u.tenant_id = t.id AND u.email = 'admin@voltstock.com'
  WHERE t.slug = 'volt-stock-master'
  LIMIT 1
),
facility AS (
  SELECT f.*
  FROM facilities f
  JOIN refs r ON r.tenant_id = f.tenant_id
  WHERE f.code = 'H01'
  LIMIT 1
),
canvas_upsert AS (
  INSERT INTO map_canvases (tenant_id, company_id, facility_id, name, version, status, created_by)
  SELECT r.tenant_id, r.company_id, f.id, 'Mapa operacional H01', 1, 'published', r.user_id
  FROM refs r
  JOIN facility f ON f.tenant_id = r.tenant_id
  ON CONFLICT (tenant_id, facility_id, name, version)
  DO UPDATE SET status = EXCLUDED.status, created_by = EXCLUDED.created_by
  RETURNING *
)
INSERT INTO map_elements (tenant_id, company_id, map_canvas_id, location_id, element_type, label, geometry, style, metadata)
SELECT c.tenant_id, c.company_id, c.id, l.id, 'smart_rack', l.name,
       '{"x":340,"y":180,"width":360,"height":150,"columns":6,"levels":4,"bins":2}'::jsonb,
       '{"stroke":"#43eaff","fill":"rgba(11,130,255,0.20)"}'::jsonb,
       '{"generated":true}'::jsonb
FROM canvas_upsert c
JOIN locations l ON l.tenant_id = c.tenant_id AND l.code = 'H01-RB-EST03'
WHERE NOT EXISTS (
  SELECT 1 FROM map_elements me WHERE me.map_canvas_id = c.id AND me.location_id = l.id
);

COMMIT;
