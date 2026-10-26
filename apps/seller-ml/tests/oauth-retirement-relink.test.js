"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("ML confirms Hub reactivation only after a provider OAuth callback", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/meliOAuthRoutes.js"), "utf8");
  assert.match(source, /confirmMlHubResourceAfterOAuth\(/);
  assert.match(source, /hubRelinkError[\s\S]*?res\.status\(502\)/,
    "a falha de reativacao precisa ser exibida ao usuario apos salvar a conta local");
  const { createMlHubRelink } = require("../services/hubResourceRelinkService");
  let request;
  const confirm = createMlHubRelink({
    baseUrl: "https://hub.example", token: "internal-token",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        ok: true, resource: { resource_key: "ml:123" }, access: { allow: true }
      }), { status: 200 });
    }
  });
  await confirm({ tenantId: "tenant-a", accountId: "123", label: "Loja" });
  assert.equal(request.url, "https://hub.example/v1/internal/resources/sync");
  assert.deepEqual(JSON.parse(request.options.body), {
    tenant_id: "tenant-a", module_slug: "ml", account_id: "123", label: "Loja", oauth_confirmed: true
  });
});

test("ML accepts an OAuth-linked resource that is intentionally inactive pending a proposal", async () => {
  const { createMlHubRelink } = require("../services/hubResourceRelinkService");
  const confirm = createMlHubRelink({
    baseUrl: "https://hub.example", token: "internal-token",
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      resource: { resource_key: "ml:123", access_policy: "inactive" },
      access: { allow: false, reason: "resource_inactive" }
    }), { status: 200 })
  });
  const result = await confirm({ tenantId: "tenant-a", accountId: "123", label: "Loja" });
  assert.equal(result.resource.resource_key, "ml:123");
  assert.equal(result.access.allow, false);
});

test("ML OAuth queues closed-month measurement after the local account is linked", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/meliOAuthRoutes.js"), "utf8");
  assert.match(source, /queueClosedMonthMeasurement\(db, outcome\.contaId\)/,
    "a conta conectada deve entrar em validacao de faixa sem depender da ativacao do trial");
});

test("a newly connected ML account always awaits a proposal instead of inheriting legacy unlimited access", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/meliOAuthRoutes.js"), "utf8");
  assert.doesNotMatch(source, /isFirstAccount/);
  assert.match(source, /const billingStatus = "awaiting_subscription"/);
  assert.match(source, /const billingMode = "paid"/);
  assert.match(source, /const usagePolicy = "metered"/);
});

test("ML uses the marketplace nickname as the initial Hub label after OAuth", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/meliOAuthRoutes.js"), "utf8");
  assert.match(source, /label:\s*apelido,/);
  assert.match(source, /label:\s*outcome\.label/);
});
