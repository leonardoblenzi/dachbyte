"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { createPublicTrialOAuthController } = require("../src/controllers/PublicTrialOAuthController");

function response() {
  return {
    statusCode: 200, cookies: [], redirectTo: null, body: null,
    status(code) { this.statusCode = code; return this; },
    cookie(...args) { this.cookies.push(args); return this; },
    json(body) { this.body = body; return this; },
    redirect(url) { this.redirectTo = url; return this; },
  };
}

test("Shopee public trial start is gated and binds a short-lived state to a browser cookie", async () => {
  const calls = [];
  const controller = createPublicTrialOAuthController({
    enabled: () => true,
    encryptionKey: () => "a".repeat(64),
    shopeeConfig: { SHOPEE_API_BASE: "https://shopee.example", PARTNER_ID: 1,
      PARTNER_KEY: "key", REDIRECT_URL: "https://example.test/callback" },
    createSession: async () => ({ state: "trial_unique", browserNonce: "nonce" }),
    buildAuthUrl: ({ state }) => { calls.push(state); return `https://shopee.example/authorize?state=${state}`; },
  });
  const res = response();
  await controller.start({ query: {} }, res);
  assert.deepEqual(calls, ["trial_unique"]);
  assert.equal(res.cookies[0][0], "shopee_trial_oauth_nonce");
  assert.equal(res.cookies[0][1], "nonce");
  assert.equal(res.cookies[0][2].httpOnly, true);
  assert.equal(res.cookies[0][2].sameSite, "lax");
  assert.equal(res.cookies[0][2].maxAge, 10 * 60 * 1000);
  assert.equal(res.body.auth_url.includes("trial_unique"), true);

  const disabled = createPublicTrialOAuthController({ enabled: () => false });
  const disabledRes = response();
  await disabled.start({ query: {} }, disabledRes);
  assert.equal(disabledRes.statusCode, 404);
});

test("Shopee public callback rejects missing browser proof without exchanging or linking", async () => {
  let exchanged = 0;
  const controller = createPublicTrialOAuthController({
    enabled: () => true, encryptionKey: () => "a".repeat(64),
    claimCallback: async () => null,
    exchangeToken: async () => { exchanged += 1; },
  });
  const res = response();
  await controller.callback({ query: { state: "trial_x", code: "code", shop_id: "123" }, cookies: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(exchanged, 0);
});

test("Shopee public callback stages credentials but never creates an operational shop", async () => {
  const calls = [];
  const controller = createPublicTrialOAuthController({
    enabled: () => true, encryptionKey: () => "a".repeat(64),
    claimCallback: async (_client, input) => { calls.push(["claim", input]); return { id: "session-1" }; },
    findShop: async () => null,
    exchangeToken: async (input) => {
      calls.push(["exchange", input]);
      return { access_token: "access", refresh_token: "refresh" };
    },
    saveCredentials: async (_client, input) => { calls.push(["save", input]); },
  });
  const res = response();
  await controller.callback({
    query: { state: "trial_x", code: "code", shop_id: "123" },
    cookies: { shopee_trial_oauth_nonce: "nonce" },
  }, res);
  assert.equal(calls[0][0], "claim");
  assert.equal(calls[1][1].persist, false);
  assert.equal(calls[2][1].sessionId, "session-1");
  assert.equal(res.cookies[0][0], "shopee_trial_oauth_nonce");
  assert.equal(res.cookies[0][2].maxAge, 24 * 60 * 60 * 1000);
  assert.equal(res.redirectTo, "/selecao-plataforma?trial=shopee_email_required");
});

test("trial callback is dispatched before authenticated Shopee callback", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/auth.routes.js"), "utf8");
  assert.match(routes, /\/auth\/trial\/start/);
  assert.match(routes, /isTrialCallback[\s\S]*?PublicTrialOAuthController\.callback/);
  assert.match(routes, /sessionAuth[\s\S]*?AuthController\.callback/);
});
