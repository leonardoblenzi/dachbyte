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

test("operacoes de status nao sao precificadas como exclusao", () => {
  const telemetry = Service._test.bulkDeleteTelemetry(
    {
      data: {
        operation: "PAUSE",
        operationId: "LISTING-PAUSE-1",
        mlbIds: ["MLB123456789"],
        creditReservation: null,
      },
    },
    { operation: "PAUSE", total: 1, processed: 1, success: 1, failed: 0 },
  );

  assert.equal(telemetry.billing_mode, "not_priced");
  assert.equal(telemetry.operation_key, null);
  assert.equal(telemetry.billable_units, 0);
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

test("enqueue de PAUSE nao usa tarifa de bulk delete", async () => {
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
  assert.equal(queued.creditReservation, null);
  assert.equal(hubCalls.filter((entry) => entry.type === "reserve").length, 0);
});
