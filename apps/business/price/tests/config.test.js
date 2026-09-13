"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const configPath = path.join(__dirname, "..", "src", "config.js");
const envExample = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");
const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

function loadConfig(overrides) {
  const environment = {
    ...process.env,
    DB_VOLTPRICE: "",
    DB_VOLTPRICE_DIRECT: "",
    VOLT_PRICE_DATABASE_URL: "",
    VOLT_PRICE_DIRECT_DATABASE_URL: "",
    DATABASE_URL: "",
    SHOPEE_PARTNER_ID: "",
    SHOPEE_PARTNER_KEY: "",
    VOLT_PRICE_SHOPEE_PARTNER_ID: "",
    VOLT_PRICE_SHOPEE_PARTNER_KEY: "",
    NODE_ENV: "test",
    ...overrides,
  };
  const script = `const { config } = require(${JSON.stringify(configPath)}); process.stdout.write(JSON.stringify({ databaseUrl: config.databaseUrl, directDatabaseUrl: config.directDatabaseUrl, shopee: config.shopee }));`;
  return JSON.parse(execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: environment,
  }));
}

function loadDatabaseConfig(overrides) {
  const { databaseUrl, directDatabaseUrl } = loadConfig(overrides);
  return { databaseUrl, directDatabaseUrl };
}

test("DB_VOLTPRICE e DB_VOLTPRICE_DIRECT tem prioridade", () => {
  const config = loadDatabaseConfig({
    DB_VOLTPRICE: "postgres://pooled",
    DB_VOLTPRICE_DIRECT: "postgres://direct",
    VOLT_PRICE_DATABASE_URL: "postgres://legacy-pooled",
    VOLT_PRICE_DIRECT_DATABASE_URL: "postgres://legacy-direct",
  });
  assert.deepEqual(config, {
    databaseUrl: "postgres://pooled",
    directDatabaseUrl: "postgres://direct",
  });
});

test("nomes legados continuam funcionando como fallback", () => {
  const config = loadDatabaseConfig({ VOLT_PRICE_DATABASE_URL: "postgres://legacy" });
  assert.equal(config.databaseUrl, "postgres://legacy");
  assert.equal(config.directDatabaseUrl, "postgres://legacy");
});

test("configura??o Mercado Livre informa credenciais e callback exato", () => {
  assert.match(envExample, /^VOLT_PRICE_MELI_CLIENT_ID=/m);
  assert.match(envExample, /^VOLT_PRICE_MELI_CLIENT_SECRET=/m);
  assert.match(readme, /VOLT_PRICE_PUBLIC_BASE_URL/);
  assert.match(readme, /\/volt-price\/api\/integrations\/meli\/callback/);
  assert.match(readme, /n?o.*(?:access token|refresh token|senha).*manual/i);
});

test("Shopee usa as variaveis VoltPrice e mantem os defaults operacionais", () => {
  const { shopee } = loadConfig({
    VOLT_PRICE_SHOPEE_PARTNER_ID: "12345",
    VOLT_PRICE_SHOPEE_PARTNER_KEY: "partner-key",
  });
  assert.deepEqual(shopee, {
    partnerId: "12345",
    partnerKey: "partner-key",
    apiBase: "https://partner.shopeemobile.com",
    authPartnerPath: "/api/v2/shop/auth_partner",
    tokenPath: "/api/v2/auth/token/get",
    refreshPath: "/api/v2/auth/access_token/get",
    escrowPath: "/api/v2/payment/get_escrow_detail",
    orderListPath: "/api/v2/order/get_order_list",
    orderDetailPath: "/api/v2/order/get_order_detail",
  });
});

test("Shopee aceita somente os aliases legados como fallback", () => {
  const { shopee } = loadConfig({
    SHOPEE_PARTNER_ID: "legacy-id",
    SHOPEE_PARTNER_KEY: "legacy-key",
    VOLT_PRICE_SHOPEE_API_BASE: "https://partner.example.test",
  });
  assert.equal(shopee.partnerId, "legacy-id");
  assert.equal(shopee.partnerKey, "legacy-key");
  assert.equal(shopee.apiBase, "https://partner.example.test");
});
