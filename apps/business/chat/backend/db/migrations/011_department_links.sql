CREATE TABLE IF NOT EXISTS department_links (
  id VARCHAR(36) PRIMARY KEY,
  company_id VARCHAR(36) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_department_id VARCHAR(36) NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  target_department_id VARCHAR(36) NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  label VARCHAR(120),
  created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_department_links_not_same CHECK (source_department_id <> target_department_id)
);

CREATE INDEX IF NOT EXISTS ix_department_links_company_id ON department_links (company_id);
CREATE INDEX IF NOT EXISTS ix_department_links_source_department_id ON department_links (source_department_id);
CREATE INDEX IF NOT EXISTS ix_department_links_target_department_id ON department_links (target_department_id);
