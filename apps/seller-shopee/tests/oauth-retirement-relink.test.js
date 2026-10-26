"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { buildResourceContext, assertOAuthResourceConfirmed } = require("../src/services/hubResourceBillingService");

test("Shopee marks only the verified shop OAuth callback for Hub reactivation", () => {
  const context = buildResourceContext({
    auth: { tenantGlobalId: "tenant-a" }, shop: { id: 7, shopId: 123n },
    oauthConfirmed: true,
  });
  assert.equal(context.oauthConfirmed, true);
  assert.equal(context.accountId, "123");
});

test("Shopee shop callback sends the confirmation but Ads callback does not", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/controllers/AuthController.js"), "utf8");
  assert.match(source, /oauthConfirmed:\s*authFlow\s*===\s*"shop"/);
  assert.match(source, /queueClosedMonthMeasurement\(postgres, shop\.id\)/,
    "a loja conectada deve iniciar a validação de faixa após o OAuth");
  assert.doesNotMatch(source, /isFirstHubShop/,
    "uma primeira loja autenticada não pode receber acesso ativo sem proposta");
  assert.match(source, /status:\s*isNewShop\s*\?\s*"awaiting_subscription"\s*:\s*"legacy_active"/);
  assert.match(source, /hubSyncError[\s\S]*?res\.status\(502\)/,
    "a falha de reativacao precisa ser exibida ao usuario apos salvar a loja local");
});

test("Shopee accepts an OAuth-linked resource that is inactive while it awaits a proposal", () => {
  const context = buildResourceContext({
    auth: { tenantGlobalId: "tenant-a" }, shop: { id: 7, shopId: 123n }, oauthConfirmed: true,
  });
  assert.doesNotThrow(() => assertOAuthResourceConfirmed(context, {
    resource: { resource_key: "shopee:123", access_policy: "inactive" },
    access: { allow: false, reason: "resource_inactive" },
  }));
});

test("Shopee rejects an OAuth confirmation for another marketplace identity", () => {
  const context = buildResourceContext({
    auth: { tenantGlobalId: "tenant-a" }, shop: { id: 7, shopId: 123n }, oauthConfirmed: true,
  });
  assert.throws(() => assertOAuthResourceConfirmed(context, {
    resource: { resource_key: "shopee:999" },
  }), (error) => error?.code === "hub_oauth_relink_invalid_response");
});
