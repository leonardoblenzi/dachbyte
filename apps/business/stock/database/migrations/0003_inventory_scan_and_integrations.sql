BEGIN;

CREATE TABLE IF NOT EXISTS facilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  code text NOT NULL,
  name text NOT NULL,
  facility_type text NOT NULL DEFAULT 'warehouse',
  status text NOT NULL DEFAULT 'active',
  dimensions jsonb NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, code)
);

CREATE TABLE IF NOT EXISTS locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  location_type text NOT NULL,
  path text NOT NULL,
  depth int NOT NULL DEFAULT 0,
  capacity_quantity numeric,
  capacity_volume numeric,
  coordinates jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'available',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, facility_id, code)
);

CREATE TABLE IF NOT EXISTS map_canvases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  name text NOT NULL,
  version int NOT NULL DEFAULT 1,
  canvas_width numeric NOT NULL DEFAULT 1600,
  canvas_height numeric NOT NULL DEFAULT 1000,
  status text NOT NULL DEFAULT 'draft',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, facility_id, name, version)
);

CREATE TABLE IF NOT EXISTS map_elements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  map_canvas_id uuid NOT NULL REFERENCES map_canvases(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  element_type text NOT NULL,
  label text,
  geometry jsonb NOT NULL DEFAULT '{}',
  style jsonb NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_code text NOT NULL,
  sku text,
  barcode text,
  name text NOT NULL,
  description text,
  category text,
  brand text,
  unit text NOT NULL DEFAULT 'un',
  weight numeric,
  width numeric,
  height numeric,
  depth numeric,
  volume numeric,
  tracking_mode text NOT NULL DEFAULT 'none',
  status text NOT NULL DEFAULT 'active',
  cost_amount numeric,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, product_code),
  UNIQUE (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS product_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  identifier_type text NOT NULL,
  raw_value text NOT NULL,
  normalized_value text NOT NULL,
  source text NOT NULL DEFAULT 'manual_scan',
  provider_name text,
  label_context jsonb NOT NULL DEFAULT '{}',
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, identifier_type, normalized_value, source)
);

CREATE TABLE IF NOT EXISTS qr_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  qr_token text NOT NULL UNIQUE,
  human_code text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS stock_containers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  container_type text NOT NULL DEFAULT 'pallet',
  code text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS stock_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  container_id uuid REFERENCES stock_containers(id) ON DELETE SET NULL,
  lot_code text,
  location_scope uuid GENERATED ALWAYS AS (COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
  container_scope uuid GENERATED ALWAYS AS (COALESCE(container_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
  lot_scope text GENERATED ALWAYS AS (COALESCE(lot_code, '')) STORED,
  quantity numeric NOT NULL DEFAULT 0,
  reserved_quantity numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, product_id, location_scope, container_scope, lot_scope)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  from_location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  to_location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  quantity numeric NOT NULL,
  movement_type text NOT NULL,
  reason text,
  source text NOT NULL DEFAULT 'manual',
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scan_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  flow_type text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  context jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS scan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES scan_sessions(id) ON DELETE SET NULL,
  scanned_value text NOT NULL,
  resolved_type text,
  resolved_entity_id uuid,
  scan_source text NOT NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS allocation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft',
  flow_type text NOT NULL,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  quantity numeric,
  started_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  file_name text NOT NULL,
  file_url text,
  status text NOT NULL DEFAULT 'uploaded',
  summary jsonb NOT NULL DEFAULT '{}',
  rollback_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_staging_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  import_job_id uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_number int NOT NULL,
  raw_data jsonb NOT NULL,
  normalized_data jsonb NOT NULL DEFAULT '{}',
  validation_errors jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS label_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  target_entity text NOT NULL,
  page_format text NOT NULL DEFAULT 'A4',
  layout jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, name)
);

CREATE TABLE IF NOT EXISTS label_print_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  template_id uuid REFERENCES label_templates(id) ON DELETE SET NULL,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued',
  output_url text,
  printer_profile jsonb NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES integration_providers(id) ON DELETE RESTRICT,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'inactive',
  settings jsonb NOT NULL DEFAULT '{}',
  secret_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  url text NOT NULL,
  event_types jsonb NOT NULL DEFAULT '[]',
  secret_ref text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES webhook_subscriptions(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_facilities_tenant_company ON facilities (tenant_id, company_id);
CREATE INDEX IF NOT EXISTS idx_locations_tree ON locations (tenant_id, facility_id, parent_id, code);
CREATE INDEX IF NOT EXISTS idx_products_search ON products (tenant_id, company_id, product_code, sku, barcode);
CREATE INDEX IF NOT EXISTS idx_product_identifiers_lookup ON product_identifiers (tenant_id, normalized_value);
CREATE INDEX IF NOT EXISTS idx_qr_codes_token ON qr_codes (qr_token);
CREATE INDEX IF NOT EXISTS idx_stock_balances_lookup ON stock_balances (tenant_id, company_id, product_id, location_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_timeline ON stock_movements (tenant_id, company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_events_timeline ON scan_events (tenant_id, company_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_facilities_updated_at ON facilities;
CREATE TRIGGER trg_facilities_updated_at BEFORE UPDATE ON facilities
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS trg_locations_updated_at ON locations;
CREATE TRIGGER trg_locations_updated_at BEFORE UPDATE ON locations
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS trg_map_canvases_updated_at ON map_canvases;
CREATE TRIGGER trg_map_canvases_updated_at BEFORE UPDATE ON map_canvases
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS trg_map_elements_updated_at ON map_elements;
CREATE TRIGGER trg_map_elements_updated_at BEFORE UPDATE ON map_elements
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS trg_product_identifiers_updated_at ON product_identifiers;
CREATE TRIGGER trg_product_identifiers_updated_at BEFORE UPDATE ON product_identifiers
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS trg_stock_containers_updated_at ON stock_containers;
CREATE TRIGGER trg_stock_containers_updated_at BEFORE UPDATE ON stock_containers
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS trg_import_jobs_updated_at ON import_jobs;
CREATE TRIGGER trg_import_jobs_updated_at BEFORE UPDATE ON import_jobs
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS trg_label_templates_updated_at ON label_templates;
CREATE TRIGGER trg_label_templates_updated_at BEFORE UPDATE ON label_templates
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS trg_label_print_jobs_updated_at ON label_print_jobs;
CREATE TRIGGER trg_label_print_jobs_updated_at BEFORE UPDATE ON label_print_jobs
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS trg_integration_connections_updated_at ON integration_connections;
CREATE TRIGGER trg_integration_connections_updated_at BEFORE UPDATE ON integration_connections
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS trg_webhook_subscriptions_updated_at ON webhook_subscriptions;
CREATE TRIGGER trg_webhook_subscriptions_updated_at BEFORE UPDATE ON webhook_subscriptions
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS trg_webhook_events_updated_at ON webhook_events;
CREATE TRIGGER trg_webhook_events_updated_at BEFORE UPDATE ON webhook_events
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

COMMIT;
