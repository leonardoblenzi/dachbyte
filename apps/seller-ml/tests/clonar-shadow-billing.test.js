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
          estimated_credits: 1,
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
          quote: { estimated_credits: 1 },
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

const Billing = require("../services/clonarAnuncioBillingService");
Module._load = originalLoad;

test("clone quote usa listing.clone e uma unidade no fluxo atual", async () => {
  calls.length = 0;
  const quote = await Billing.previewCloneCredits({
    mlCreds: { meli_user_id: "123", tenant_id: "tenant-1" },
    draftId: 17,
  });

  assert.equal(quote.operation_key, "listing.clone");
  assert.equal(quote.quantity, 1);
  assert.equal(quote.estimated_credits, 1);

  const call = calls.find((entry) => entry.type === "quote");
  assert.equal(call.payload.operationKey, "listing.clone");
  assert.equal(call.payload.units, 1);
});

test("clone ja publicado tem custo zero e nao consulta quote", async () => {
  calls.length = 0;
  const quote = await Billing.previewCloneCredits({
    mlCreds: { meli_user_id: "123" },
    draftId: 17,
    alreadyPublished: true,
  });

  assert.equal(quote.quantity, 0);
  assert.equal(quote.estimated_credits, 0);
  assert.equal(quote.already_published, true);
  assert.equal(calls.filter((entry) => entry.type === "quote").length, 0);
});

test("reserva de clone usa operationId na idempotencia", async () => {
  calls.length = 0;
  const operationId = "CLONE-17-abc";
  await Billing.reserveCloneCredits({
    mlCreds: { meli_user_id: "123", tenant_id: "tenant-1" },
    draftId: 17,
    operationId,
  });

  const call = calls.find((entry) => entry.type === "reserve");
  assert.equal(call.payload.operationKey, "listing.clone");
  assert.equal(call.payload.units, 1);
  assert.equal(call.payload.idempotencyKey, "listing.clone:CLONE-17-abc");
});

test("clone liquida uma unidade somente quando novo MLB foi criado", async () => {
  calls.length = 0;
  const reservation = { shadow: true };

  await Billing.settleCloneCredits(reservation, {
    publishedItemId: "MLB123456789",
    alreadyPublished: false,
  });
  let settle = calls.find((entry) => entry.type === "settle");
  assert.equal(settle.options.release, false);
  assert.equal(settle.options.consumedUnits, 1);

  calls.length = 0;
  await Billing.settleCloneCredits(reservation, {
    publishedItemId: null,
    alreadyPublished: false,
  });
  settle = calls.find((entry) => entry.type === "settle");
  assert.equal(settle.options.release, true);
  assert.equal(settle.options.consumedUnits, null);

  calls.length = 0;
  await Billing.settleCloneCredits(reservation, {
    publishedItemId: "MLB123456789",
    alreadyPublished: true,
  });
  settle = calls.find((entry) => entry.type === "settle");
  assert.equal(settle.options.release, true);
});

test("telemetria de clone registra tentativas sem multiplicar unidade faturavel", () => {
  const telemetry = Billing.cloneBillingTelemetry({
    reservation: {
      shadow: true,
      quote: { estimated_credits: 1 },
    },
    operationId: "CLONE-17-abc",
    draftId: 17,
    publishedItemId: "MLB123456789",
    publishAttempts: 4,
    validationAttempts: 2,
    startedAt: 1000,
    finishedAt: 61000,
  });

  assert.equal(telemetry.billing_mode, "shadow");
  assert.equal(telemetry.operation_key, "listing.clone");
  assert.equal(telemetry.operation_id, "CLONE-17-abc");
  assert.equal(telemetry.published, 1);
  assert.equal(telemetry.billable_units, 1);
  assert.equal(telemetry.publish_attempts, 4);
  assert.equal(telemetry.validation_attempts, 2);
  assert.equal(telemetry.duration_ms, 60000);
});

test("servico de clone preserva MLB criado quando persistencia local falha", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../services/clonarAnuncioService.js"),
    "utf8",
  );

  assert.match(source, /wrapped\.publishedItemId\s*=\s*publishedItemId/);
  assert.match(source, /error\.publishedItemId\s*=\s*publishedItemId/);
  assert.match(source, /publish_attempts:\s*publishAttempts\.length/);
});
