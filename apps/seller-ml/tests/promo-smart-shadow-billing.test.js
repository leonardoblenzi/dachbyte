"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;
const calls = [];

Module._load = function mockDependencies(request, parent, isMain) {
  if (request === "./hubCreditsService") {
    return {
      quoteCredits: async (payload) => {
        calls.push({ type: "quote", payload });
        return {
          estimated_credits: Math.ceil(Number(payload.units || 0) / 1000),
          available_credits: 100,
          sufficient: true,
          unlimited: false,
        };
      },
      reserveCredits: async (payload) => {
        calls.push({ type: "reserve", payload });
        return {
          shadow: true,
          operation_key: payload.operationKey,
          idempotency_key: payload.idempotencyKey,
          operation_quantity: payload.units,
          quote: {
            estimated_credits: Math.ceil(Number(payload.units || 0) / 1000),
          },
        };
      },
      settleCredits: async (reservation, options = {}) => {
        calls.push({ type: "settle", reservation, options });
        return reservation || null;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Billing = require("../services/promoSmartBillingService");
Module._load = originalLoad;

test("SMART optimizer quote usa quantidade selecionada", async () => {
  calls.length = 0;
  const quote = await Billing.previewCredits({
    mlCreds: { meli_user_id: "123", tenant_id: "tenant-1" },
    selected: 2300,
  });

  assert.equal(quote.operation_key, "promotions.smart-optimize");
  assert.equal(quote.quantity, 2300);
  assert.equal(quote.estimated_credits, 3);

  const call = calls.find((entry) => entry.type === "quote");
  assert.equal(call.payload.operationKey, "promotions.smart-optimize");
  assert.equal(call.payload.units, 2300);
});

test("SMART optimizer reserva com idempotencia por operacao", async () => {
  calls.length = 0;
  await Billing.reserveCreditsForOptimization({
    mlCreds: { meli_user_id: "123", tenant_id: "tenant-1" },
    selected: 1200,
    operationId: "SMART-OPT-test-1",
  });

  const call = calls.find((entry) => entry.type === "reserve");
  assert.equal(call.payload.operationKey, "promotions.smart-optimize");
  assert.equal(call.payload.units, 1200);
  assert.equal(
    call.payload.idempotencyKey,
    "promotions.smart-optimize:SMART-OPT-test-1",
  );
});

test("SMART optimizer liquida somente otimizacoes confirmadas", async () => {
  calls.length = 0;
  const reservation = { shadow: true };

  await Billing.settleOptimizationCredits(reservation, { optimized: 7 });
  let call = calls.find((entry) => entry.type === "settle");
  assert.equal(call.options.release, false);
  assert.equal(call.options.consumedUnits, 7);

  calls.length = 0;
  await Billing.settleOptimizationCredits(reservation, { optimized: 0 });
  call = calls.find((entry) => entry.type === "settle");
  assert.equal(call.options.release, true);
  assert.equal(call.options.consumedUnits, null);
});

test("telemetria SMART exclui skipped e erros das unidades faturaveis", () => {
  const telemetry = Billing.telemetry({
    reservation: {
      shadow: true,
      quote: { estimated_credits: 1 },
    },
    operationId: "SMART-OPT-test-2",
    selected: 10,
    processed: 10,
    optimized: 7,
    failed: 1,
    skipped: 2,
    startedAt: 1000,
    finishedAt: 61000,
  });

  assert.equal(telemetry.billing_mode, "shadow");
  assert.equal(telemetry.operation_key, "promotions.smart-optimize");
  assert.equal(telemetry.selected, 10);
  assert.equal(telemetry.optimized, 7);
  assert.equal(telemetry.failed, 1);
  assert.equal(telemetry.skipped, 2);
  assert.equal(telemetry.billable_units, 7);
  assert.equal(telemetry.duration_ms, 60000);
});

test("cancelamento e pausa de seguranca preservam apenas sucessos confirmados", () => {
  const canceled = Billing.telemetry({
    reservation: { shadow: true },
    operationId: "SMART-OPT-cancel",
    selected: 20,
    processed: 8,
    optimized: 3,
    failed: 1,
    skipped: 4,
    cancelled: true,
  });
  assert.equal(canceled.cancelled, true);
  assert.equal(canceled.billable_units, 3);

  const safety = Billing.telemetry({
    reservation: { shadow: true },
    operationId: "SMART-OPT-safety",
    selected: 20,
    processed: 5,
    optimized: 2,
    failed: 1,
    skipped: 2,
    safetyPaused: true,
  });
  assert.equal(safety.safety_paused, true);
  assert.equal(safety.billable_units, 2);
});

test("analise SMART continua fora do billing e optimize usa reserva", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../services/promoSmartOptimizerService.js"),
    "utf8",
  );

  assert.match(source, /job\?\.data\?\.kind !== "optimize"/);
  assert.match(source, /SmartBilling\.reserveCreditsForOptimization/);
  assert.match(source, /optimized:\s*metrics\.success/);
  assert.doesNotMatch(
    source.slice(
      source.indexOf("async startAnalysis"),
      source.indexOf("async getAnalysis"),
    ),
    /reserveCreditsForOptimization/,
  );
});
