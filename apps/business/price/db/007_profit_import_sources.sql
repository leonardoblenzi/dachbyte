ALTER TABLE volt_price.profit_components DROP CONSTRAINT IF EXISTS profit_components_source_type_check;
ALTER TABLE volt_price.profit_components
  ADD CONSTRAINT profit_components_source_type_check CHECK(source_type IN ('API','ERP','IMPORT','MANUAL','CALCULATED'));
