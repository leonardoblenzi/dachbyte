"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createCreditTopupCheckout,
  getCreditAccountAccess,
  getCreditActivity,
  hasUnlimitedAccess,
  hasUnlimitedCredits,
  reserveCredits,
  settleCredits,
} = require("../services/hubCreditsService");

const creditsUiSource = fs.readFileSync(
  path.join(__dirname, "../public/js/conta-creditos.js"),
  "utf8",
);

test("metadado legado ilimitado nao bloqueia recarga quando o Hub usa prepaid_credits", async () => {
  const previous = {
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_BASE_URL = "https://hub-topup-prepaid.example.test";
  process.env.HUB_INTERNAL_TOKEN = "internal-test-token";

  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/v1/internal/resources/sync") {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            resource: {
              resource_key: "ml:legacy_prepaid_topup",
              access_policy: "unlimited",
              consumption_model: "prepaid_credits",
            },
          });
        },
      };
    }
    if (pathname === "/v1/internal/resources/credits/topup/checkout") {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            checkout_url: "https://checkout.example.test/prepaid",
          });
        },
      };
    }
    throw new Error(`unexpected_hub_call:${pathname}`);
  };

  try {
    const checkout = await createCreditTopupCheckout({
      mlCreds: {
        meli_user_id: "legacy_prepaid_topup",
        tenant_id: "tenant_legacy_prepaid_topup",
        billing_status: "courtesy_unlimited",
        billing_mode: "courtesy",
        usage_policy: "unlimited",
      },
      packageCode: "ml_1000",
    });

    assert.equal(checkout.checkout_url, "https://checkout.example.test/prepaid");
    assert.deepEqual(
      calls.map((url) => new URL(url).pathname),
      ["/v1/internal/resources/sync", "/v1/internal/resources/credits/topup/checkout"],
    );
  } finally {
    if (previous.baseUrl === undefined) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.HUB_INTERNAL_TOKEN;
    else process.env.HUB_INTERNAL_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});

test("Hub continua bloqueando recarga quando consumption_model e unlimited", async () => {
  const previous = {
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_BASE_URL = "https://hub-topup-unlimited.example.test";
  process.env.HUB_INTERNAL_TOKEN = "internal-test-token";

  global.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/v1/internal/resources/sync") {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, resource: { resource_key: "ml:hub_unlimited_topup" } });
        },
      };
    }
    if (pathname === "/v1/internal/resources/credits/topup/checkout") {
      return {
        ok: false,
        status: 409,
        async text() {
          return JSON.stringify({
            ok: false,
            error: "credit_topup_unavailable_for_unlimited",
          });
        },
      };
    }
    throw new Error(`unexpected_hub_call:${pathname}`);
  };

  try {
    await assert.rejects(
      () => createCreditTopupCheckout({
        mlCreds: {
          meli_user_id: "hub_unlimited_topup",
          tenant_id: "tenant_hub_unlimited_topup",
          billing_status: "active",
          billing_mode: "paid",
          usage_policy: "metered",
        },
        packageCode: "ml_1000",
      }),
      (error) => error.code === "credit_topup_unavailable_for_unlimited" && error.statusCode === 409,
    );
  } finally {
    if (previous.baseUrl === undefined) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.HUB_INTERNAL_TOKEN;
    else process.env.HUB_INTERNAL_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});

test("metadados legados continuam apenas como hint de compatibilidade, nao como autoridade de creditos", () => {
  assert.equal(
    hasUnlimitedAccess({
      status: "legacy_active",
      billingMode: "legacy",
      usagePolicy: "metered",
    }),
    true,
  );
  assert.equal(
    hasUnlimitedCredits({
      resource: {
        access_policy: "unlimited",
        consumption_model: "prepaid_credits",
      },
    }),
    false,
  );
  assert.equal(
    hasUnlimitedCredits({
      resource: {
        access_policy: "paid",
        consumption_model: "unlimited",
      },
    }),
    true,
  );
});

