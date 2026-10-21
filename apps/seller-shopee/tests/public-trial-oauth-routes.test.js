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

test("Shopee verified email opens activation form without starting the trial", async () => {
  const controller = createPublicTrialOAuthController({
    enabled: () => true,
    inspectActivation: async () => ({ id: "session-1", status: "email_pending" }),
    verifyEmail: async () => { throw new Error("GET must not consume email proof"); },
  });
  const res = response();
  await controller.verify({ query: { token: "verified-token" } }, res);
  assert.equal(res.redirectTo, "/shopee/trial-activate.html?token=verified-token");
});

test("Shopee activation finalizes locally only after exact Hub confirmation", async () => {
  const calls = [];
  const controller = createPublicTrialOAuthController({
    enabled: () => true, encryptionKey: () => "a".repeat(64),
    hashPassword: async () => "$2b$10$hash",
    inspectActivation: async () => ({ email: "new@example.com", status: "email_pending" }),
    lookupHubEmail: async () => ({ exists: false }),
    stageIdentity: async () => ({ sessionId: "session-1", tenantId: "tenant-1",
      globalUserId: "user-1", fullName: "Nome", companyName: "Empresa",
      email: "new@example.com", shopId: "123" }),
    activateHub: async () => { calls.push("hub"); return { trial: { endsAt: "2099-01-01T00:00:00Z" },
      resource: { resource_key: "shopee:123", tenant_id: "tenant-1", access_policy: "temporary" } }; },
    finalizeTrial: async () => { calls.push("local"); return { shopDbId: 30, trialActive: true }; },
  });
  const res = response();
  await controller.activate({ body: { token: "verified-token", full_name: "Nome",
    company_name: "Empresa", password: "StrongPass123" } }, res);
  assert.deepEqual(calls, ["hub", "local"]);
  assert.equal(res.body.action, "activated");
});

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

test("Shopee landing only offers public OAuth when the trial flag is enabled", async () => {
  const active = createPublicTrialOAuthController({ enabled: () => true });
  const inactive = createPublicTrialOAuthController({ enabled: () => false });
  const activeRes = response();
  const inactiveRes = response();
  await active.availability({}, activeRes);
  await inactive.availability({}, inactiveRes);
  assert.deepEqual(activeRes.body, { available: true });
  assert.deepEqual(inactiveRes.body, { available: false });
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/auth.routes.js"), "utf8");
  const landing = fs.readFileSync(path.join(__dirname, "../../gateway/views/seller/landing-shopee.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../../../public/brand/dachbyte/seller/landing.js"), "utf8");
  assert.match(routes, /\/auth\/trial\/availability/);
  assert.match(landing, /data-shopee-trial-start/);
  assert.match(script, /\/shopee\/auth\/trial\/start/);
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
  assert.equal(res.redirectTo, "/shopee/trial-email.html");
});

test("Shopee email handoff has a working form and never exposes tokens", () => {
  const page = fs.readFileSync(path.join(__dirname, "../public/trial-email.html"), "utf8");
  assert.match(page, /Confirme seu e-mail/);
  assert.match(page, /\/shopee\/auth\/trial\/email/);
  assert.match(page, /login_required/);
  assert.doesNotMatch(page, /access_token|refresh_token/);
});

test("Shopee activation page submits verified token and account details", () => {
  const page = fs.readFileSync(path.join(__dirname, "../public/trial-activate.html"), "utf8");
  assert.match(page, /Ativar meus 7 dias/);
  assert.match(page, /\/shopee\/auth\/trial\/activate/);
  assert.match(page, /URLSearchParams/);
  assert.doesNotMatch(page, /access_token|refresh_token/);
});

test("trial callback is dispatched before authenticated Shopee callback", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/auth.routes.js"), "utf8");
  assert.match(routes, /\/auth\/trial\/start/);
  assert.match(routes, /isTrialCallback[\s\S]*?PublicTrialOAuthController\.callback/);
  assert.match(routes, /sessionAuth[\s\S]*?AuthController\.callback/);
});

test("Shopee trial email requires a confirmed browser session and routes existing email to login", async () => {
  const calls = [];
  const controller = createPublicTrialOAuthController({
    enabled: () => true,
    loadConfirmedSession: async () => ({ id: "session-1" }),
    resolveEmail: async () => ({ email: "known@example.com", action: "login_required" }),
    prepareEmail: async (_client, input) => { calls.push(input); return { token: null }; },
    sendVerificationEmail: async () => { throw new Error("must not send"); },
  });
  const res = response();
  await controller.email({ body: { email: "known@example.com" }, cookies: {
    shopee_trial_oauth_nonce: "nonce",
  } }, res);
  assert.equal(res.body.action, "login_required");
  assert.equal(calls[0].action, "login_required");

  const missing = response();
  await controller.email({ body: { email: "known@example.com" }, cookies: {} }, missing);
  assert.equal(missing.statusCode, 403);
});

test("Shopee trial email sends one-time link only for a new address", async () => {
  const deliveries = [];
  const controller = createPublicTrialOAuthController({
    enabled: () => true,
    publicOrigin: () => "https://dachbyte.tech",
    loadConfirmedSession: async () => ({ id: "session-1" }),
    resolveEmail: async () => ({ email: "new@example.com", action: "send_activation" }),
    prepareEmail: async () => ({ token: "secret-token" }),
    sendVerificationEmail: async (input) => { deliveries.push(input); return { sent: true }; },
  });
  const res = response();
  await controller.email({ body: { email: "new@example.com" }, cookies: {
    shopee_trial_oauth_nonce: "nonce",
  } }, res);
  assert.equal(res.body.action, "verification_sent");
  assert.equal(deliveries[0].toEmail, "new@example.com");
  assert.equal(deliveries[0].activationLink,
    "https://dachbyte.tech/shopee/auth/trial/verify?token=secret-token");
});
