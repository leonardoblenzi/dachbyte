"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ML_DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.REDIS_URL ||= "redis://127.0.0.1:6379";

const ModeloMassaJobsService = require("../services/modeloMassaJobsService");

test("modelo em massa separa validacao barata de aplicacao real", () => {
  assert.equal(
    ModeloMassaJobsService._test.massModelBillingOperationKey(true),
    "mass-model.validate",
  );
  assert.equal(
    ModeloMassaJobsService._test.massModelBillingOperationKey(false),
    "mass-model.apply",
  );
});

test("aplicacao de modelo cobra somente itens aplicados", () => {
  assert.equal(
    ModeloMassaJobsService._test.massModelBillableUnits(
      { dryRun: false },
      { processed: 100, applied: 64, validated: 0, manual: 20, skipped: 10, errors: 6 },
    ),
    64,
  );
  assert.equal(
    ModeloMassaJobsService._test.massModelBillableUnits(
      { dryRun: false },
      { processed: 100, applied: 0, validated: 0, manual: 80, skipped: 15, errors: 5 },
    ),
    0,
  );
});

test("dryRun cobra somente itens validados com sucesso", () => {
  assert.equal(
    ModeloMassaJobsService._test.massModelBillableUnits(
      { dryRun: true },
      { processed: 100, applied: 0, validated: 72, manual: 10, skipped: 12, errors: 6 },
    ),
    72,
  );
});

test("idempotencia de modelo em massa usa operationId unico", () => {
  const first = ModeloMassaJobsService._test.massModelBillingIdempotencyKey("MODEL-1");
  const second = ModeloMassaJobsService._test.massModelBillingIdempotencyKey("MODEL-2");

  assert.equal(first, "mass-model:MODEL-1");
  assert.equal(second, "mass-model:MODEL-2");
  assert.notEqual(first, second);
});

test("telemetria shadow de modelo inclui validados e unidades faturaveis", () => {
  const job = {
    data: {
      dryRun: true,
      operationId: "MODEL-TEST",
      billingOperationKey: "mass-model.validate",
      itemIds: Array.from({ length: 100 }, (_, index) => `MLB${index + 1}`),
      creditReservation: {
        bypass: true,
        shadow: true,
        quote: {
          operation_key: "mass-model.validate",
          estimated_credits: 1,
        },
      },
    },
  };

  const telemetry = ModeloMassaJobsService._test.telemetryFrom(job, {
    total: 100,
    processed: 90,
    applied: 0,
    validated: 70,
    manual: 10,
    skipped: 5,
    errors: 5,
    started_at: "2026-10-02T20:00:00.000Z",
    finished_at: "2026-10-02T20:01:30.000Z",
  });

  assert.equal(telemetry.billing_mode, "shadow");
  assert.equal(telemetry.operation_key, "mass-model.validate");
  assert.equal(telemetry.operation_id, "MODEL-TEST");
  assert.equal(telemetry.selected, 100);
  assert.equal(telemetry.processed, 90);
  assert.equal(telemetry.validated, 70);
  assert.equal(telemetry.manual, 10);
  assert.equal(telemetry.skipped, 5);
  assert.equal(telemetry.errors, 5);
  assert.equal(telemetry.billable_units, 70);
  assert.equal(telemetry.estimated_credits, 1);
  assert.equal(telemetry.duration_ms, 90000);
});

test("preview de modelo deduplica MLBs e envia operacao correta ao Hub", async () => {
  const previous = {
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_BASE_URL = "https://hub-mass-model.example.test";
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
          return JSON.stringify({ ok: true, resource: { resource_key: "ml:mass_model_test" } });
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
              estimated_credits: body.operation_key === "mass-model.validate" ? 1 : 2,
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
    const applyQuote = await ModeloMassaJobsService.previewCredits({
      itemIds: ["MLB1", "mlb1", "MLB2"],
      dryRun: false,
      mlCreds: {
        meli_user_id: "mass_model_test",
        tenant_id: "tenant_mass_model_test",
      },
    });
    const validationQuote = await ModeloMassaJobsService.previewCredits({
      itemIds: ["MLB1", "MLB2"],
      dryRun: true,
      mlCreds: {
        meli_user_id: "mass_model_test",
        tenant_id: "tenant_mass_model_test",
      },
    });

    assert.equal(applyQuote.operation_key, "mass-model.apply");
    assert.equal(applyQuote.quantity, 2);
    assert.equal(validationQuote.operation_key, "mass-model.validate");
    assert.equal(validationQuote.quantity, 2);

    const quoteCalls = calls.filter(
      (call) => call.pathname === "/v1/internal/resources/credits/quote",
    );
    assert.equal(quoteCalls.length, 2);
    assert.equal(quoteCalls[0].body.operation_key, "mass-model.apply");
    assert.equal(quoteCalls[0].body.quantity, 2);
    assert.equal(quoteCalls[1].body.operation_key, "mass-model.validate");
    assert.equal(quoteCalls[1].body.quantity, 2);
  } finally {
    if (previous.baseUrl === undefined) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.HUB_INTERNAL_TOKEN;
    else process.env.HUB_INTERNAL_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});
