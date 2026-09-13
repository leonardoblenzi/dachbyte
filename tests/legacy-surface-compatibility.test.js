"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { LEGACY_SURFACE_REGISTRY, listLegacySurface } = require("../platform/compatibility/legacySurfaceRegistry");

const root = path.resolve(__dirname, "..");
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("legacy compatibility registry remains versioned and blocked before a DACHBYTE domain", () => {
  assert.equal(LEGACY_SURFACE_REGISTRY.version, 1);
  assert.equal(LEGACY_SURFACE_REGISTRY.status, "pre-canonical-domain");
  assert.match(LEGACY_SURFACE_REGISTRY.removalBlockedUntil, /canonical domain/i);
  assert.deepEqual(listLegacySurface(), {
    routes: [...LEGACY_SURFACE_REGISTRY.routes],
    cookies: [...LEGACY_SURFACE_REGISTRY.cookies],
    oauthCallbacks: [...LEGACY_SURFACE_REGISTRY.oauthCallbacks],
  });
});

test("legacy mounts and redirect routes stay present while the new domain is unconfigured", () => {
  const gateway = source("apps/gateway/server.js");
  const business = source("apps/business/app.js");
  for (const route of ["/ml", "/shopee", "/madeiramadeira", "/avantracking", "/davanttilog", "/skuleader"]) {
    assert.ok(gateway.includes(`app.use("${route}"`), `gateway legacy route ${route} must remain mounted`);
  }
  for (const route of ["/volt-price", "/voltstock", "/chat", "/voltchat", "/volt_chat"]) {
    assert.ok(business.includes(route), `business legacy route ${route} must remain mounted`);
  }
  assert.ok(gateway.includes("/sacdavantti"), "legacy support URL must remain reachable");
});

test("legacy session cookies and OAuth callback paths stay represented in their owning runtimes", () => {
  const gateway = source("apps/gateway/server.js");
  const business = source("apps/business/app.js");
  const priceConfig = source("apps/business/price/src/config.js");
  const priceIntegrations = source("apps/business/price/src/routes/integrations.routes.js");
  const ml = source("apps/seller-ml/app.js");
  const shopee = source("apps/seller-shopee/src/routes/auth.routes.js");

  for (const cookie of ["suite_auth_token", "auth_token", "sid", "skuleader_auth_token", "davanttilog_token"]) {
    assert.ok(gateway.includes(cookie), `gateway legacy cookie ${cookie} must remain supported`);
  }
  assert.ok(business.includes("volt_core_session"));
  assert.ok(priceConfig.includes("volt_price_session"));
  assert.ok(ml.includes("/api/meli/oauth/callback"));
  assert.ok(gateway.includes("/api/meli/oauth/callback"));
  assert.ok(shopee.includes("/auth/callback"));
  for (const provider of ["/tray/callback", "/meli/callback", "/shopee/callback"]) {
    assert.ok(priceIntegrations.includes(provider), `Volt Price OAuth callback ${provider} must remain registered`);
  }
});
