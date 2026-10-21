"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createProvisionalSession,
  claimProvisionalCallback,
  encryptTrialToken,
  decryptTrialToken,
  saveProvisionalCredentials,
} = require("../src/services/publicTrialOAuthSession");

const key = "a".repeat(64);

test("provisional Shopee OAuth hashes browser proofs and expires quickly", async () => {
  const calls = [];
  const client = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } };
  const session = await createProvisionalSession(client, { now: new Date("2026-10-21T12:00:00Z") });
  assert.match(session.state, /^trial_/);
  assert.notEqual(session.state, session.browserNonce);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql.includes("public_trial_oauth_sessions"), true);
  assert.equal(calls[0].values.includes(session.state), false);
  assert.equal(calls[0].values.includes(session.browserNonce), false);
  assert.equal(calls[0].values[3], "2026-10-21T12:10:00.000Z");
});

test("callback claim is atomic, single-use, and bound to the browser cookie", async () => {
  const calls = [];
  const client = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: calls.length === 1 ? [{ id: "session-1" }] : [] }; } };
  const first = await claimProvisionalCallback(client, { state: "trial_state", browserNonce: "nonce" });
  const replay = await claimProvisionalCallback(client, { state: "trial_state", browserNonce: "nonce" });
  assert.equal(first.id, "session-1");
  assert.equal(replay, null);
  assert.match(calls[0].sql, /status = 'issued' AND oauth_expires_at > NOW\(\)/);
  assert.equal(calls[0].values.length, 2);
  assert.notEqual(calls[0].values[0], "trial_state");
  assert.notEqual(calls[0].values[1], "nonce");
});

test("provisional credentials use authenticated encryption and reject tampering", () => {
  const sealed = encryptTrialToken("sensitive-token", key);
  assert.equal(sealed.includes("sensitive-token"), false);
  assert.equal(decryptTrialToken(sealed, key), "sensitive-token");
  const parts = sealed.split(":");
  parts[2] = `${parts[2].slice(0, -1)}${parts[2].endsWith("0") ? "1" : "0"}`;
  assert.throws(() => decryptTrialToken(parts.join(":"), key));
  assert.throws(() => encryptTrialToken("token", ""), /trial_encryption_key_invalid/);
});

test("provisional credentials are persisted encrypted only after callback claim", async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ id: "session-1", shop_id: "123" }] };
  } };
  await saveProvisionalCredentials(client, {
    sessionId: "session-1", shopId: "123", accessToken: "access-secret",
    refreshToken: "refresh-secret", encryptionKey: key,
  });
  assert.match(calls[0].sql, /status = 'claimed'/);
  assert.match(calls[0].sql, /status = 'oauth_confirmed'/);
  assert.equal(calls[0].values.includes("access-secret"), false);
  assert.equal(calls[0].values.includes("refresh-secret"), false);
  assert.equal(decryptTrialToken(calls[0].values[2], key), "access-secret");
  assert.equal(decryptTrialToken(calls[0].values[3], key), "refresh-secret");
});
