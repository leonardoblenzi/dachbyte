-- Defense in depth for tenant isolation on critical operational relationships.
-- Application queries already scope by company_id; these constraints ensure key
-- transactional rows cannot point at another tenant even if a future code path
-- forgets that validation.

alter table volt_core.sale_items
  add column if not exists company_id text;

update volt_core.sale_items si
   set company_id = s.company_id
  from volt_core.sales s
 where s.id = si.sale_id
   and si.company_id is null;

alter table volt_core.sale_items
  alter column company_id set not null;

create index if not exists idx_volt_core_sale_items_company_sale
  on volt_core.sale_items(company_id, sale_id);

create unique index if not exists uq_volt_core_products_company_id
  on volt_core.products(company_id, id);
create unique index if not exists uq_volt_core_customers_company_id
  on volt_core.customers(company_id, id);
create unique index if not exists uq_volt_core_sales_company_id
  on volt_core.sales(company_id, id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inventory_product_tenant') THEN
    ALTER TABLE volt_core.inventory_movements
      ADD CONSTRAINT fk_inventory_product_tenant
      FOREIGN KEY (company_id, product_id)
      REFERENCES volt_core.products(company_id, id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sale_item_sale_tenant') THEN
    ALTER TABLE volt_core.sale_items
      ADD CONSTRAINT fk_sale_item_sale_tenant
      FOREIGN KEY (company_id, sale_id)
      REFERENCES volt_core.sales(company_id, id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_optical_order_sale_tenant') THEN
    ALTER TABLE volt_core.optical_orders
      ADD CONSTRAINT fk_optical_order_sale_tenant
      FOREIGN KEY (company_id, sale_id)
      REFERENCES volt_core.sales(company_id, id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_optical_order_customer_tenant') THEN
    ALTER TABLE volt_core.optical_orders
      ADD CONSTRAINT fk_optical_order_customer_tenant
      FOREIGN KEY (company_id, customer_id)
      REFERENCES volt_core.customers(company_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;
