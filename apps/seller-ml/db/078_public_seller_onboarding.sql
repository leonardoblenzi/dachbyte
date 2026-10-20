-- Provisional ML OAuth credentials are not operational accounts. The browser
-- binding and OAuth state are stored only as hashes; tokens must be encrypted
-- by the application before insertion. No trial clock starts in this table.
CREATE TABLE IF NOT EXISTS public_trial_oauth_sessions (
  id UUID PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  browser_nonce_hash TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  oauth_expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',
  ml_user_id BIGINT NULL,
  access_token_enc TEXT NULL,
  refresh_token_enc TEXT NULL,
  access_expires_at TIMESTAMPTZ NULL,
  scope TEXT NULL,
  activation_expires_at TIMESTAMPTZ NULL,
  email TEXT NULL,
  claimed_at TIMESTAMPTZ NULL,
  activated_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT public_trial_oauth_sessions_status_check CHECK (
    status IN ('issued', 'claimed', 'oauth_confirmed', 'email_pending',
      'awaiting_login', 'activation_pending', 'activated', 'expired')
  )
);

CREATE INDEX IF NOT EXISTS ix_public_trial_oauth_sessions_cleanup
  ON public_trial_oauth_sessions (oauth_expires_at, activation_expires_at, status);
