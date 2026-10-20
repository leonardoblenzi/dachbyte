"use strict";

const crypto = require("node:crypto");
const { normalizeEmail } = require("./publicTrialEmailResolution");

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function secret() {
  return crypto.randomBytes(32).toString("base64url");
}

async function createTrialOAuthSession(client, { codeVerifier, now = new Date() }) {
  if (!String(codeVerifier || "").trim()) throw new Error("trial_oauth_verifier_required");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("trial_oauth_time_invalid");
  }
  const id = crypto.randomUUID();
  const state = `trial_${secret()}`;
  const browserNonce = secret();
  const oauthExpiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  await client.query(
    `INSERT INTO public_trial_oauth_sessions
       (id, state_hash, browser_nonce_hash, code_verifier, oauth_expires_at, status)
     VALUES ($1, $2, $3, $4, $5, 'issued')`,
    [id, digest(state), digest(browserNonce), codeVerifier, oauthExpiresAt.toISOString()]
  );
  return { id, state, browserNonce, oauthExpiresAt };
}

async function claimTrialOAuthCallback(client, { state, browserNonce }) {
  if (!state || !browserNonce) return null;
  const result = await client.query(
    `UPDATE public_trial_oauth_sessions
        SET status = 'claimed', claimed_at = NOW(), updated_at = NOW()
      WHERE state_hash = $1 AND browser_nonce_hash = $2
        AND status = 'issued' AND oauth_expires_at > NOW()
      RETURNING id, code_verifier`,
    [digest(state), digest(browserNonce)]
  );
  return result.rows[0] || null;
}

async function saveTrialOAuthCredentials(client, input) {
  const sessionId = String(input.sessionId || "").trim();
  const mlUserId = Number(input.mlUserId);
  const accessToken = String(input.accessToken || "");
  const refreshToken = String(input.refreshToken || "");
  if (!sessionId || !Number.isSafeInteger(mlUserId) || mlUserId <= 0 ||
      !accessToken || !refreshToken || typeof input.encrypt !== "function") {
    throw new Error("trial_oauth_credentials_invalid");
  }
  const encryptedAccess = input.encrypt(accessToken);
  const encryptedRefresh = input.encrypt(refreshToken);
  if (!encryptedAccess || !encryptedRefresh ||
      encryptedAccess === accessToken || encryptedRefresh === refreshToken) {
    throw new Error("trial_oauth_encryption_required");
  }
  const expiresAt = input.accessExpiresAt instanceof Date && Number.isFinite(input.accessExpiresAt.getTime())
    ? input.accessExpiresAt.toISOString() : null;
  const result = await client.query(
    `UPDATE public_trial_oauth_sessions
        SET status = 'oauth_confirmed', ml_user_id = $2,
            access_token_enc = $3, refresh_token_enc = $4,
            access_expires_at = $5, scope = $6,
            activation_expires_at = NOW() + INTERVAL '24 hours', updated_at = NOW()
      WHERE id = $1 AND status = 'claimed'
      RETURNING id, ml_user_id, activation_expires_at`,
    [sessionId, mlUserId, encryptedAccess, encryptedRefresh, expiresAt,
      String(input.scope || "").trim() || null]
  );
  if (!result.rows[0]) throw new Error("trial_oauth_session_not_claimed");
  return result.rows[0];
}

async function assertMlAccountAvailable(client, mlUserId) {
  const id = Number(mlUserId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("trial_ml_account_invalid");
  const result = await client.query(
    `SELECT id FROM meli_contas WHERE meli_user_id = $1 LIMIT 1`, [id]
  );
  if (result.rows[0]) throw new Error("trial_ml_account_already_linked");
}

async function prepareTrialEmailVerification(client, input) {
  const browserNonce = String(input.browserNonce || "").trim();
  const email = normalizeEmail(input.email);
  const action = String(input.action || "");
  if (!browserNonce || !["send_activation", "login_required"].includes(action)) {
    throw new Error("trial_email_preparation_invalid");
  }
  const token = action === "send_activation" ? secret() : null;
  const status = action === "send_activation" ? "email_pending" : "awaiting_login";
  const result = await client.query(
    `UPDATE public_trial_oauth_sessions
        SET status = $2, email = $3, activation_token_hash = $4, updated_at = NOW()
      WHERE browser_nonce_hash = $1
        AND (status = 'oauth_confirmed' OR (status = 'email_pending' AND email = $3))
        AND activation_expires_at > NOW()
      RETURNING id, email, activation_expires_at`,
    [digest(browserNonce), status, email, token ? digest(token) : null]
  );
  if (!result.rows[0]) throw new Error("trial_oauth_session_not_confirmed");
  return { ...result.rows[0], action, token };
}

async function loadConfirmedTrialOAuthSession(client, browserNonce) {
  const nonce = String(browserNonce || "").trim();
  if (!nonce) return null;
  const result = await client.query(
    `SELECT id, ml_user_id, email, status
       FROM public_trial_oauth_sessions
      WHERE browser_nonce_hash = $1 AND status IN ('oauth_confirmed', 'email_pending')
        AND activation_expires_at > NOW()
      LIMIT 1`,
    [digest(nonce)]
  );
  return result.rows[0] || null;
}

async function claimTrialEmailVerification(client, input) {
  const token = String(input.token || "").trim();
  if (!token) return null;
  const result = await client.query(
    `UPDATE public_trial_oauth_sessions
        SET status = 'activation_pending', updated_at = NOW()
      WHERE activation_token_hash = $1 AND status = 'email_pending'
        AND activation_expires_at > NOW()
      RETURNING id, email, ml_user_id, access_token_enc, refresh_token_enc,
        access_expires_at, scope, activation_expires_at`,
    [digest(token)]
  );
  return result.rows[0] || null;
}

module.exports = {
  createTrialOAuthSession,
  claimTrialOAuthCallback,
  saveTrialOAuthCredentials,
  prepareTrialEmailVerification,
  claimTrialEmailVerification,
  loadConfirmedTrialOAuthSession,
  assertMlAccountAvailable,
};
