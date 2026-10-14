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
          estimated_credits: Math.ceil(Number(payload.units || 0) / 15000),
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
            estimated_credits: Math.ceil(Number(payload.units || 0) / 15000),
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

const Billing = require("../services/filtroAnunciosBillingService");
Module._load = originalLoad;

test("filtro basico usa peso 1 e consulta completa usa peso 8", () => {
  assert.equal(Billing.filterWeight({}), 1);
  assert.equal(
    Billing.filterWeight({
      date_from: "2026-09-01",
      date_to: "2026-09-30",
      include_visits: true,
      include_ads: true,
      include_promos: true,
      include_category: true,
      detail_variations: true,
    }),
    8,
  );
});

test("30 mil anuncios basicos viram 30 mil weighted units", () => {
  assert.equal(Billing.weightedUnits({}, 30000), 30000);
  assert.equal(
    Billing.weightedUnits(
      {
        date_from: "2026-09-01",
        date_to: "2026-09-30",
        include_visits: true,
        include_ads: true,
        include_promos: true,
        include_category: true,
        detail_variations: true,
      },
      30000,
    ),
    240000,
  );
});

test("quote antes da descoberta e marcado como deferred", async () => {
  calls.length = 0;
  const quote = await Billing.previewCredits({
    mlCreds: { meli_user_id: "123" },
    filters: { include_promos: true },
    itemCount: null,
  });

  assert.equal(quote.operation_key, "listing.filter");
  assert.equal(quote.deferred, true);
  assert.equal(quote.quantity, null);
  assert.equal(quote.weight, 2);
  assert.equal(quote.estimated_credits, null);
  assert.equal(quote.minimum_estimated_credits, 1);

  const call = calls.find((entry) => entry.type === "quote");
  assert.equal(call.payload.operationKey, "listing.filter");
  assert.equal(call.payload.units, 1);
});

test("reserva usa volume descoberto, peso e operationId", async () => {
  calls.length = 0;
  const filters = {
    date_from: "2026-09-01",
    date_to: "2026-09-30",
    include_ads: true,
  };
  await Billing.reserveForDiscoveredItems({
    mlCreds: { meli_user_id: "123" },
    filters,
    itemCount: 30000,
    operationId: "LISTING-FILTER-abc",
  });

  const call = calls.find((entry) => entry.type === "reserve");
  assert.equal(call.payload.operationKey, "listing.filter");
  assert.equal(call.payload.units, 120000);
  assert.equal(
    call.payload.idempotencyKey,
    "listing.filter:LISTING-FILTER-abc",
  );
});

test("filtro concluido liquida weighted units; cancelado libera tudo", async () => {
  calls.length = 0;
  const reservation = { shadow: true };
  const filters = { include_promos: true };

  await Billing.settleReservation(reservation, {
    filters,
    itemCount: 30000,
    completed: true,
  });
  let call = calls.find((entry) => entry.type === "settle");
  assert.equal(call.options.release, false);
  assert.equal(call.options.consumedUnits, 60000);

  calls.length = 0;
  await Billing.settleReservation(reservation, {
    filters,
    itemCount: 30000,
    completed: false,
  });
  call = calls.find((entry) => entry.type === "settle");
  assert.equal(call.options.release, true);
  assert.equal(call.options.consumedUnits, null);
});

test("telemetria diferencia volume descoberto do resultado final", () => {
  const telemetry = Billing.telemetry({
    reservation: {
      shadow: true,
      quote: { estimated_credits: 4 },
    },
    operationId: "LISTING-FILTER-abc",
    filters: { include_promos: true },
    discoveredItems: 30000,
    resultRows: 50,
    completed: true,
    startedAt: 1000,
    finishedAt: 61000,
  });

  assert.equal(telemetry.billing_mode, "shadow");
  assert.equal(telemetry.operation_key, "listing.filter");
  assert.equal(telemetry.discovered_items, 30000);
  assert.equal(telemetry.result_rows, 50);
  assert.equal(telemetry.weight, 2);
  assert.equal(telemetry.billable_units, 60000);
  assert.equal(telemetry.duration_ms, 60000);
});

test("fila reserva somente apos descobrir e refinar allIds", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../services/filtroAnunciosQueueService.js"),
    "utf8",
  );

  assert.doesNotMatch(source, /reserveAdsFilterCredits/);
  const dedupeIndex = source.indexOf("allIds = Array.from(new Set(allIds))");
  const reserveIndex = source.indexOf("FilterBilling.reserveForDiscoveredItems");
  const fullDetailIndex = source.indexOf(
    'phase: "Carregando detalhes dos anuncios"',
    reserveIndex,
  );

  assert.ok(dedupeIndex >= 0);
  assert.ok(reserveIndex > dedupeIndex);
  assert.ok(fullDetailIndex > reserveIndex);
  assert.match(source, /billingDiscoveredItems/);
});
