"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { readCookie } = require("../apps/ads/infrastructure/identity/HubIdentityProvider");
const { requireIdentity } = require("../apps/ads/http/middleware/requireIdentity");

const root = path.resolve(__dirname, "..");

function fakeResponse() {
  return {
    statusCode: 200,
    redirectStatus: null,
    redirectUrl: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    redirect(code, url) { this.redirectStatus = code; this.redirectUrl = url; return this; },
  };
}

test("cookie parser extracts the shared suite session", () => {
  assert.equal(readCookie("foo=1; suite_auth_token=abc.def.ghi; bar=2", "suite_auth_token"), "abc.def.ghi");
  assert.equal(readCookie("foo=1", "suite_auth_token"), "");
});

test("protected Ads HTML redirects anonymous users to the dedicated Ads login", async () => {
  const middleware = requireIdentity({ resolve: async () => ({ status: "anonymous" }) });
  const req = { method: "GET", originalUrl: "/ads/app" };
  const res = fakeResponse();
  await middleware(req, res, () => assert.fail("next must not run"));
  assert.equal(res.redirectStatus, 302);
  assert.equal(res.redirectUrl, "/ads/login");
});

test("protected Ads API returns 403 when Hub denies dach_ads", async () => {
  const middleware = requireIdentity({ resolve: async () => ({ status: "forbidden", reason: "product_not_installed", accessStatus: "blocked" }) });
  const req = { method: "GET", originalUrl: "/ads/api/session" };
  const res = fakeResponse();
  await middleware(req, res, () => assert.fail("next must not run"));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "dach_ads_access_denied");
});

test("suite login, gateway and platform selector expose dach_ads", () => {
  const suiteAuth = fs.readFileSync(path.join(root, "routes/suiteAuthRoutes.js"), "utf8");
  const gateway = fs.readFileSync(path.join(root, "apps/gateway/server.js"), "utf8");
  const selector = fs.readFileSync(path.join(root, "apps/seller-ml/views/selecao-plataforma.html"), "utf8");
  assert.match(suiteAuth, /id:\s*"dach_ads",\s*hubModule:\s*"dach_ads"/);
  assert.match(gateway, /\/go\/ads/);
  assert.match(gateway, /loginPath:\s*"\/ads\/login"/);
  assert.match(gateway, /deniedPath:\s*"\/ads\/access-denied"/);
  assert.match(selector, /data-module="dach_ads"/);
});
