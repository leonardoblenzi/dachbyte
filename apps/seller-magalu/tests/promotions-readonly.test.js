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
