"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ML_DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.REDIS_URL ||= "redis://127.0.0.1:6379";

const CaracteristicasJobsService = require("../services/caracteristicasJobsService");

test("caracteristicas separa validacao barata de aplicacao real", () => {
  assert.equal(
    CaracteristicasJobsService._test.characteristicsBillingOperationKey(true),
    "characteristics.validate",
  );
  assert.equal(
    CaracteristicasJobsService._test.characteristicsBillingOperationKey(false),
    "characteristics.apply",
  );
});

test("aplicacao de caracteristicas cobra somente itens aplicados", () => {
  assert.equal(
    CaracteristicasJobsService._test.characteristicsBillableUnits(
      { dryRun: false },
      { processed: 100, applied: 62, skipped: 28, errors: 10 },
    ),
    62,
  );
  assert.equal(
    CaracteristicasJobsService._test.characteristicsBillableUnits(
      { dryRun: false },
      { processed: 100, applied: 0, skipped: 90, errors: 10 },
    ),
    0,
  );
});

test("dryRun cobra apenas validacoes que chegaram ao resultado dry_run", () => {
  assert.equal(
    CaracteristicasJobsService._test.characteristicsBillableUnits(
      { dryRun: true },
      { processed: 100, applied: 0, skipped: 85, errors: 15 },
    ),
    85,
  );
});

test("idempotencia de caracteristicas usa o id unico do job", () => {
  assert.equal(
    CaracteristicasJobsService._test.characteristicsBillingIdempotencyKey("job_caracteristicas_1"),
    "characteristics:job_caracteristicas_1",
  );
  assert.notEqual(
    CaracteristicasJobsService._test.characteristicsBillingIdempotencyKey("job_caracteristicas_1"),
    CaracteristicasJobsService._test.characteristicsBillingIdempotencyKey("job_caracteristicas_2"),
  );
});

test("telemetria shadow de caracteristicas separa validados e unidades faturaveis", () => {
  const job = {
    id: "job_caracteristicas_test",
    data: {
      dryRun: true,
      operationId: "job_caracteristicas_test",
      billingOperationKey: "characteristics.validate",
      total: 100,
      creditReservation: {
        bypass: true,
        shadow: true,
        quote: {
          operation_key: "characteristics.validate",
          estimated_credits: 1,
        },
      },
    },
  };

  const telemetry = CaracteristicasJobsService._test.characteristicsBillingTelemetry(job, {
    total: 100,
    processed: 90,
    applied: 0,
    skipped: 80,
    errors: 10,
    started_at: "2026-10-02T20:00:00.000Z",
    finished_at: "2026-10-02T20:01:00.000Z",
  });

  assert.equal(telemetry.billing_mode, "shadow");
  assert.equal(telemetry.operation_key, "characteristics.validate");
  assert.equal(telemetry.selected, 100);
  assert.equal(telemetry.processed, 90);
  assert.equal(telemetry.validated, 80);
  assert.equal(telemetry.billable_units, 80);
  assert.equal(telemetry.errors, 10);
  assert.equal(telemetry.estimated_credits, 1);
  assert.equal(telemetry.duration_ms, 60000);
});

test("preview de caracteristicas envia quantidade e operacao correta ao Hub", async () => {
  const previous = {
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_BASE_URL = "https://hub-characteristics.example.test";
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
          return JSON.stringify({ ok: true, resource: { resource_key: "ml:characteristics_test" } });
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
              estimated_credits: body.operation_key === "characteristics.validate" ? 1 : 2,
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
    const rows = [{ id: "MLB1" }, { id: "MLB2" }, { id: "MLB3" }];
    const applyQuote = await CaracteristicasJobsService.previewCredits({
      rows,
      dryRun: false,
      mlCreds: {
        meli_user_id: "characteristics_test",
        tenant_id: "tenant_characteristics_test",
      },
    });
    const validateQuote = await CaracteristicasJobsService.previewCredits({
      rows,
      dryRun: true,
      mlCreds: {
        meli_user_id: "characteristics_test",
        tenant_id: "tenant_characteristics_test",
      },
    });

    assert.equal(applyQuote.operation_key, "characteristics.apply");
    assert.equal(applyQuote.quantity, 3);
    assert.equal(validateQuote.operation_key, "characteristics.validate");
    assert.equal(validateQuote.quantity, 3);

    const quoteCalls = calls.filter(
      (call) => call.pathname === "/v1/internal/resources/credits/quote",
    );
    assert.equal(quoteCalls.length, 2);
    assert.equal(quoteCalls[0].body.operation_key, "characteristics.apply");
    assert.equal(quoteCalls[0].body.quantity, 3);
    assert.equal(quoteCalls[1].body.operation_key, "characteristics.validate");
    assert.equal(quoteCalls[1].body.quantity, 3);
  } finally {
    if (previous.baseUrl === undefined) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.HUB_INTERNAL_TOKEN;
    else process.env.HUB_INTERNAL_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});