test("modo enforce nao permite que metadado legado ilimitado faca bypass de prepaid_credits", async () => {
  const previous = {
    mode: process.env.HUB_RESOURCE_CREDITS_MODE,
    legacyMode: process.env.HUB_CREDITS_MODE,
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_RESOURCE_CREDITS_MODE = "enforce";
  delete process.env.HUB_CREDITS_MODE;
  process.env.HUB_BASE_URL = "https://hub-legacy-prepaid-enforce.example.test";
  process.env.HUB_INTERNAL_TOKEN = "internal-test-token";

  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push(String(url));
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/v1/internal/resources/sync") {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, resource: { resource_key: "ml:legacy_prepaid_enforce" } });
        },
      };
    }
    if (pathname === "/v1/internal/resources/credits/reserve") {
      const body = JSON.parse(String(options.body || "{}"));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            reservation: {
              idempotency_key: body.idempotency_key,
              operation_key: body.operation_key,
              reserved_credits: 1000,
              credit_unit_scale: 100,
            },
            wallet: {
              model: "prepaid_credits",
              unlimited: false,
              purchased_balance: 99000,
              credit_unit_scale: 100,
            },
            access: {
              access_policy: "unlimited",
              consumption_model: "prepaid_credits",
              unlimited: true,
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
        meli_user_id: "legacy_prepaid_enforce",
        tenant_id: "tenant_legacy_prepaid_enforce",
        billing_status: "legacy_active",
        billing_mode: "legacy",
        usage_policy: "unlimited",
      },
      operationKey: "promotions.apply",
      units: 30000,
      idempotencyKey: "test:legacy-prepaid-enforce",
    });

    assert.equal(reservation.bypass, false);
    assert.equal(reservation.reserved_credits, 10);
    assert.equal(reservation.access_unlimited, true);
    assert.equal(reservation.credits_unlimited, false);
    assert.equal(
      calls.some((url) => new URL(url).pathname.endsWith("/credits/reserve")),
      true,
    );
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


test("acesso ilimitado e consumo prepaid sao expostos separadamente pelo Seller", async () => {
  const previous = {
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_BASE_URL = "https://hub-access-split.example.test";
  process.env.HUB_INTERNAL_TOKEN = "internal-test-token";

  global.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/v1/internal/resources/sync") {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, resource: { resource_key: "ml:split_access" } });
        },
      };
    }
    if (pathname === "/v1/internal/resources/access") {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            resource: {
              resource_key: "ml:split_access",
              access_policy: "unlimited",
              consumption_model: "prepaid_credits",
            },
            allow: true,
            access_policy: "unlimited",
            consumption_model: "prepaid_credits",
            unlimited: true,
          });
        },
      };
    }
    throw new Error(`unexpected_hub_call:${pathname}`);
  };

  try {
    const result = await getCreditAccountAccess({
      mlCreds: {
        meli_user_id: "split_access",
        tenant_id: "tenant_split_access",
        billing_status: "legacy_active",
        billing_mode: "legacy",
        usage_policy: "unlimited",
      },
    });

    assert.equal(result.access_unlimited, true);
    assert.equal(result.credits_unlimited, false);
    assert.equal(result.unlimited, false);
    assert.equal(result.resource.consumption_model, "prepaid_credits");
  } finally {
    if (previous.baseUrl === undefined) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.HUB_INTERNAL_TOKEN;
    else process.env.HUB_INTERNAL_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});

test("extrato usa wallet.model como autoridade de consumo ilimitado", async () => {
  const previous = {
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_BASE_URL = "https://hub-activity-split.example.test";
  process.env.HUB_INTERNAL_TOKEN = "internal-test-token";

  global.fetch = async (url) => {
    const parsed = new URL(String(url));
    const pathname = parsed.pathname;
    if (pathname === "/v1/internal/resources/sync") {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, resource: { resource_key: "ml:split_activity" } });
        },
      };
    }
    if (pathname === "/v1/internal/resources/credits/activity") {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            resource: {
              resource_key: "ml:split_activity",
              access_policy: "unlimited",
              consumption_model: "prepaid_credits",
            },
            access: {
              allow: true,
              access_policy: "unlimited",
              consumption_model: "prepaid_credits",
              unlimited: true,
            },
            wallet: {
              model: "prepaid_credits",
              unlimited: false,
              purchased_balance: 1000,
              available_balance: 1000,
            },
            ledger: [],
            reservations: [],
          });
        },
      };
    }
    throw new Error(`unexpected_hub_call:${pathname}`);
  };

  try {
    const result = await getCreditActivity({
      mlCreds: {
        meli_user_id: "split_activity",
        tenant_id: "tenant_split_activity",
        billing_status: "courtesy_unlimited",
        billing_mode: "courtesy",
        usage_policy: "unlimited",
      },
    });

    assert.equal(result.access_unlimited, true);
    assert.equal(result.credits_unlimited, false);
    assert.equal(result.unlimited, false);
    assert.equal(result.wallet.model, "prepaid_credits");
  } finally {
    if (previous.baseUrl === undefined) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.HUB_INTERNAL_TOKEN;
    else process.env.HUB_INTERNAL_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});

