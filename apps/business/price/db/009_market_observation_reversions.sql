DROP INDEX IF EXISTS volt_price.uq_vp_market_observation_fingerprint;
CREATE INDEX IF NOT EXISTS idx_vp_market_observation_fingerprint
  ON volt_price.market_observations(tenant_id,source_ref,fingerprint,version DESC)
  WHERE source_ref IS NOT NULL AND fingerprint IS NOT NULL;
