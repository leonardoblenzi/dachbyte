"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  prepareTrialEmail,
  loadConfirmedTrialSession,
  inspectTrialActivation,
} = require("../src/services/publicTrialOAuthSession");

test("new Shopee trial email stores only a token digest for the confirmed OAuth session", async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ id: "session-1", activation_expires_at: "2026-10-22T12:00:00Z" }] };
  } };
  const prepared = await prepareTrialEmail(client, {
    browserNonce: "nonce", email: " USER@EXAMPLE.COM ", action: "send_activation",
  });
  assert.equal(prepared.email, "user@example.com");
  assert.equal(prepared.action, "send_activation");
  assert.equal(typeof prepared.token, "string");
  assert.equal(calls[0].values.includes(prepared.token), false);
  assert.match(calls[0].sql, /status = 'oauth_confirmed'/);
  assert.match(calls[0].sql, /activation_expires_at > NOW\(\)/);
});

test("existing email requires login and never generates an activation token", async () => {
  const client = { query: async (_sql, values) => ({ rows: [{ id: "session-1", email: values[2] }] }) };
  const prepared = await prepareTrialEmail(client, {
    browserNonce: "nonce", email: "user@example.com", action: "login_required",
  });
  assert.equal(prepared.token, null);
  assert.equal(prepared.action, "login_required");
});

test("opening the email link does not consume it before activation", async () => {
  const client = { query: async (sql, values) => {
    assert.match(sql, /^SELECT/);
    assert.match(sql, /status IN \('email_pending', 'identity_staged'\)/);
    assert.notEqual(values[0], "raw-token");
    return { rows: [{ id: "session-1", email: "user@example.com", status: "email_pending" }] };
  } };
  assert.equal((await inspectTrialActivation(client, "raw-token")).id, "session-1");
  assert.equal((await inspectTrialActivation(client, "raw-token")).id, "session-1");
});

test("email submission can read only a confirmed, unexpired browser session", async () => {
  const client = { query: async (sql, values) => {
    assert.match(sql, /status = 'oauth_confirmed' AND activation_expires_at > NOW\(\)/);
    assert.notEqual(values[0], "nonce");
    return { rows: [{ id: "session-1" }] };
  } };
  assert.equal((await loadConfirmedTrialSession(client, "nonce")).id, "session-1");
});

test("provisional Shopee tokens keep both expiry times for finalization", async () => {
  const { saveProvisionalCredentials } = require("../src/services/publicTrialOAuthSession");
  let values;
  const client = { query: async (_sql, params) => { values = params; return { rows: [{ id: "session-1" }] }; } };
  await saveProvisionalCredentials(client, {
    sessionId: "session-1", shopId: "123", accessToken: "access", refreshToken: "refresh",
    encryptionKey: "a".repeat(64), accessExpiresIn: 3600, refreshExpiresIn: 86400,
    now: new Date("2026-10-21T12:00:00Z"),
  });
  assert.equal(values[4], "2026-10-21T13:00:00.000Z");
  assert.equal(values[5], "2026-10-22T12:00:00.000Z");
});

test("activation inspects pending email before staging a local identity", async () => {
  const client = { query: async (sql, values) => {
    assert.match(sql, /status IN \('email_pending', 'identity_staged'\)/);
    assert.notEqual(values[0], "token");
    return { rows: [{ id: "session-1", email: "new@example.com", status: "email_pending" }] };
  } };
  assert.equal((await inspectTrialActivation(client, "token")).email, "new@example.com");
});
