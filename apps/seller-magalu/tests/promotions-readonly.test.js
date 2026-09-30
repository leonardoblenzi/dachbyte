"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function clearModule(request) {
  try { delete require.cache[require.resolve(request)]; } catch (_error) {}
}

function response() {
  const result = {};
  return {
    result,
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return body; },
  };
}

async function withLoadStubs(stubs, load, run) {
  const original = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return original.call(this, request, parent, isMain);
  };
  try {
    return await run(load());
  } finally {
    Module._load = original;
  }
}

test("promotion capabilities require read scope and never enable unpublished writes", () => {
  const capability = require("../src/services/promotionCapabilityService");
  assert.deepEqual(capability.forAccount({
    id: 42,
    status: "active",
    scopes: ["open:promotion-promotions-seller:read"],
  }), {
    list: true,
    detail: true,
    promotionSkuRead: false,
    promotionSkuWrite: false,
    subscriptionWrite: false,
    apply: false,
  });
  assert.equal(capability.forAccount({ status: "active", scopes: [] }).list, false);
  assert.equal(capability.forAccount({
    status: "revoked",
    scopes: [capability.READ_SCOPE],
  }).detail, false);
});

test("OAuth defaults request promotional read and no promotional write", () => {
  const source = read("src/config/env.js");
  assert.match(source, /open:promotion-promotions-seller:read/);
  assert.doesNotMatch(source, /open:promotion-skus-seller:write/);
  assert.doesNotMatch(source, /open:promotion-subscriptions-seller:write/);
});

test("promotion reader sends only GET and normalizes campaign fields", async () => {
  const calls = [];
  clearModule("../src/services/promotionReadService");
  await withLoadStubs({
    "./magaluApiClient": {
      request: async (pathname, options) => {
        calls.push({ path: pathname, method: options.method, accountId: options.accountId });
        if (pathname.endsWith("/promo-1")) {
          return {
            status: 200,
            requestId: "req-promo-detail-1",
            data: { id: "promo-1", title: "Cliente Ouro", status: "scheduled" },
          };
        }
        return {
          status: 200,
          requestId: "req-promo-1",
          data: {
            promos: [{
              id: "promo-1",
              name: "Cliente Ouro",
              type: "fidelity_discount",
              origin: "channel",
              status: "scheduled",
            }],
          },
        };
      },
    },
  }, () => require("../src/services/promotionReadService"), async (service) => {
    const account = { id: 7, dach_tenant_id: "tenant-a" };
    const result = await service.list(account, { force: true });
    assert.equal(result.request_id, "req-promo-1");
    assert.deepEqual(result.promotions, [{
      id: "promo-1",
      name: "Cliente Ouro",
      type: "fidelity_discount",
      origin: "channel",
      status: "scheduled",
      benefits: [],
      seller_contribution: null,
      adhesion_deadline_at: null,
      starts_at: null,
      ends_at: null,
      participation_status: null,
    }]);
    await service.list(account);
    const detail = await service.detail(account, "promo-1", { force: true });
    assert.equal(detail.request_id, "req-promo-detail-1");
    assert.equal(detail.promotion.id, "promo-1");
  });
  assert.deepEqual(calls, [
    { path: "/seller/v1/promotions", method: "GET", accountId: 7 },
    { path: "/seller/v1/promotions/promo-1", method: "GET", accountId: 7 },
  ]);
});