test("tela de creditos nao usa acesso ou metadados legados para decidir consumo ilimitado", () => {
  const match = creditsUiSource.match(/function isUnlimited\(payload\) \{([\s\S]*?)\n  \}/);
  assert.ok(match);
  assert.match(match[1], /credits_unlimited/);
  assert.match(match[1], /consumption_model/);
  assert.doesNotMatch(match[1], /access_policy|billingMode|usagePolicy|legacy_active|courtesy_unlimited|internal_unlimited/);
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
        billing_status: "legacy_active",
        billing_mode: "legacy",
        usage_policy: "unlimited",
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


test("modo enforce normaliza reserva em pontos para creditos visiveis", async () => {
  const previous = {
    mode: process.env.HUB_RESOURCE_CREDITS_MODE,
    legacyMode: process.env.HUB_CREDITS_MODE,
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_RESOURCE_CREDITS_MODE = "enforce";
  delete process.env.HUB_CREDITS_MODE;
  process.env.HUB_BASE_URL = "https://hub-enforce.example.test";
  process.env.HUB_INTERNAL_TOKEN = "internal-test-token";

  global.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/v1/internal/resources/sync") {
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ ok: true, resource: { resource_key: "ml:enforce_123" } }); },
      };
    }
    if (pathname === "/v1/internal/resources/credits/reserve") {
      const body = JSON.parse(String(options.body || "{}"));
      assert.equal(body.quantity, 30000);
      assert.equal(body.operation_key, "promotions.apply");
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            reservation: {
              idempotency_key: body.idempotency_key,
              operation_key: body.operation_key,
              reserved_credits: 1000,
              credit_unit_scale: 100,
            },
            wallet: { purchased_balance: 99000, credit_unit_scale: 100 },
          });
        },
      };
    }
    throw new Error(`unexpected_hub_call:${pathname}`);
  };

  try {
    const reservation = await reserveCredits({
      mlCreds: {
        meli_user_id: "enforce_123",
        tenant_id: "tenant_enforce_123",
        billing_status: "active",
        billing_mode: "paid",
        usage_policy: "metered",
      },
      operationKey: "promotions.apply",
      units: 30000,
      idempotencyKey: "promotion-operation:enforce-test",
    });

    assert.equal(reservation.bypass, false);
    assert.equal(reservation.credit_unit_scale, 100);
    assert.equal(reservation.reserved_credit_units, 1000);
    assert.equal(reservation.reserved_credits, 10);
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


test("conta ilimitada em shadow recebe estimativa sem reservar saldo", async () => {
  const previous = {
    mode: process.env.HUB_RESOURCE_CREDITS_MODE,
    legacyMode: process.env.HUB_CREDITS_MODE,
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_RESOURCE_CREDITS_MODE = "shadow";
  delete process.env.HUB_CREDITS_MODE;
  process.env.HUB_BASE_URL = "https://hub-unlimited-shadow.example.test";
  process.env.HUB_INTERNAL_TOKEN = "internal-test-token";

  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(String(options.body)) : null });
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/v1/internal/resources/sync") {
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ ok: true, resource: { resource_key: "ml:unlimited_shadow" } }); },
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
              unlimited: true,
              chargeable: false,
              operation_key: "promotions.apply",
              quantity: 30000,
              estimated_credits: 0,
              available_credits: 0,
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
        meli_user_id: "unlimited_shadow",
        tenant_id: "tenant_unlimited_shadow",
        billing_status: "courtesy_unlimited",
        billing_mode: "courtesy",
        usage_policy: "unlimited",
      },
      operationKey: "promotions.apply",
      units: 30000,
      idempotencyKey: "promotion-operation:unlimited-shadow",
    });

    assert.equal(reservation.bypass, true);
    assert.equal(reservation.shadow, true);
    assert.equal(reservation.reason, "unlimited_shadow");
    assert.equal(reservation.reserved_credits, 0);
    assert.equal(reservation.quote.estimated_credits, 0);
    assert.equal(reservation.quote.chargeable, false);
    assert.equal(calls.some((call) => call.url.includes("/credits/reserve")), false);
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


