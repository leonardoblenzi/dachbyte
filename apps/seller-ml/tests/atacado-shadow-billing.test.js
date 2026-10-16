"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.ML_DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.REDIS_URL ||= "redis://127.0.0.1:6379";

const AtacadoJobsService = require("../services/atacadoJobsService");

test("atacado usa modal compartilhado de créditos em vez de confirmação nativa", () => {
  const clientSource = fs.readFileSync(path.join(__dirname, "../public/js/atacado.js"), "utf8");
  const viewSource = fs.readFileSync(path.join(__dirname, "../views/atacado.html"), "utf8");

  assert.match(clientSource, /CreditOperationModal\.confirm/);
  assert.doesNotMatch(clientSource, /window\.confirm\(/);
  assert.match(viewSource, /credit-operation-modal\.js/);
  assert.match(viewSource, /credit-operation-modal\.css/);
});

test("atacado não inicia aplicação quando a cotação de créditos falha", () => {
  const clientSource = fs.readFileSync(path.join(__dirname, "../public/js/atacado.js"), "utf8");

  assert.doesNotMatch(clientSource, /seguindo em shadow/);
  assert.match(clientSource, /Falha ao consultar o custo.*tente novamente/i);
});

test("atacado usa apenas a operacao de aplicacao real", () => {
  assert.equal(AtacadoJobsService._test.wholesaleBillingOperationKey(), "wholesale.apply");
});

test("aplicacao cobra somente itens realmente aplicados", () => {
  assert.equal(
    AtacadoJobsService._test.wholesaleBillableUnits(
      { dryRun: false },
      { processed: 100, applied: 65, skipped: 30, errors: 5 },
    ),
    65,
  );

  assert.equal(
    AtacadoJobsService._test.wholesaleBillableUnits(
      { dryRun: false },
      { processed: 100, applied: 0, skipped: 95, errors: 5 },
    ),
    0,
  );
});

test("pedido legado de simulacao nao pode iniciar job de atacado", () => {
  assert.throws(
    () => AtacadoJobsService._test.rejectWholesaleSimulation(true),
    /simulação.*não.*disponível/i,
  );
});

test("idempotencia do atacado usa operationId unico", () => {
  const first = AtacadoJobsService._test.wholesaleBillingIdempotencyKey("WHOLESALE-1");
  const second = AtacadoJobsService._test.wholesaleBillingIdempotencyKey("WHOLESALE-2");

  assert.equal(first, "wholesale:WHOLESALE-1");
  assert.equal(second, "wholesale:WHOLESALE-2");
  assert.notEqual(first, second);
});

test("telemetria shadow do atacado inclui unidades faturaveis e custo estimado", () => {
  const job = {
    data: {
      dryRun: false,
      operationId: "WHOLESALE-TEST",
      billingOperationKey: "wholesale.apply",
      itemIds: Array.from({ length: 100 }, (_, index) => `MLB${index + 1}`),
      creditReservation: {
        bypass: true,
        shadow: true,
        quote: {
          operation_key: "wholesale.apply",
          estimated_credits: 1,
        },
      },
    },
  };

  const telemetry = AtacadoJobsService._test.telemetryFrom(job, {
    total: 100,
    processed: 90,
    applied: 60,
    skipped: 25,
    errors: 5,
    started_at: "2026-10-02T20:00:00.000Z",
    finished_at: "2026-10-02T20:01:30.000Z",
  });

  assert.equal(telemetry.billing_mode, "shadow");
  assert.equal(telemetry.operation_key, "wholesale.apply");
  assert.equal(telemetry.operation_id, "WHOLESALE-TEST");
  assert.equal(telemetry.selected, 100);
  assert.equal(telemetry.processed, 90);
  assert.equal(telemetry.applied, 60);
  assert.equal(telemetry.billable_units, 60);
  assert.equal(telemetry.skipped, 25);
  assert.equal(telemetry.errors, 5);
  assert.equal(telemetry.estimated_credits, 1);
  assert.equal(telemetry.duration_ms, 90000);
});

test("preview do atacado deduplica MLBs e envia a operacao correta ao Hub", async () => {
  const previous = {
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_BASE_URL = "https://hub-wholesale.example.test";
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
          return JSON.stringify({ ok: true, resource: { resource_key: "ml:wholesale_test" } });
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
    const applyQuote = await AtacadoJobsService.previewCredits({
      itemIds: ["MLB1", "mlb1", "MLB2"],
      mlCreds: {
        meli_user_id: "wholesale_test",
        tenant_id: "tenant_wholesale_test",
      },
    });
    assert.equal(applyQuote.operation_key, "wholesale.apply");
    assert.equal(applyQuote.quantity, 2);

    const quoteCalls = calls.filter(
      (call) => call.pathname === "/v1/internal/resources/credits/quote",
    );
    assert.equal(quoteCalls.length, 1);
    assert.equal(quoteCalls[0].body.operation_key, "wholesale.apply");
    assert.equal(quoteCalls[0].body.quantity, 2);
  } finally {
    if (previous.baseUrl === undefined) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.HUB_INTERNAL_TOKEN;
    else process.env.HUB_INTERNAL_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});
