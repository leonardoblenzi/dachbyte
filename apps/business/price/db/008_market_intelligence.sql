CREATE TABLE IF NOT EXISTS volt_price.market_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK(channel IN ('meli','shopee','amazon','magalu','casas_bahia','carrefour','other','import')),
  source_kind text NOT NULL DEFAULT 'import' CHECK(source_kind IN ('official_api','import','manual')),
  connection_id uuid REFERENCES volt_price.integration_connections(id) ON DELETE SET NULL,
  source_key text NOT NULL, name text NOT NULL, external_seller_id text, external_seller_name text,
  site_id text, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','error','disconnected')),
  last_sync_at timestamptz, last_success_at timestamptz, last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,source_key)
);

CREATE TABLE IF NOT EXISTS volt_price.competitor_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES volt_price.market_sources(id) ON DELETE CASCADE,
  external_listing_id text NOT NULL, title text NOT NULL, seller_id text, seller_name text,
  gtin text, brand text, mpn text, category_id text, listing_url text, currency text NOT NULL DEFAULT 'BRL',
  current_price numeric(18,2) NOT NULL DEFAULT 0, available boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,source_id,external_listing_id)
);
CREATE INDEX IF NOT EXISTS idx_vp_competitor_listing_state ON volt_price.competitor_listings(tenant_id,available,last_seen_at DESC);

CREATE TABLE IF NOT EXISTS volt_price.market_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES volt_price.competitor_listings(id) ON DELETE CASCADE,
  product_id uuid REFERENCES volt_price.products(id) ON DELETE SET NULL,
  status text NOT NULL CHECK(status IN ('matched','review','unmatched','rejected')),
  confidence numeric(6,5) NOT NULL DEFAULT 0 CHECK(confidence>=0 AND confidence<=1), reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb, reviewed_by uuid REFERENCES volt_price.users(id) ON DELETE SET NULL, reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,listing_id)
);
CREATE INDEX IF NOT EXISTS idx_vp_market_match_review ON volt_price.market_matches(tenant_id,status,confidence DESC);

ALTER TABLE volt_price.market_observations
  ADD COLUMN IF NOT EXISTS source_id uuid REFERENCES volt_price.market_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS listing_id uuid REFERENCES volt_price.competitor_listings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS match_id uuid REFERENCES volt_price.market_matches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_listing_id text,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'BRL',
  ADD COLUMN IF NOT EXISTS available boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS source_ref text,
  ADD COLUMN IF NOT EXISTS fingerprint text,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_market_observation_current_ref
  ON volt_price.market_observations(tenant_id,source_ref) WHERE source_ref IS NOT NULL AND is_current;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_market_observation_fingerprint
  ON volt_price.market_observations(tenant_id,source_ref,fingerprint) WHERE source_ref IS NOT NULL AND fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vp_market_observation_history ON volt_price.market_observations(tenant_id,listing_id,observed_at DESC);

CREATE TABLE IF NOT EXISTS volt_price.market_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  source_id uuid REFERENCES volt_price.market_sources(id) ON DELETE SET NULL,
  listing_id uuid REFERENCES volt_price.competitor_listings(id) ON DELETE SET NULL,
  product_id uuid REFERENCES volt_price.products(id) ON DELETE SET NULL,
  source_observation_id uuid REFERENCES volt_price.market_observations(id) ON DELETE SET NULL,
  signal_type text NOT NULL CHECK(signal_type IN ('new_listing','out_of_stock','back_in_stock','price_drop','price_increase','below_market','above_market','match_review')),
  severity text NOT NULL DEFAULT 'info' CHECK(severity IN ('info','opportunity','warning','critical')),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved','ignored')),
  dedupe_key text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(), value numeric(18,6),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb, resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_vp_market_signal_open ON volt_price.market_signals(tenant_id,status,severity,observed_at DESC);

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['market_sources','competitor_listings','market_matches','market_signals'] LOOP
    EXECUTE format('ALTER TABLE volt_price.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE volt_price.%I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON volt_price.%I',tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON volt_price.%I USING (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id()) WITH CHECK (volt_price.is_platform_admin() OR tenant_id=volt_price.current_tenant_id())',tbl);
  END LOOP;
END $$;