test("promotion controller resolves the tenant account and requires Hub READ before list", async () => {
  const account = { id: 7, dach_tenant_id: "tenant-a", status: "active", scopes: ["open:promotion-promotions-seller:read"] };
  const accesses = [];
  clearModule("../src/controllers/promotionController");
  await withLoadStubs({
    "../repositories/accountRepository": { findAccountByIdForTenant: async () => account },
    "../services/hubResourceAccessService": { checkAccountAccess: async (...args) => { accesses.push(args); return { allow: true }; } },
    "../services/promotionCapabilityService": { forAccount: () => ({ list: true, detail: true }) },
    "../services/promotionReadService": { list: async () => ({ promotions: [{ id: "promo-1" }], request_id: "req-1" }) },
  }, () => require("../src/controllers/promotionController"), async (controller) => {
    const res = response();
    const identity = { dachTenantId: "tenant-a", dachUserId: "user-a" };
    await controller.list({ query: { account_id: "7" }, params: {}, magaluIdentity: identity }, res, (error) => { if (error) throw error; });
    assert.deepEqual(accesses, [[identity, account, { action: "READ magalu" }]]);
    assert.deepEqual(res.result.body, { ok: true, promotions: [{ id: "promo-1" }], request_id: "req-1" });
  });
});

test("promotion detail is read-only, account-scoped, and rejects an empty promotion id", async () => {
  const account = { id: 7, dach_tenant_id: "tenant-a", status: "active", scopes: ["open:promotion-promotions-seller:read"] };
  clearModule("../src/controllers/promotionController");
  await withLoadStubs({
    "../repositories/accountRepository": { findAccountByIdForTenant: async () => account },
    "../services/hubResourceAccessService": { checkAccountAccess: async () => ({ allow: true }) },
    "../services/promotionCapabilityService": { forAccount: () => ({ list: true, detail: true }) },
    "../services/promotionReadService": { detail: async () => ({ promotion: { id: "promo-1" }, request_id: "req-detail" }) },
  }, () => require("../src/controllers/promotionController"), async (controller) => {
    const res = response();
    await controller.detail({ query: { account_id: "7" }, params: { promotionId: "promo-1" }, magaluIdentity: { dachTenantId: "tenant-a" } }, res, (error) => { if (error) throw error; });
    assert.deepEqual(res.result.body, { ok: true, promotion: { id: "promo-1" }, request_id: "req-detail" });

    let received = null;
    await controller.detail({ query: { account_id: "7" }, params: {}, magaluIdentity: { dachTenantId: "tenant-a" } }, response(), (error) => { received = error; });
    assert.equal(received.code, "MAGALU_PROMOTION_ID_REQUIRED");
  });
});

test("promotion API exposes only account-scoped GET routes and the app page", () => {
  const apiRoutes = read("src/routes/api.routes.js");
  const appRoutes = read("src/routes/index.js");
  assert.match(apiRoutes, /router\.use\("\/promotions",\s*promotionRoutes\)/);
  assert.match(appRoutes, /"\/promocoes"/);
  const promotionRoutes = read("src/routes/promotion.routes.js");
  assert.match(promotionRoutes, /router\.get\("\/",\s*promotionController\.list\)/);
  assert.match(promotionRoutes, /router\.get\("\/:promotionId",\s*promotionController\.detail\)/);
  assert.doesNotMatch(promotionRoutes, /router\.(post|put|patch|delete)\(/i);
});

test("promotion workspace is part of the canonical Magalu shell and contains no write action", () => {
  const app = read("views/app.html");
  const shell = read("public/js/magalu-app.js");
  const script = read("public/js/magalu-promotions.js");
  assert.match(app, /data-group="promotions"/);
  assert.match(app, /href="\/magalu\/promocoes"/);
  assert.match(app, /data-page="\/promocoes"/);
  assert.match(app, /mg-promotions-available/);
  assert.match(app, /mg-promotions-participating/);
  assert.match(shell, /"\/promocoes":\s*\{ title: "Promoções"/);
  assert.match(app, /magalu-promotions\.js/);
  assert.match(script, /MagaluSellerShell\?\.getSelectedAccountId/);
  assert.match(script, /\/magalu\/api\/promotions/);
  assert.doesNotMatch(app, /Criar promoção|Adicionar todo catálogo|Remover SKU da promoção/);
  assert.doesNotMatch(script, /fetch\([^)]*\{\s*method:\s*["'](?:POST|PUT|PATCH|DELETE)/i);
});
