CREATE TABLE IF NOT EXISTS meetings (
  id VARCHAR(36) PRIMARY KEY,
  company_id VARCHAR(36) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  creator_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(180) NOT NULL,
  description TEXT,
  meeting_type VARCHAR(30) NOT NULL DEFAULT 'reminder',
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  color VARCHAR(20) NOT NULL DEFAULT '#2563eb',
  status VARCHAR(30) NOT NULL DEFAULT 'scheduled',
  reminder_day_sent BOOLEAN NOT NULL DEFAULT FALSE,
  reminder_30m_sent BOOLEAN NOT NULL DEFAULT FALSE,
  start_alert_sent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (meeting_type IN ('reminder', 'video')),
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_id VARCHAR(36) NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response_status VARCHAR(30) NOT NULL DEFAULT 'pending',
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  PRIMARY KEY (meeting_id, user_id)
);

CREATE INDEX IF NOT EXISTS ix_meetings_company_starts ON meetings(company_id, starts_at);
CREATE INDEX IF NOT EXISTS ix_meeting_participants_user ON meeting_participants(user_id, meeting_id);
