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
          estimated_credits: Math.ceil(Number(payload.units || 0) / 7500),
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
            estimated_credits: Math.ceil(Number(payload.units || 0) / 7500),
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

const Billing = require("../services/financeiroMlCatalogSyncBillingService");
Module._load = originalLoad;

test("sync financeiro soma anuncios relevantes e pedidos lidos", () => {
  assert.equal(
    Billing.workUnits({ relevantItems: 30000, ordersRead: 5000 }),
    35000,
  );
  assert.equal(
    Billing.workUnits({ relevantItems: 12000, ordersRead: 5000 }),
    17000,
  );
});

test("quote manual e deferred antes de descobrir o volume", async () => {
  calls.length = 0;
  const quote = await Billing.previewCredits({
    mlCreds: { meli_user_id: "123" },
  });

  assert.equal(quote.operation_key, "finance.catalog-sync");
  assert.equal(quote.deferred, true);
  assert.equal(quote.estimated_credits, null);
  assert.equal(quote.minimum_estimated_credits, 1);

  const call = calls.find((entry) => entry.type === "quote");
  assert.equal(call.payload.operationKey, "finance.catalog-sync");
  assert.equal(call.payload.units, 1);
});

test("job ja ativo retorna custo zero e nao cria novo quote", async () => {
  calls.length = 0;
  const quote = await Billing.previewCredits({
    mlCreds: { meli_user_id: "123" },
    alreadyRunning: true,
  });

  assert.equal(quote.already_running, true);
  assert.equal(quote.estimated_credits, 0);
  assert.equal(quote.quantity, 0);
  assert.equal(calls.filter((entry) => entry.type === "quote").length, 0);
});

test("reserva usa trabalho descoberto e idempotencia por operacao", async () => {
  calls.length = 0;
  await Billing.reserveForDiscoveredWork({
    mlCreds: { meli_user_id: "123" },
    relevantItems: 30000,
    ordersRead: 5000,
    operationId: "FINANCE-CATALOG-SYNC-test",
  });

  const call = calls.find((entry) => entry.type === "reserve");
  assert.equal(call.payload.operationKey, "finance.catalog-sync");
  assert.equal(call.payload.units, 35000);
  assert.equal(
    call.payload.idempotencyKey,
    "finance.catalog-sync:FINANCE-CATALOG-SYNC-test",
  );
});

test("liquidacao usa apenas trabalho realmente processado", async () => {
  calls.length = 0;
  const reservation = { shadow: true };

  await Billing.settleSyncCredits(reservation, {
    processedItems: 12000,
    ordersRead: 5000,
  });

  let call = calls.find((entry) => entry.type === "settle");
  assert.equal(call.options.release, false);
  assert.equal(call.options.consumedUnits, 17000);

  calls.length = 0;
  await Billing.settleSyncCredits(reservation, {
    processedItems: 0,
    ordersRead: 0,
  });
  call = calls.find((entry) => entry.type === "settle");
  assert.equal(call.options.release, true);
  assert.equal(call.options.consumedUnits, null);
});

test("telemetria interna nunca gera unidades faturaveis", () => {
  const internal = Billing.telemetry({
    trigger: "internal",
    relevantItems: 30000,
    processedItems: 30000,
    ordersRead: 5000,
    completed: true,
  });

  assert.equal(internal.billing_mode, "internal");
  assert.equal(internal.billable_units, 0);
  assert.equal(internal.reserved_units, 0);

  const manual = Billing.telemetry({
    reservation: { shadow: true, quote: { estimated_credits: 5 } },
    trigger: "manual",
    relevantItems: 30000,
    processedItems: 30000,
    ordersRead: 5000,
    completed: true,
  });
  assert.equal(manual.billing_mode, "shadow");
  assert.equal(manual.reserved_units, 35000);
  assert.equal(manual.billable_units, 35000);
});

test("somente controller manual ativa billing; default do servico e interno", () => {
  const controller = fs.readFileSync(
    path.join(__dirname, "../controllers/FinanceiroMlController.js"),
    "utf8",
  );
  const service = fs.readFileSync(
    path.join(__dirname, "../services/financeiroMlSkuCatalogSyncService.js"),
    "utf8",
  );

  assert.match(controller, /trigger:\s*"manual"/);
  assert.match(service, /trigger\s*=\s*"internal"/);
  assert.match(service, /if \(trigger === "manual"\)/);
  assert.match(service, /CatalogBilling\.reserveForDiscoveredWork/);
  assert.match(service, /already_running:\s*true/);
});
