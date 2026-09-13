CREATE TABLE IF NOT EXISTS volt_price.marketing_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK(channel IN ('meli_ads','shopee_ads','meta_ads','google_ads','tiktok_ads','manual')),
  connection_id uuid REFERENCES volt_price.integration_connections(id) ON DELETE SET NULL,
  external_account_id text NOT NULL DEFAULT 'default',
  display_name text NOT NULL,
  auth_mode text NOT NULL DEFAULT 'import' CHECK(auth_mode IN ('oauth','provider_connection','import','manual')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','error','disconnected')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,channel,external_account_id)
);

CREATE TABLE IF NOT EXISTS volt_price.ad_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES volt_price.marketing_sources(id) ON DELETE CASCADE,
  external_campaign_id text NOT NULL, name text NOT NULL, status text,
  objective text, daily_budget numeric(18,2), currency text NOT NULL DEFAULT 'BRL',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,source_id,external_campaign_id)
);

ALTER TABLE volt_price.ads_metrics
  ADD COLUMN IF NOT EXISTS source_id uuid REFERENCES volt_price.marketing_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES volt_price.ad_campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_campaign_id text,
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES volt_price.products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS impressions bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clicks bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS conversions numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attributed_revenue numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attributed_orders numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'BRL',
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS source_ref text,
  ADD COLUMN IF NOT EXISTS source_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE volt_price.ads_metrics SET attributed_revenue=coalesce(revenue,0),attributed_orders=coalesce(orders,0)
WHERE attributed_revenue=0 AND attributed_orders=0 AND (coalesce(revenue,0)<>0 OR coalesce(orders,0)<>0);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_ads_metric_source_ref_current
  ON volt_price.ads_metrics(tenant_id,channel,source_ref) WHERE source_ref IS NOT NULL AND is_current;
CREATE INDEX IF NOT EXISTS idx_vp_ads_metric_date ON volt_price.ads_metrics(tenant_id,metric_date DESC,is_current);
CREATE INDEX IF NOT EXISTS idx_vp_ads_metric_campaign ON volt_price.ads_metrics(tenant_id,campaign_id,metric_date DESC);

CREATE TABLE IF NOT EXISTS volt_price.promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  order_id uuid REFERENCES volt_price.orders(id) ON DELETE SET NULL, product_id uuid REFERENCES volt_price.products(id) ON DELETE SET NULL,
  channel text NOT NULL, external_promotion_id text, promotion_type text NOT NULL,
  code text, seller_funded_amount numeric(18,2) NOT NULL DEFAULT 0, marketplace_funded_amount numeric(18,2) NOT NULL DEFAULT 0,
  coins_amount numeric(18,2) NOT NULL DEFAULT 0, starts_at timestamptz, ends_at timestamptz, status text NOT NULL DEFAULT 'active',
  source_type text NOT NULL DEFAULT 'MANUAL', source_ref text, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_promotion_source_ref ON volt_price.promotions(tenant_id,channel,source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS volt_price.affiliate_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  order_id uuid REFERENCES volt_price.orders(id) ON DELETE SET NULL, product_id uuid REFERENCES volt_price.products(id) ON DELETE SET NULL,
  channel text NOT NULL, external_attribution_id text, affiliate_name text, campaign_name text,
  commission_amount numeric(18,2) NOT NULL DEFAULT 0, attributed_revenue numeric(18,2) NOT NULL DEFAULT 0,
  attribution_date date NOT NULL, source_type text NOT NULL DEFAULT 'MANUAL', source_ref text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_affiliate_source_ref ON volt_price.affiliate_attributions(tenant_id,channel,source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS volt_price.order_marketing_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES volt_price.orders(id) ON DELETE CASCADE, product_id uuid REFERENCES volt_price.products(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES volt_price.ad_campaigns(id) ON DELETE SET NULL,
  cost_type text NOT NULL CHECK(cost_type IN ('ads','seller_coupon','marketplace_coupon','coins','affiliate','promotion')),
  amount numeric(18,2) NOT NULL CHECK(amount>=0), funded_by text NOT NULL DEFAULT 'seller' CHECK(funded_by IN ('seller','marketplace','shared')),
  source_type text NOT NULL DEFAULT 'MANUAL' CHECK(source_type IN ('API','IMPORT','MANUAL','CALCULATED')),
  source_ref text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_order_marketing_cost_source ON volt_price.order_marketing_costs(tenant_id,order_id,cost_type,source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vp_order_marketing_cost_order ON volt_price.order_marketing_costs(tenant_id,order_id);

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['marketing_sources','ad_campaigns','promotions','affiliate_attributions','order_marketing_costs'] LOOP
    EXECUTE format('ALTER TABLE volt_price.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE volt_price.%I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON volt_price.%I',tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON volt_price.%I USING (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id()) WITH CHECK (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id())',tbl);
  END LOOP;
END $$;
