CREATE TABLE IF NOT EXISTS whatsapp_settings (
  company_id VARCHAR(36) PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  phone_number_id VARCHAR(120),
  business_account_id VARCHAR(120),
  display_phone VARCHAR(40),
  status VARCHAR(30) NOT NULL DEFAULT 'disconnected',
  bolt_mode VARCHAR(30) NOT NULL DEFAULT 'curation',
  access_token_encrypted TEXT,
  verify_token_hash VARCHAR(64),
  updated_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_tags (
  id VARCHAR(36) PRIMARY KEY,
  company_id VARCHAR(36) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(60) NOT NULL,
  color VARCHAR(20) NOT NULL DEFAULT '#2563eb',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, name)
);

CREATE TABLE IF NOT EXISTS whatsapp_automations (
  id VARCHAR(36) PRIMARY KEY,
  company_id VARCHAR(36) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  trigger_type VARCHAR(40) NOT NULL,
  trigger_value TEXT,
  response_text TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_bolt_curation (
  id VARCHAR(36) PRIMARY KEY,
  company_id VARCHAR(36) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  external_contact_id VARCHAR(120) NOT NULL,
  contact_name VARCHAR(160),
  incoming_excerpt TEXT NOT NULL,
  suggested_response TEXT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  reviewed_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_whatsapp_tags_company ON whatsapp_tags(company_id);
CREATE INDEX IF NOT EXISTS ix_whatsapp_automations_company ON whatsapp_automations(company_id, enabled);
CREATE INDEX IF NOT EXISTS ix_whatsapp_curation_company_status ON whatsapp_bolt_curation(company_id, status, created_at DESC);
