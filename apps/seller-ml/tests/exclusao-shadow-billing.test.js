"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
const hubCalls = [];

Module._load = function mockDependencies(request, parent, isMain) {
  if (request === "bull") return class Bull {};
  if (request === "../lib/redisClient") {
    return {
      makeBullClient: () => null,
      getSharedRedis: () => ({
        get: async () => null,
        set: async () => "OK",
        del: async () => 1,
      }),
    };
  }
  if (request === "./excluirAnuncioService") {
    return {
      prepararState: async () => ({ token: "test", creds: {} }),
      excluirUnico: async () => ({ success: true, deletado: true }),
      relistar: async () => ({ success: true }),
      atualizarStatus: async () => ({ success: true, changed: true }),
    };
  }
  if (request === "./jobReviewHelper") {
    return { attachJobReview: (value) => value };
  }
  if (request === "./jobContract") {
    return {
      attachJobContract: (value) => value,
      backendJobIdFromUid: (_module, value) => String(value || ""),
    };
  }
  if (request === "./authAuditService") {
    return { recordAuthEvent: async () => {} };
  }
  if (request === "./hubCreditsService") {
    return {
      quoteCredits: async (payload) => {
        hubCalls.push({ type: "quote", payload });
        return {
          estimated_credits: 3,
          available_credits: 100,
          sufficient: true,
          unlimited: false,
        };
      },
      reserveCredits: async (payload) => {
        hubCalls.push({ type: "reserve", payload });
        return {
          shadow: true,
          bypass: true,
          operation_key: payload.operationKey,
          idempotency_key: payload.idempotencyKey,
          operation_quantity: payload.units,
          quote: { estimated_credits: 3 },
        };
      },
      settleCredits: async (reservation, options = {}) => {
        hubCalls.push({ type: "settle", reservation, options });
        return reservation || null;
      },
    };
  }
  if (request === "./mlHeavyOperationGovernor") {
    return {
      waitForHeavyOperationLease: async () => ({
        refresh: async () => {},
        release: async () => {},
      }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Service = require("../services/exclusaoLoteJobService");
Module._load = originalLoad;

test("bulk delete normaliza MLBs, remove invalidos e duplicados antes do quote", async () => {
  hubCalls.length = 0;

  const quote = await Service.previewBulkDeleteCredits({
    mlCreds: { meli_user_id: "123", tenant_id: "tenant-1" },
    mlbIds: [
      "mlb123456789",
      "MLB123456789",
      "invalido",
      "MLB987654321",
    ],
  });

  assert.equal(quote.operation_key, "listing.bulk-delete");
  assert.equal(quote.quantity, 2);

  const call = hubCalls.find((entry) => entry.type === "quote");
  assert.ok(call);
  assert.equal(call.payload.operationKey, "listing.bulk-delete");
  assert.equal(call.payload.units, 2);
});

test("bulk delete usa operationId na idempotencia", () => {
  assert.equal(
    Service._test.bulkDeleteIdempotencyKey("LISTING-DELETE-1"),
    "listing.bulk-delete:LISTING-DELETE-1",
  );
});

test("somente DELETE usa a operacao comercial de exclusao", () => {
  assert.equal(Service._test.isBillableDeleteOperation("DELETE"), true);
  assert.equal(Service._test.isBillableDeleteOperation("PAUSE"), false);
  assert.equal(Service._test.isBillableDeleteOperation("ACTIVATE"), false);
  assert.equal(Service._test.isBillableDeleteOperation("CLOSE"), false);
});

test("bulk delete cobra somente exclusoes concluidas com sucesso", () => {
  assert.equal(
    Service._test.bulkDeleteBillableUnits(
      { data: { operation: "DELETE" } },
      { success: 7, failed: 3, processed: 10 },
    ),
    7,
  );
  assert.equal(
    Service._test.bulkDeleteBillableUnits(
      { data: { operation: "DELETE" }, returnvalue: { success: 4 } },
      {},
    ),
    4,
  );
  assert.equal(
    Service._test.bulkDeleteBillableUnits(
      { data: { operation: "PAUSE" } },
      { success: 10, failed: 0, processed: 10 },
    ),
    0,
  );
});

test("telemetria shadow preserva exclusoes faturaveis e falhas", () => {
  const telemetry = Service._test.bulkDeleteTelemetry(
    {
      data: {
        operation: "DELETE",
        operationId: "LISTING-DELETE-1",
        mlbIds: new Array(10).fill("MLB123456789"),
        creditReservation: {
          shadow: true,
          quote: { estimated_credits: 1 },
        },
      },
    },
    {
      operation: "DELETE",
      total: 10,
      processed: 10,
      success: 8,
      failed: 2,
      startedAt: 1000,
      finishedAt: 61000,
    },
  );

  assert.equal(telemetry.billing_mode, "shadow");
  assert.equal(telemetry.operation_key, "listing.bulk-delete");
  assert.equal(telemetry.operation_id, "LISTING-DELETE-1");
  assert.equal(telemetry.selected, 10);
  assert.equal(telemetry.processed, 10);
  assert.equal(telemetry.success, 8);
  assert.equal(telemetry.failed, 2);
  assert.equal(telemetry.billable_units, 8);
  assert.equal(telemetry.duration_ms, 60000);
});

test("operacoes de status usam chaves proprias e cobram somente changed=true", () => {
  assert.equal(Service._test.listingBillingOperationKey("ACTIVATE"), "listing.activate");
  assert.equal(Service._test.listingBillingOperationKey("PAUSE"), "listing.pause");
  assert.equal(Service._test.listingBillingOperationKey("CLOSE"), "listing.close");

  assert.equal(
    Service._test.listingBillableUnits(
      { data: { operation: "PAUSE" } },
      { success: 10, changed: 6, failed: 0, processed: 10 },
    ),
    6,
  );
  assert.equal(
    Service._test.listingBillableUnits(
      { data: { operation: "ACTIVATE" } },
      { success: 10, changed: 0, failed: 0, processed: 10 },
    ),
    0,
  );

  const telemetry = Service._test.listingBillingTelemetry(
    {
      data: {
        operation: "CLOSE",
        operationId: "LISTING-CLOSE-1",
        mlbIds: new Array(5).fill("MLB123456789"),
        creditReservation: {
          shadow: true,
          quote: { estimated_credits: 1 },
        },
      },
    },
    { operation: "CLOSE", total: 5, processed: 5, success: 5, changed: 3, failed: 0 },
  );

  assert.equal(telemetry.billing_mode, "shadow");
  assert.equal(telemetry.operation_key, "listing.close");
  assert.equal(telemetry.changed, 3);
  assert.equal(telemetry.billable_units, 3);
});


test("enqueue de DELETE reserva creditos uma vez com quantidade deduplicada", async () => {
  hubCalls.length = 0;
  let queued = null;
  Service._test.setQueue({
    add: async (payload) => {
      queued = payload;
      return { id: "delete-job-1" };
    },
  });

  const jobId = await Service.enqueueJob({
    operation: "DELETE",
    accountKey: "conta-1",
    mlCreds: { meli_user_id: "123", tenant_id: "tenant-1" },
    mlbIds: ["MLB123456789", "mlb123456789", "MLB987654321"],
  });

  assert.equal(jobId, "delete-job-1");
  assert.deepEqual(queued.mlbIds, ["MLB123456789", "MLB987654321"]);
  assert.match(queued.operationId, /^LISTING-DELETE-/);
  assert.equal(queued.creditReservation.operation_key, "listing.bulk-delete");

  const reserveCalls = hubCalls.filter((entry) => entry.type === "reserve");
  assert.equal(reserveCalls.length, 1);
  assert.equal(reserveCalls[0].payload.operationKey, "listing.bulk-delete");
  assert.equal(reserveCalls[0].payload.units, 2);
  assert.equal(
    reserveCalls[0].payload.idempotencyKey,
    `listing.bulk-delete:${queued.operationId}`,
  );
});

test("enqueue de PAUSE usa tarifa propria e idempotencia propria", async () => {
  hubCalls.length = 0;
  let queued = null;
  Service._test.setQueue({
    add: async (payload) => {
      queued = payload;
      return { id: "pause-job-1" };
    },
  });

  const jobId = await Service.enqueueJob({
    operation: "PAUSE",
    accountKey: "conta-1",
    mlCreds: { meli_user_id: "123", tenant_id: "tenant-1" },
    mlbIds: ["MLB123456789"],
  });

  assert.equal(jobId, "pause-job-1");
  assert.equal(queued.operation, "PAUSE");
  assert.equal(queued.billingOperationKey, "listing.pause");
  assert.equal(queued.creditReservation.operation_key, "listing.pause");

  const reserveCalls = hubCalls.filter((entry) => entry.type === "reserve");
  assert.equal(reserveCalls.length, 1);
  assert.equal(reserveCalls[0].payload.operationKey, "listing.pause");
  assert.equal(
    reserveCalls[0].payload.idempotencyKey,
    `listing.pause:${queued.operationId}`,
  );
});

test("relist usa chaves proprias e cobra somente relistagens concluidas", () => {
  assert.equal(Service._test.listingBillingOperationKey("CLOSE_RELIST"), "listing.relist");
  assert.equal(Service._test.listingBillingOperationKey("PAUSE_RELIST"), "listing.pause-relist");

  assert.equal(
    Service._test.listingBillableUnits(
      { data: { operation: "CLOSE_RELIST" } },
      { success: 10, relisted: 7, failed: 3, processed: 10 },
    ),
    7,
  );
  assert.equal(
    Service._test.listingBillableUnits(
      { data: { operation: "PAUSE_RELIST" } },
      { success: 5, relisted: 4, fallbackRelisted: 2, failed: 1, processed: 5 },
    ),
    4,
  );
  assert.equal(
    Service._test.listingBillableUnits(
      { data: { operation: "PAUSE_RELIST" } },
      { success: 0, relisted: 0, fallbackRelisted: 0, failed: 5, processed: 5 },
    ),
    0,
  );
});

test("enqueue de CLOSE_RELIST reserva tarifa propria", async () => {
  hubCalls.length = 0;
  let queued = null;
  Service._test.setQueue({
    add: async (payload) => {
      queued = payload;
      return { id: "relist-job-1" };
    },
  });

  const jobId = await Service.enqueueJob({
    operation: "CLOSE_RELIST",
    accountKey: "conta-1",
    mlCreds: { meli_user_id: "123", tenant_id: "tenant-1" },
    mlbIds: ["MLB123456789", "MLB987654321"],
  });

  assert.equal(jobId, "relist-job-1");
  assert.equal(queued.billingOperationKey, "listing.relist");
  assert.equal(queued.creditReservation.operation_key, "listing.relist");
  const reserveCall = hubCalls.find((entry) => entry.type === "reserve");
  assert.equal(reserveCall.payload.operationKey, "listing.relist");
  assert.equal(reserveCall.payload.units, 2);
  assert.equal(
    reserveCall.payload.idempotencyKey,
    `listing.relist:${queued.operationId}`,
  );
});

test("enqueue de PAUSE_RELIST reserva tarifa propria", async () => {
  hubCalls.length = 0;
  let queued = null;
  Service._test.setQueue({
    add: async (payload) => {
      queued = payload;
      return { id: "pause-relist-job-1" };
    },
  });

  const jobId = await Service.enqueueJob({
    operation: "PAUSE_RELIST",
    accountKey: "conta-1",
    mlCreds: { meli_user_id: "123", tenant_id: "tenant-1" },
    mlbIds: ["MLB123456789"],
  });

  assert.equal(jobId, "pause-relist-job-1");
  assert.equal(queued.billingOperationKey, "listing.pause-relist");
  assert.equal(queued.creditReservation.operation_key, "listing.pause-relist");
  const reserveCall = hubCalls.find((entry) => entry.type === "reserve");
  assert.equal(reserveCall.payload.operationKey, "listing.pause-relist");
  assert.equal(
    reserveCall.payload.idempotencyKey,
    `listing.pause-relist:${queued.operationId}`,
  );
});

test("telemetria de PAUSE_RELIST separa fallback sem duplicar unidades faturaveis", () => {
  const telemetry = Service._test.listingBillingTelemetry(
    {
      data: {
        operation: "PAUSE_RELIST",
        operationId: "LISTING-PAUSE_RELIST-1",
        mlbIds: new Array(8).fill("MLB123456789"),
        creditReservation: {
          shadow: true,
          quote: { estimated_credits: 1 },
        },
      },
    },
    {
      operation: "PAUSE_RELIST",
      total: 8,
      processed: 8,
      success: 6,
      relisted: 6,
      fallbackRelisted: 2,
      failed: 2,
      startedAt: 1000,
      finishedAt: 61000,
    },
  );

  assert.equal(telemetry.operation_key, "listing.pause-relist");
  assert.equal(telemetry.relisted, 6);
  assert.equal(telemetry.fallback_relisted, 2);
  assert.equal(telemetry.billable_units, 6);
  assert.equal(telemetry.duration_ms, 60000);
});

test("quote de status usa a chave comercial da operacao", async () => {
  hubCalls.length = 0;

  const quote = await Service.previewListingOperationCredits({
    operation: "ACTIVATE",
    mlCreds: { meli_user_id: "123", tenant_id: "tenant-1" },
    mlbIds: ["MLB123456789", "MLB987654321"],
  });

  assert.equal(quote.operation_key, "listing.activate");
  assert.equal(quote.quantity, 2);
  const quoteCall = hubCalls.find((entry) => entry.type === "quote");
  assert.equal(quoteCall.payload.operationKey, "listing.activate");
  assert.equal(quoteCall.payload.units, 2);
});
