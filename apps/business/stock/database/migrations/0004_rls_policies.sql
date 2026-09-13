BEGIN;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_company_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE map_canvases ENABLE ROW LEVEL SECURITY;
ALTER TABLE map_elements ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE qr_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_containers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE allocation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_staging_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE label_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE label_print_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_self_isolation ON tenants;
CREATE POLICY tenant_self_isolation ON tenants
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_companies_isolation ON companies;
CREATE POLICY tenant_companies_isolation ON companies
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_branches_isolation ON branches;
CREATE POLICY tenant_branches_isolation ON branches
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_users_isolation ON users;
CREATE POLICY tenant_users_isolation ON users
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_role_permissions_isolation ON role_permissions;
CREATE POLICY tenant_role_permissions_isolation ON role_permissions
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_user_company_access_isolation ON user_company_access;
CREATE POLICY tenant_user_company_access_isolation ON user_company_access
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_refresh_tokens_isolation ON refresh_tokens;
CREATE POLICY tenant_refresh_tokens_isolation ON refresh_tokens
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_devices_isolation ON devices;
CREATE POLICY tenant_devices_isolation ON devices
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_audit_logs_isolation ON audit_logs;
CREATE POLICY tenant_audit_logs_isolation ON audit_logs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_facilities_isolation ON facilities;
CREATE POLICY tenant_facilities_isolation ON facilities
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_locations_isolation ON locations;
CREATE POLICY tenant_locations_isolation ON locations
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_map_canvases_isolation ON map_canvases;
CREATE POLICY tenant_map_canvases_isolation ON map_canvases
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_map_elements_isolation ON map_elements;
CREATE POLICY tenant_map_elements_isolation ON map_elements
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_products_isolation ON products;
CREATE POLICY tenant_products_isolation ON products
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_product_identifiers_isolation ON product_identifiers;
CREATE POLICY tenant_product_identifiers_isolation ON product_identifiers
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_qr_codes_isolation ON qr_codes;
CREATE POLICY tenant_qr_codes_isolation ON qr_codes
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_stock_containers_isolation ON stock_containers;
CREATE POLICY tenant_stock_containers_isolation ON stock_containers
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_stock_balances_isolation ON stock_balances;
CREATE POLICY tenant_stock_balances_isolation ON stock_balances
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_stock_movements_isolation ON stock_movements;
CREATE POLICY tenant_stock_movements_isolation ON stock_movements
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_scan_sessions_isolation ON scan_sessions;
CREATE POLICY tenant_scan_sessions_isolation ON scan_sessions
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_scan_events_isolation ON scan_events;
CREATE POLICY tenant_scan_events_isolation ON scan_events
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_allocation_sessions_isolation ON allocation_sessions;
CREATE POLICY tenant_allocation_sessions_isolation ON allocation_sessions
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_import_jobs_isolation ON import_jobs;
CREATE POLICY tenant_import_jobs_isolation ON import_jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_import_staging_rows_isolation ON import_staging_rows;
CREATE POLICY tenant_import_staging_rows_isolation ON import_staging_rows
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_label_templates_isolation ON label_templates;
CREATE POLICY tenant_label_templates_isolation ON label_templates
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_label_print_jobs_isolation ON label_print_jobs;
CREATE POLICY tenant_label_print_jobs_isolation ON label_print_jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_integration_connections_isolation ON integration_connections;
CREATE POLICY tenant_integration_connections_isolation ON integration_connections
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_webhook_subscriptions_isolation ON webhook_subscriptions;
CREATE POLICY tenant_webhook_subscriptions_isolation ON webhook_subscriptions
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS tenant_webhook_events_isolation ON webhook_events;
CREATE POLICY tenant_webhook_events_isolation ON webhook_events
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

COMMIT;
