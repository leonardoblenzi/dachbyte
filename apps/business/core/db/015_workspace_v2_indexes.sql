-- Workspace V2 / server-side pagination indexes.
-- Additive and idempotent: safe to run on existing tenants.

create index if not exists idx_volt_core_customers_company_active_number
  on volt_core.customers (company_id, active, number);

create index if not exists idx_volt_core_products_company_active_number
  on volt_core.products (company_id, active, number);

create index if not exists idx_volt_core_products_company_optical_type
  on volt_core.products (company_id, optical_type, active);

create index if not exists idx_volt_core_sales_company_status_sold_at
  on volt_core.sales (company_id, status, sold_at desc, created_at desc);

create index if not exists idx_volt_core_inventory_company_created
  on volt_core.inventory_movements (company_id, created_at desc);

create index if not exists idx_volt_core_cash_movements_company_session_operational
  on volt_core.cash_movements (company_id, session_id, operational_at desc, created_at desc);

create index if not exists idx_volt_core_receipts_company_created
  on volt_core.receipts (company_id, created_at desc);

create index if not exists idx_volt_core_prescriptions_company_created
  on volt_core.optical_prescriptions (company_id, created_at desc);

create index if not exists idx_volt_core_service_orders_company_due
  on volt_core.service_orders (company_id, due_date, status);

create index if not exists idx_volt_core_optical_orders_company_promised
  on volt_core.optical_orders (company_id, promised_date, status);

create index if not exists idx_volt_core_fiscal_company_created
  on volt_core.fiscal_documents (company_id, created_at desc);

create index if not exists idx_volt_core_sales_company_customer_sold_at
  on volt_core.sales (company_id, customer_id, sold_at desc);

create index if not exists idx_volt_core_receivables_company_customer_status_due
  on volt_core.receivables (company_id, customer_id, status, due_date);

create index if not exists idx_volt_core_service_orders_company_customer_status
  on volt_core.service_orders (company_id, customer_id, status);
