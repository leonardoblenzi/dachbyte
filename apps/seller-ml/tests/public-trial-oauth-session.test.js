"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createTrialOAuthSession,
  claimTrialOAuthCallback,
  saveTrialOAuthCredentials,
  prepareTrialEmailVerification,
  claimTrialEmailVerification,
  inspectTrialEmailVerification,
  loadConfirmedTrialOAuthSession,
  assertMlAccountAvailable,
} = require("../services/publicTrialOAuthSession");

test("public trial OAuth stores only hashes of the browser binding and state", async () => {
  const calls = [];
  const client = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } };
  const session = await createTrialOAuthSession(client, {
    codeVerifier: "verifier-secret", now: new Date("2026-10-20T12:00:00.000Z")
  });
  assert.notEqual(session.state, session.browserNonce);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO public_trial_oauth_sessions/i);
  assert.equal(calls[0].values.includes(session.state), false);
  assert.equal(calls[0].values.includes(session.browserNonce), false);
  assert.equal(calls[0].values.includes("verifier-secret"), true);
});

test("callback claim is conditional on state, browser cookie and unused deadline", async () => {
  let statement = "";
  const client = { query: async (sql) => {
    statement = sql;
    return { rows: [{ id: "session-1", code_verifier: "verifier-secret" }] };
  } };
  const row = await claimTrialOAuthCallback(client, { state: "state-secret", browserNonce: "browser-secret" });
  assert.equal(row.id, "session-1");
  assert.match(statement, /status\s*=\s*'issued'/i);
  assert.match(statement, /oauth_expires_at\s*>\s*NOW\(\)/i);
  assert.match(statement, /state_hash\s*=\s*\$1/i);
  assert.match(statement, /browser_nonce_hash\s*=\s*\$2/i);
  assert.match(statement, /RETURNING/i);
});

test("provisional credentials must be encrypted before persistence", async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ id: "session-1" }] };
  } };
  await saveTrialOAuthCredentials(client, {
    sessionId: "session-1", mlUserId: 123,
    accessToken: "plain-access", refreshToken: "plain-refresh",
    accessExpiresAt: new Date("2026-10-20T18:00:00.000Z"),
    encrypt: (value) => `encrypted:${value}`
  });
  assert.match(calls[0].sql, /status\s*=\s*'oauth_confirmed'/i);
  assert.equal(calls[0].values.includes("plain-access"), false);
  assert.equal(calls[0].values.includes("plain-refresh"), false);
  assert.equal(calls[0].values.includes("encrypted:plain-access"), true);
});

test("provisional credentials reject plaintext encryption fallbacks", async () => {
  let written = false;
  const client = { query: async () => { written = true; return { rows: [] }; } };
  await assert.rejects(saveTrialOAuthCredentials(client, {
    sessionId: "session-1", mlUserId: 123,
    accessToken: "plain-access", refreshToken: "plain-refresh",
    encrypt: (value) => value
  }), /trial_oauth_encryption_required/);
  assert.equal(written, false);
});

test("public OAuth remains disabled until the complete onboarding journey is ready", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/meliOAuthRoutes.js"), "utf8");
  assert.match(source, /SELLER_TRIAL_ONBOARDING_ENABLED/);
  assert.match(source, /if \(!trialOnboardingEnabled\(\)\) return res\.status\(404\)/);
  assert.match(source, /\[trial-redacted\]/);
  assert.match(source, /trial_public_origin_unavailable/);
});

test("migration keeps provisional OAuth separate from live marketplace accounts", () => {
  const source = fs.readFileSync(path.join(__dirname, "../db/078_public_seller_onboarding.sql"), "utf8");
  assert.match(source, /CREATE TABLE IF NOT EXISTS public_trial_oauth_sessions/i);
  assert.match(source, /state_hash\s+TEXT\s+NOT NULL\s+UNIQUE/i);
  assert.match(source, /browser_nonce_hash\s+TEXT\s+NOT NULL/i);
  assert.match(source, /oauth_expires_at\s+TIMESTAMPTZ\s+NOT NULL/i);
  assert.match(source, /status\s+TEXT\s+NOT NULL/i);
  assert.match(source, /activation_token_hash\s+TEXT\s+UNIQUE/i);
});

test("new email gets a one-time verification token without starting the trial", async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ id: "session-1", email: "new@example.test" }] };
  } };
  const prepared = await prepareTrialEmailVerification(client, {
    browserNonce: "browser-secret", email: "new@example.test", action: "send_activation"
  });
  assert.ok(prepared.token);
  assert.match(calls[0].sql, /status\s*=\s*'oauth_confirmed'/i);
  assert.match(calls[0].sql, /activation_expires_at\s*>\s*NOW\(\)/i);
  assert.equal(calls[0].values.includes("email_pending"), true);
  assert.equal(calls[0].values.includes(prepared.token), false);
  assert.equal(calls[0].sql.includes("seller_module_trials"), false);
});

test("verified email token can be claimed only while pending and not expired", async () => {
  let statement = "";
  const client = { query: async (sql) => {
    statement = sql;
    return { rows: [{ id: "session-1", email: "new@example.test", ml_user_id: 123 }] };
  } };
  const row = await claimTrialEmailVerification(client, { token: "email-secret" });
  assert.equal(row.id, "session-1");
  assert.match(statement, /status\s*=\s*'email_pending'/i);
  assert.match(statement, /activation_expires_at\s*>\s*NOW\(\)/i);
  assert.match(statement, /status\s*=\s*'activation_pending'/i);
});

test("activation can inspect a verified token without consuming it or exposing OAuth credentials", async () => {
  let statement = "";
  const client = { query: async (sql, values) => {
    statement = sql;
    assert.notEqual(values[0], "email-secret");
    return { rows: [{ id: "session-1", email: "new@example.test", status: "email_pending" }] };
  } };
  const row = await inspectTrialEmailVerification(client, "email-secret");
  assert.equal(row.email, "new@example.test");
  assert.match(statement, /activation_token_hash = \$1/i);
  assert.match(statement, /email_pending/);
  assert.doesNotMatch(statement, /access_token_enc|refresh_token_enc/i);
});

test("email lookup is gated by a confirmed OAuth session bound to the browser", async () => {
  let statement = "";
  const client = { query: async (sql) => {
    statement = sql;
    return { rows: [{ id: "session-1", ml_user_id: 123 }] };
  } };
  const row = await loadConfirmedTrialOAuthSession(client, "browser-secret");
  assert.equal(row.id, "session-1");
  assert.match(statement, /browser_nonce_hash\s*=\s*\$1/i);
  assert.match(statement, /activation_expires_at\s*>\s*NOW\(\)/i);
  assert.match(statement, /oauth_confirmed/);
});

test("an ML account already linked to any company cannot enter public trial staging", async () => {
  const client = { query: async (sql, values) => {
    assert.match(sql, /FROM meli_contas/i);
    assert.equal(values[0], 123);
    return { rows: [{ id: 9 }] };
  } };
  await assert.rejects(assertMlAccountAvailable(client, 123), /trial_ml_account_already_linked/);
});
