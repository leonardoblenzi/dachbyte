"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ML_DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.REDIS_URL ||= "redis://127.0.0.1:6379";

const PrazoQueue = require("../services/prazoProducaoQueueService");

test("prazo separa consulta barata de aplicacao real", () => {
  assert.equal(
    PrazoQueue._test.productionTimeBillingOperationKey("lookup_active"),
    "production-time.lookup",
  );
  assert.equal(
    PrazoQueue._test.productionTimeBillingOperationKey("apply"),
    "production-time.apply",
  );
});

test("prazo cobra somente unidades bem-sucedidas", () => {
  assert.equal(
    PrazoQueue._test.productionTimeBillableUnits({
      processed: 100,
      ok: 73,
      err: 27,
    }),
    73,
  );
  assert.equal(
    PrazoQueue._test.productionTimeBillableUnits({
      processed: 100,
      ok: 0,
      err: 100,
    }),
    0,
  );
});

test("idempotencia do prazo usa operationId unico", () => {
  const first = PrazoQueue._test.productionTimeBillingIdempotencyKey("PRAZO-1");
  const second = PrazoQueue._test.productionTimeBillingIdempotencyKey("PRAZO-2");

  assert.equal(first, "production-time:PRAZO-1");
  assert.equal(second, "production-time:PRAZO-2");
  assert.notEqual(first, second);
});

test("telemetria shadow do prazo usa sucessos como unidades faturaveis", () => {
  const job = {
    id: "job-prazo-1",
    data: {
      type: "lookup_active",
      operationId: "PRAZO-LOOKUP-1",
      billingOperationKey: "production-time.lookup",
      creditReservation: {
        bypass: true,
        shadow: true,
        quote: {
          operation_key: "production-time.lookup",
          estimated_credits: 1,
        },
      },
    },
  };

  const telemetry = PrazoQueue._test.productionTimeBillingTelemetry(job, {
    total: 100,
    processed: 90,
    ok: 75,
    err: 15,
    startedAt: 1000,
    finishedAt: 61000,
  });

  assert.equal(telemetry.billing_mode, "shadow");
  assert.equal(telemetry.operation_key, "production-time.lookup");
  assert.equal(telemetry.operation_id, "PRAZO-LOOKUP-1");
  assert.equal(telemetry.selected, 100);
  assert.equal(telemetry.processed, 90);
  assert.equal(telemetry.success, 75);
  assert.equal(telemetry.failed, 15);
  assert.equal(telemetry.billable_units, 75);
  assert.equal(telemetry.estimated_credits, 1);
  assert.equal(telemetry.duration_ms, 60000);
});

test("lookup sem reserva ainda aparece como billing pending", () => {
  const telemetry = PrazoQueue._test.productionTimeBillingTelemetry({
    id: "job-prazo-pending",
    data: {
      type: "lookup_active",
      operationId: "PRAZO-LOOKUP-PENDING",
      billingOperationKey: "production-time.lookup",
      creditReservation: null,
    },
  }, {
    total: 0,
    processed: 0,
    ok: 0,
    err: 0,
  });

  assert.equal(telemetry.billing_mode, "pending");
  assert.equal(telemetry.estimated_credits, null);
});

test("preview de aplicacao deduplica MLBs e envia quantidade correta ao Hub", async () => {
  const previous = {
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_BASE_URL = "https://hub-prazo.example.test";
  process.env.HUB_INTERNAL_TOKEN = "internal-test-token";

  const calls = [];
  global.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = options.body ? JSON.parse(String(options.body)) : null;
    calls.push({ pathname, body });

    if (pathname === "/v1/internal/resources/sync") {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, resource: { resource_key: "ml:prazo_test" } });
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
              operation_key: body.operation_key,
              quantity: body.quantity,
              estimated_credits: 2,
              available_credits: 100,
              sufficient: true,
              unlimited: false,
            },
          });
        },
      };
    }
    throw new Error(`unexpected_hub_call:${pathname}`);
  };

  try {
    const quote = await PrazoQueue.previewPrazoCredits({
      type: "apply",
      mlbIds: ["MLB1", "mlb1", "MLB2"],
      mlCreds: {
        meli_user_id: "prazo_test",
        tenant_id: "tenant_prazo_test",
      },
    });

    assert.equal(quote.operation_key, "production-time.apply");
    assert.equal(quote.quantity, 2);
    const quoteCalls = calls.filter(
      (call) => call.pathname === "/v1/internal/resources/credits/quote",
    );
    assert.equal(quoteCalls.length, 1);
    assert.equal(quoteCalls[0].body.operation_key, "production-time.apply");
    assert.equal(quoteCalls[0].body.quantity, 2);
  } finally {
    if (previous.baseUrl === undefined) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.HUB_INTERNAL_TOKEN;
    else process.env.HUB_INTERNAL_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});

test("preview de lookup com limite usa o teto e sem limite fica deferred", async () => {
  const previous = {
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_BASE_URL = "https://hub-prazo-lookup.example.test";
  process.env.HUB_INTERNAL_TOKEN = "internal-test-token";

  let quoteCalls = 0;
  global.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/v1/internal/resources/sync") {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, resource: { resource_key: "ml:prazo_lookup" } });
        },
      };
    }
    if (pathname === "/v1/internal/resources/credits/quote") {
      quoteCalls += 1;
      const body = JSON.parse(String(options.body || "{}"));
      assert.equal(body.operation_key, "production-time.lookup");
      assert.equal(body.quantity, 30000);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            quote: {
              operation_key: body.operation_key,
              quantity: body.quantity,
              estimated_credits: 2,
              available_credits: 100,
              sufficient: true,
              unlimited: false,
            },
          });
        },
      };
    }
    throw new Error(`unexpected_hub_call:${pathname}`);
  };

  try {
    const limited = await PrazoQueue.previewPrazoCredits({
      type: "lookup_active",
      maxItems: 30000,
      mlCreds: {
        meli_user_id: "prazo_lookup",
        tenant_id: "tenant_prazo_lookup",
      },
    });
    assert.equal(limited.deferred, false);
    assert.equal(limited.quantity, 30000);
    assert.equal(limited.estimated_credits, 2);

    const all = await PrazoQueue.previewPrazoCredits({
      type: "lookup_active",
      maxItems: null,
      mlCreds: {
        meli_user_id: "prazo_lookup",
        tenant_id: "tenant_prazo_lookup",
      },
    });
    assert.equal(all.deferred, true);
    assert.equal(all.quantity, null);
    assert.equal(all.estimated_credits, null);
    assert.equal(quoteCalls, 1);
  } finally {
    if (previous.baseUrl === undefined) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.HUB_INTERNAL_TOKEN;
    else process.env.HUB_INTERNAL_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});
