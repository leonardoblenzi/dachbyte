"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("DACH Ads is isolated as its own bounded context and enforces Hub auth in production", () => {
  assert.ok(fs.existsSync(path.join(root, "apps/ads/app.js")));
  assert.ok(fs.existsSync(path.join(root, "apps/ads/worker.js")));
  assert.ok(fs.existsSync(path.join(root, "apps/ads/application/ports/IdentityProvider.js")));

  const identityFactory = read("apps/ads/infrastructure/identity/createIdentityProvider.js");
  const hubIdentity = read("apps/ads/infrastructure/identity/HubIdentityProvider.js");
  assert.match(identityFactory, /createHubIdentityProvider/);
  assert.match(identityFactory, /development_identity_is_disabled_in_production/);
  assert.match(hubIdentity, /suite_auth_token/);
  assert.match(hubIdentity, /\/v1\/access\/check/);
  assert.match(hubIdentity, /hubAdsModule|dach_ads/);
  assert.doesNotMatch(identityFactory + hubIdentity, /password|bcrypt/i);
});

test("DACH Ads foundation schema is multi-tenant and enables PostgreSQL RLS", () => {
  const migration = read("apps/ads/db/001_foundation.sql");
  for (const table of [
    "ads_workspaces",
    "ads_workspace_memberships",
    "ads_provider_connections",
    "ads_ad_accounts",
    "ads_sync_runs",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(migration, /current_setting\('app\.tenant_id', true\)/);
});

test("DACH Ads public and authenticated surfaces have separate access semantics", async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    ADS_AUTH_MODE: process.env.ADS_AUTH_MODE,
  };
  process.env.NODE_ENV = "development";
  process.env.ADS_AUTH_MODE = "development";

  delete require.cache[require.resolve("../apps/ads/config/env")];
  delete require.cache[require.resolve("../apps/ads/infrastructure/identity/createIdentityProvider")];
  delete require.cache[require.resolve("../apps/ads/app")];
  const { createAdsApp } = require("../apps/ads/app");
  const app = createAdsApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const landing = await fetch(base + "/ads");
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /DACH Ads/);

    const session = await fetch(base + "/ads/api/session");
    assert.equal(session.status, 200);
    const payload = await session.json();
    assert.equal(payload.identity.tenantId, "tenant-dev");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.ADS_AUTH_MODE === undefined) delete process.env.ADS_AUTH_MODE; else process.env.ADS_AUTH_MODE = previous.ADS_AUTH_MODE;
  }
});
