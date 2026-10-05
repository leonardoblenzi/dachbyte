"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ML_DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.REDIS_URL ||= "redis://127.0.0.1:6379";

const ScanQueue = require("../services/estoqueAlertaQueueService");
const ApplyQueue = require("../services/EstoqueAtualizacaoQueueService");

test("stock scan usa quantidade deferred quando o total ainda e desconhecido", async () => {
  const quote = await ScanQueue.previewStockScanCredits({
    mlCreds: {},
    maxItems: null,
  });

  assert.equal(quote.operation_key, "stock.scan");
  assert.equal(quote.deferred, true);
  assert.equal(quote.quantity, null);
  assert.equal(quote.estimated_credits, null);
});

test("stock scan liquida somente leituras concluidas", () => {
  assert.equal(
    ScanQueue._test.stockScanBillableUnits(
      {},
      { total: 100, processed: 72, ok: 72, errors: 1 },
      null,
    ),
    72,
  );
  assert.equal(
    ScanQueue._test.stockScanBillableUnits(
      {},
      { total: 100, processed: 0, ok: 0, errors: 1 },
      null,
    ),
    0,
  );
  assert.equal(
    ScanQueue._test.stockScanIdempotencyKey("STOCK-SCAN-1"),
    "stock.scan:STOCK-SCAN-1",
  );
});

test("stock apply deduplica a mesma linha antes da reserva", () => {
  const rows = ApplyQueue._test.dedupeStockChanges([
    { mlb: "MLB123456789", new_stock: 1 },
    { mlb: "mlb123456789", new_stock: 2 },
    { mlb: "MLB987654321", variation_id: "10", new_stock: 3 },
    { mlb: "MLB987654321", variation_id: "10", new_stock: 4 },
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].new_stock, 2);
  assert.equal(rows[1].new_stock, 4);
});

test("stock apply cobra somente escritas aceitas pelo Mercado Livre", () => {
  assert.equal(
    ApplyQueue._test.stockApplyBillableUnits(
      { applied: 6, divergent: 2, blocked: 3, stale: 4, errors: 5 },
      null,
    ),
    8,
  );
  assert.equal(
    ApplyQueue._test.stockApplyBillableUnits(
      {},
      {
        summary: {
          applied: 0,
          divergent: 0,
          blocked: 10,
          stale: 5,
          errors: 2,
        },
      },
    ),
    0,
  );
});

test("stock apply nao persiste tokens do request no contexto de billing", () => {
  const billing = ApplyQueue._test.sanitizeBillingCreds({
    meli_user_id: "123",
    tenant_id: "tenant-1",
    meli_conta_id: "conta-1",
    access_token: "secret-access",
    refresh_token: "secret-refresh",
    billing_status: "courtesy_unlimited",
  });

  assert.equal(billing.meli_user_id, "123");
  assert.equal(billing.tenant_id, "tenant-1");
  assert.equal(Object.hasOwn(billing, "access_token"), false);
  assert.equal(Object.hasOwn(billing, "refresh_token"), false);
});

test("telemetria de stock apply separa confirmado de divergente mas cobra ambos escritos", () => {
  const telemetry = ApplyQueue._test.stockApplyTelemetry(
    {
      data: {
        operationId: "STOCK-APPLY-1",
        changes: [{}, {}, {}, {}],
        creditReservation: {
          shadow: true,
          quote: { estimated_credits: 1 },
        },
      },
    },
    {
      total: 4,
      processed: 4,
      applied: 2,
      divergent: 1,
      blocked: 1,
      stale: 0,
      errors: 1,
      startedAt: 1000,
      finishedAt: 61000,
    },
    null,
  );

  assert.equal(telemetry.billing_mode, "shadow");
  assert.equal(telemetry.operation_key, "stock.apply");
  assert.equal(telemetry.operation_id, "STOCK-APPLY-1");
  assert.equal(telemetry.applied, 2);
  assert.equal(telemetry.divergent, 1);
  assert.equal(telemetry.written, 3);
  assert.equal(telemetry.billable_units, 3);
  assert.equal(telemetry.duration_ms, 60000);
});

test("quote de stock apply usa quantidade deduplicada", async () => {
  const previous = {
    baseUrl: process.env.HUB_BASE_URL,
    token: process.env.HUB_INTERNAL_TOKEN,
    fetch: global.fetch,
  };
  process.env.HUB_BASE_URL = "https://hub-stock.example.test";
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
          return JSON.stringify({ ok: true, resource: { resource_key: "ml:stock-test" } });
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
              estimated_credits: 1,
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
    const quote = await ApplyQueue.previewStockApplyCredits({
      mlCreds: {
        meli_user_id: "stock-test",
        tenant_id: "tenant-stock-test",
      },
      changes: [
        { mlb: "MLB123456789", new_stock: 2 },
        { mlb: "mlb123456789", new_stock: 3 },
        { mlb: "MLB987654321", variation_id: "7", new_stock: 4 },
      ],
    });

    assert.equal(quote.operation_key, "stock.apply");
    assert.equal(quote.quantity, 2);
    const quoteCalls = calls.filter(
      (call) => call.pathname === "/v1/internal/resources/credits/quote",
    );
    assert.equal(quoteCalls.length, 1);
    assert.equal(quoteCalls[0].body.operation_key, "stock.apply");
    assert.equal(quoteCalls[0].body.quantity, 2);
  } finally {
    if (previous.baseUrl === undefined) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.HUB_INTERNAL_TOKEN;
    else process.env.HUB_INTERNAL_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});
