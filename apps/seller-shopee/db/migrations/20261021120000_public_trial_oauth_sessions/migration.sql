CREATE TABLE IF NOT EXISTS public_trial_oauth_sessions (
  id UUID PRIMARY KEY,
  state_hash CHAR(64) NOT NULL UNIQUE,
  browser_nonce_hash CHAR(64) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('issued', 'claimed', 'oauth_confirmed', 'email_pending', 'awaiting_login', 'activation_pending', 'activated', 'expired')),
  oauth_expires_at TIMESTAMPTZ NOT NULL,
  activation_expires_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  shop_id BIGINT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  email TEXT,
  activation_token_hash CHAR(64) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS public_trial_oauth_sessions_browser_idx
  ON public_trial_oauth_sessions (browser_nonce_hash, status);
CREATE INDEX IF NOT EXISTS public_trial_oauth_sessions_expiry_idx
  ON public_trial_oauth_sessions (activation_expires_at)
  WHERE status <> 'activated';
