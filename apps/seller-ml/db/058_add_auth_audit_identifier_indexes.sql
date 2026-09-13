CREATE INDEX IF NOT EXISTS auth_audit_metadata_mlb_id_upper_idx
  ON ml.auth_audit (upper(metadata ->> 'mlb_id'))
  WHERE metadata ? 'mlb_id';

CREATE INDEX IF NOT EXISTS auth_audit_metadata_item_id_upper_idx
  ON ml.auth_audit (upper(metadata ->> 'item_id'))
  WHERE metadata ? 'item_id';

CREATE INDEX IF NOT EXISTS auth_audit_metadata_promotion_id_upper_idx
  ON ml.auth_audit (upper(metadata ->> 'promotion_id'))
  WHERE metadata ? 'promotion_id';
