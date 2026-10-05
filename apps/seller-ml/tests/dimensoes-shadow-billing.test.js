"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ML_DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.REDIS_URL ||= "redis://127.0.0.1:6379";

const DimensoesJobs = require("../services/validarDimensoesJobService");

test("dimensoes separa validacao de aplicacao real", () => {
  assert.equal(
    DimensoesJobs._test.dimensionsBillingOperationKey("analyze"),
    "dimensions.validate",
  );
  assert.equal(
    DimensoesJobs._test.dimensionsBillingOperationKey("auto"),
    "dimensions.apply",
  );
  assert.equal(
    DimensoesJobs._test.dimensionsBillingOperationKey("manual"),
    "dimensions.apply",
  );
});

test("dimensoes cobra somente unidades realmente faturaveis", () => {
  assert.equal(
    DimensoesJobs._test.dimensionsBillableUnits(
      { mode: "analyze" },
      { processed: 100, validated: 73, success: 73, failed: 27 },
    ),
    73,
  );
  assert.equal(
    DimensoesJobs._test.dimensionsBillableUnits(
      { mode: "auto" },
      { processed: 100, validated: 80, applied: 31, failed: 20 },
    ),
    31,
  );
  assert.equal(
    DimensoesJobs._test.dimensionsBillableUnits(
      { mode: "manual" },
      { processed: 50, applied: 0, failed: 7 },
    ),
    0,
  );
});

test("idempotencia de dimensoes usa operationId unico", () => {
  const first = DimensoesJobs._test.dimensionsBillingIdempotencyKey("DIMENSIONS-1");
  const second = DimensoesJobs._test.dimensionsBillingIdempotencyKey("DIMENSIONS-2");

  assert.equal(first, "dimensions:DIMENSIONS-1");
  assert.equal(second, "dimensions:DIMENSIONS-2");
  assert.notEqual(first, second);
});

test("telemetria shadow de dimensoes diferencia validated e applied", () => {
  const job = {
    id: "job-dim-1",
    data: {
      mode: "auto",
      operationId: "DIMENSIONS-AUTO-1",
      billingOperationKey: "dimensions.apply",
      mlbs: ["MLB100001", "MLB100002", "MLB100003"],
      creditReservation: {
        shadow: true,
        bypass: true,
        quote: {
          operation_key: "dimensions.apply",
          estimated_credits: 1,
        },
      },
    },
  };

  const telemetry = DimensoesJobs._test.dimensionsBillingTelemetry(job, {
    total: 3,
    processed: 3,
    validated: 2,
    applied: 1,
    failed: 1,
    startedAt: 1000,
    finishedAt: 61000,
  });

  assert.equal(telemetry.billing_mode, "shadow");
  assert.equal(telemetry.operation_key, "dimensions.apply");
  assert.equal(telemetry.operation_id, "DIMENSIONS-AUTO-1");
  assert.equal(telemetry.selected, 3);
  assert.equal(telemetry.processed, 3);
  assert.equal(telemetry.validated, 2);
  assert.equal(telemetry.applied, 1);
  assert.equal(telemetry.failed, 1);
  assert.equal(telemetry.billable_units, 1);
  assert.equal(telemetry.estimated_credits, 1);
  assert.equal(telemetry.duration_ms, 60000);
});

test("preview manual deduplica ids e envia quantidade correta ao Hub", async () => {
  const previous = {
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_BASE_URL = "https://hub-dimensoes.example.test";
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
          return JSON.stringify({ ok: true, resource: { resource_key: "ml:dim_test" } });
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
              estimated_credits: 20,
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
    const quote = await DimensoesJobs.previewCredits({
      mlbs: ["MLB100001", "mlb100001", "MLB100002"],
      mode: "manual",
      source: "manual_list",
      mlCreds: {
        meli_user_id: "dim_test",
        tenant_id: "tenant_dim_test",
      },
    });

    assert.equal(quote.operation_key, "dimensions.apply");
    assert.equal(quote.quantity, 2);
    const quoteCalls = calls.filter(
      (call) => call.pathname === "/v1/internal/resources/credits/quote",
    );
    assert.equal(quoteCalls.length, 1);
    assert.equal(quoteCalls[0].body.operation_key, "dimensions.apply");
    assert.equal(quoteCalls[0].body.quantity, 2);
  } finally {
    if (previous.baseUrl === undefined) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.HUB_INTERNAL_TOKEN;
    else process.env.HUB_INTERNAL_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});

test("preview de ativos fica deferred ate conhecer a quantidade real", async () => {
  const quote = await DimensoesJobs.previewCredits({
    mlbs: [],
    mode: "analyze",
    source: "active_items",
    mlCreds: {},
  });

  assert.equal(quote.operation_key, "dimensions.validate");
  assert.equal(quote.deferred, true);
  assert.equal(quote.quantity, null);
  assert.equal(quote.estimated_credits, null);
});

test("contexto de auditoria preserva operationId", () => {
  const base = DimensoesJobs._test.auditBase({
    id: "job-dim-audit",
    data: {
      operationId: "DIMENSIONS-AUDIT-1",
      accountKey: "conta_teste",
      auditContext: {
        userId: 42,
        route: "/api/validar-dimensoes/jobs",
        method: "POST",
      },
    },
  });

  assert.equal(base.userId, 42);
  assert.equal(base.accountKey, "conta_teste");
  assert.equal(base.operationId, "DIMENSIONS-AUDIT-1");
});
