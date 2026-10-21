"use strict";

const crypto = require("node:crypto");

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function encryptionKey(value) {
  if (!/^[a-f0-9]{64}$/i.test(String(value || ""))) {
    throw new Error("trial_encryption_key_invalid");
  }
  return Buffer.from(value, "hex");
}

function encryptTrialToken(token, key) {
  if (!String(token || "")) throw new Error("trial_token_required");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(String(token), "utf8"), cipher.final()]);
  return ["v1", iv.toString("hex"), ciphertext.toString("hex"), cipher.getAuthTag().toString("hex")].join(":");
}

function decryptTrialToken(sealed, key) {
  const [version, ivHex, cipherHex, tagHex, extra] = String(sealed || "").split(":");
  if (version !== "v1" || extra !== undefined || !/^[a-f0-9]{24}$/i.test(ivHex || "") ||
      !/^[a-f0-9]+$/i.test(cipherHex || "") || !/^[a-f0-9]{32}$/i.test(tagHex || "")) {
    throw new Error("trial_token_ciphertext_invalid");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(key), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(cipherHex, "hex")), decipher.final()]).toString("utf8");
}

async function createProvisionalSession(client, { now = new Date() } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("trial_oauth_time_invalid");
  const id = crypto.randomUUID();
  const state = `trial_${crypto.randomBytes(32).toString("base64url")}`;
  const browserNonce = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  await client.query(
    `INSERT INTO public_trial_oauth_sessions
       (id, state_hash, browser_nonce_hash, oauth_expires_at, status)
     VALUES ($1, $2, $3, $4, 'issued')`,
    [id, digest(state), digest(browserNonce), expiresAt],
  );
  return { id, state, browserNonce, expiresAt };
}

async function claimProvisionalCallback(client, { state, browserNonce }) {
  if (!String(state || "").startsWith("trial_") || !browserNonce) return null;
  const result = await client.query(
    `UPDATE public_trial_oauth_sessions
        SET status = 'claimed', claimed_at = NOW(), updated_at = NOW()
      WHERE state_hash = $1 AND browser_nonce_hash = $2
        AND status = 'issued' AND oauth_expires_at > NOW()
      RETURNING id`,
    [digest(state), digest(browserNonce)],
  );
  return result.rows[0] || null;
}

async function saveProvisionalCredentials(client, input) {
  const sessionId = String(input.sessionId || "").trim();
  const shopId = String(input.shopId || "").trim();
  if (!sessionId || !/^\d+$/.test(shopId) || BigInt(shopId) <= 0n) {
    throw new Error("trial_oauth_credentials_invalid");
  }
  const access = encryptTrialToken(input.accessToken, input.encryptionKey);
  const refresh = encryptTrialToken(input.refreshToken, input.encryptionKey);
  const now = input.now instanceof Date ? input.now : new Date();
  const expiresAt = (seconds) => {
    const value = Number(seconds);
    return Number.isFinite(value) && value > 0 && Number.isFinite(now.getTime())
      ? new Date(now.getTime() + value * 1000).toISOString() : null;
  };
  const result = await client.query(
    `UPDATE public_trial_oauth_sessions
        SET status = 'oauth_confirmed', shop_id = $2,
            access_token_enc = $3, refresh_token_enc = $4,
            access_expires_at = $5, refresh_expires_at = $6,
            activation_expires_at = NOW() + INTERVAL '24 hours', updated_at = NOW()
      WHERE id = $1 AND status = 'claimed'
      RETURNING id, shop_id`,
    [sessionId, shopId, access, refresh,
      expiresAt(input.accessExpiresIn), expiresAt(input.refreshExpiresIn)],
  );
  if (!result.rows[0]) throw new Error("trial_oauth_session_not_claimed");
  return result.rows[0];
}

function normalizeTrialEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("trial_email_invalid");
  return email;
}

async function prepareTrialEmail(client, input) {
  const nonce = String(input.browserNonce || "").trim();
  const email = normalizeTrialEmail(input.email);
  const action = String(input.action || "");
  if (!nonce || !["send_activation", "login_required"].includes(action)) {
    throw new Error("trial_email_preparation_invalid");
  }
  const token = action === "send_activation" ? crypto.randomBytes(32).toString("base64url") : null;
  const status = action === "send_activation" ? "email_pending" : "awaiting_login";
  const result = await client.query(
    `UPDATE public_trial_oauth_sessions
        SET status = $2, email = $3, activation_token_hash = $4, updated_at = NOW()
      WHERE browser_nonce_hash = $1
        AND (status = 'oauth_confirmed' OR (status = 'email_pending' AND email = $3))
        AND activation_expires_at > NOW()
      RETURNING id, activation_expires_at`,
    [digest(nonce), status, email, token ? digest(token) : null],
  );
  if (!result.rows[0]) throw new Error("trial_oauth_session_not_confirmed");
  return { ...result.rows[0], email, action, token };
}

async function loadConfirmedTrialSession(client, browserNonce) {
  if (!String(browserNonce || "").trim()) return null;
  const result = await client.query(
    `SELECT id, shop_id FROM public_trial_oauth_sessions
      WHERE browser_nonce_hash = $1
        AND status = 'oauth_confirmed' AND activation_expires_at > NOW()
      LIMIT 1`,
    [digest(browserNonce)],
  );
  return result.rows[0] || null;
}

async function inspectTrialActivation(client, token) {
  if (!String(token || "").trim()) return null;
  const result = await client.query(
    `SELECT id, email, status FROM public_trial_oauth_sessions
      WHERE activation_token_hash = $1
        AND status IN ('email_pending', 'identity_staged')
        AND (activation_expires_at > NOW() OR recovery_expires_at > NOW())
      LIMIT 1`,
    [digest(token)],
  );
  return result.rows[0] || null;
}

module.exports = {
  createProvisionalSession,
  claimProvisionalCallback,
  encryptTrialToken,
  decryptTrialToken,
  saveProvisionalCredentials,
  prepareTrialEmail,
  loadConfirmedTrialSession,
  inspectTrialActivation,
};