test("sem configuracao explicita o modo padrao e shadow e nunca liquida saldo", async () => {
  const previous = {
    mode: process.env.HUB_RESOURCE_CREDITS_MODE,
    legacyMode: process.env.HUB_CREDITS_MODE,
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  delete process.env.HUB_RESOURCE_CREDITS_MODE;
  delete process.env.HUB_CREDITS_MODE;
  process.env.HUB_BASE_URL = "https://hub-default-shadow.example.test";
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
        async text() {
          return JSON.stringify({ ok: true, resource: { resource_key: "ml:default_shadow" } });
        },
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
              unlimited: false,
              chargeable: true,
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
        meli_user_id: "default_shadow",
        tenant_id: "tenant_default_shadow",
        billing_status: "active",
        billing_mode: "paid",
        usage_policy: "metered",
      },
      operationKey: "promotions.apply",
      units: 30000,
      idempotencyKey: "promotion-operation:default-shadow",
    });

    const settled = await settleCredits(reservation, {
      release: false,
      consumedUnits: 30000,
    });

    assert.equal(reservation.shadow, true);
    assert.equal(reservation.bypass, true);
    assert.equal(reservation.reason, "shadow_mode");
    assert.equal(settled, reservation);

    const paths = calls.map((call) => new URL(call.url).pathname);
    assert.deepEqual(paths, [
      "/v1/internal/resources/sync",
      "/v1/internal/resources/credits/quote",
    ]);
    assert.equal(paths.some((pathname) => pathname.endsWith("/credits/reserve")), false);
    assert.equal(paths.some((pathname) => pathname.endsWith("/credits/settle")), false);
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

test("falha de quote em shadow usa estimativa local sem reservar ou liquidar saldo", async () => {
  const previous = {
    mode: process.env.HUB_RESOURCE_CREDITS_MODE,
    legacyMode: process.env.HUB_CREDITS_MODE,
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_RESOURCE_CREDITS_MODE = "shadow";
  delete process.env.HUB_CREDITS_MODE;
  process.env.HUB_BASE_URL = "https://hub-shadow-fallback.example.test";
  process.env.HUB_INTERNAL_TOKEN = "internal-test-token";

  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push(String(url));
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/v1/internal/resources/sync") {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, resource: { resource_key: "ml:shadow_fallback" } });
        },
      };
    }
    if (pathname === "/v1/internal/resources/credits/quote") {
      return {
        ok: false,
        status: 503,
        async text() {
          return JSON.stringify({ ok: false, error: "temporary_unavailable" });
        },
      };
    }
    throw new Error(`unexpected_hub_call:${pathname}`);
  };

  try {
    const reservation = await reserveCredits({
      mlCreds: {
        meli_user_id: "shadow_fallback",
        tenant_id: "tenant_shadow_fallback",
        billing_status: "active",
        billing_mode: "paid",
        usage_policy: "metered",
      },
      operationKey: "promotions.apply",
      units: 30000,
      idempotencyKey: "promotion-operation:shadow-fallback",
    });

    await settleCredits(reservation, { release: true });

    assert.equal(reservation.shadow, true);
    assert.equal(reservation.bypass, true);
    assert.equal(reservation.reserved_credits, 10);
    assert.equal(
      calls.some((url) => new URL(url).pathname.endsWith("/credits/reserve")),
      false,
    );
    assert.equal(
      calls.some((url) => new URL(url).pathname.endsWith("/credits/settle")),
      false,
    );
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
