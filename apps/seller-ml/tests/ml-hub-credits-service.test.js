"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  hasUnlimitedAccess,
  reserveCredits,
} = require("../services/hubCreditsService");

test("identifica contas ilimitadas migradas ou de cortesia", () => {
  assert.equal(
    hasUnlimitedAccess({
      status: "internal_unlimited",
      billingMode: "internal",
      usagePolicy: "unlimited",
    }),
    true,
  );
  assert.equal(
    hasUnlimitedAccess({
      status: "courtesy_unlimited",
      billingMode: "courtesy",
      usagePolicy: "metered",
    }),
    true,
  );
  assert.equal(
    hasUnlimitedAccess({
      status: "legacy_active",
      billingMode: "legacy",
      usagePolicy: "metered",
    }),
    true,
  );
  assert.equal(
    hasUnlimitedAccess({
      status: "active",
      billingMode: "paid",
      usagePolicy: "metered",
    }),
    false,
  );
});

test("conta ilimitada nao chama Hub nem consome creditos no modo enforce", async () => {
  const previousMode = process.env.HUB_CREDITS_MODE;
  process.env.HUB_CREDITS_MODE = "enforce";

  try {
    const reservation = await reserveCredits({
      mlCreds: {
        meli_user_id: "123",
        tenant_id: "tenant_123",
        billing_status: "internal_unlimited",
        billing_mode: "internal",
        usage_policy: "unlimited",
      },
      operationKey: "promotions.apply",
      units: 10,
      idempotencyKey: "test:unlimited",
    });

    assert.equal(reservation.bypass, true);
    assert.equal(reservation.reason, "unlimited_account");
    assert.equal(reservation.reserved_credits, 0);
  } finally {
    if (previousMode === undefined) {
      delete process.env.HUB_CREDITS_MODE;
    } else {
      process.env.HUB_CREDITS_MODE = previousMode;
    }
  }
});


test("modo shadow consulta quote generico sem reservar saldo", async () => {
  const previous = {
    mode: process.env.HUB_RESOURCE_CREDITS_MODE,
    legacyMode: process.env.HUB_CREDITS_MODE,
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_RESOURCE_CREDITS_MODE = "shadow";
  delete process.env.HUB_CREDITS_MODE;
  process.env.HUB_BASE_URL = "https://hub.example.test";
  process.env.HUB_INTERNAL_TOKEN = "internal-test-token";

  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method || "GET",
      body: options.body ? JSON.parse(String(options.body)) : null,
    });
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/v1/internal/resources/sync") {
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ ok: true, resource: { resource_key: "ml:shadow_123" } }); },
      };
    }
    if (pathname === "/v1/internal/resources/credits/quote") {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            quote: {
              operation_key: "promotions.apply",
              quantity: 30000,
              estimated_credits: 10,
              available_credits: 1000,
              sufficient: true,
            },
          });
        },
      };
    }
    throw new Error(`unexpected_hub_call:${pathname}`);
  };

  try {
    const reservation = await reserveCredits({
      mlCreds: {
        meli_user_id: "shadow_123",
        tenant_id: "tenant_shadow_123",
        billing_status: "active",
        billing_mode: "paid",
        usage_policy: "metered",
      },
      operationKey: "promotions.apply",
      units: 30000,
      idempotencyKey: "promotion-operation:shadow-test",
    });

    assert.equal(reservation.bypass, true);
    assert.equal(reservation.shadow, true);
    assert.equal(reservation.reason, "shadow_mode");
    assert.equal(reservation.reserved_credits, 10);
    assert.equal(reservation.operation_quantity, 30000);
    assert.deepEqual(
      calls.map((call) => new URL(call.url).pathname),
      ["/v1/internal/resources/sync", "/v1/internal/resources/credits/quote"],
    );
    assert.equal(calls.some((call) => call.url.includes("/credits/reserve")), false);
    assert.equal(calls[1].body.quantity, 30000);
    assert.equal(calls[1].body.module_slug, "ml");
  } finally {
    if (previous.mode === undefined) delete process.env.HUB_RESOURCE_CREDITS_MODE;
    else process.env.HUB_RESOURCE_CREDITS_MODE = previous.mode;
    if (previous.legacyMode === undefined) delete process.env.HUB_CREDITS_MODE;
    else process.env.HUB_CREDITS_MODE = previous.legacyMode;
    if (previous.baseUrl === undefined) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.HUB_INTERNAL_TOKEN;
    else process.env.HUB_INTERNAL_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});
