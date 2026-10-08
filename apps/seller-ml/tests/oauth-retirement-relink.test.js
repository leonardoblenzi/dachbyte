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
      return new Response(JSON.stringify({ ok: true, access: { allow: true } }), { status: 200 });
    }
  });
  await confirm({ tenantId: "tenant-a", accountId: "123", label: "Loja" });
  assert.equal(request.url, "https://hub.example/v1/internal/resources/sync");
  assert.deepEqual(JSON.parse(request.options.body), {
    tenant_id: "tenant-a", module_slug: "ml", account_id: "123", label: "Loja", oauth_confirmed: true
  });
});
