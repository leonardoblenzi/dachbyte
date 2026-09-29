"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadRetentionWithStubs() {
  const cleanCalls = [];
  class FakeBull {
    constructor(name) {
      this.name = name;
    }
    async clean(grace, status, limit) {
      cleanCalls.push({ queue: this.name, grace, status, limit });
      return [];
    }
    async close() {}
  }

  const redis = {
    async set() { return "OK"; },
    async eval() { return 1; },
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "bull") return FakeBull;
    if (request === "../lib/redisClient") {
      return {
        getSharedRedis() { return redis; },
        makeBullClient() { return {}; },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const path = require.resolve("../services/bullRetentionService");
    delete require.cache[path];
    return { service: require("../services/bullRetentionService"), cleanCalls };
  } finally {
    Module._load = originalLoad;
  }
}

test("retencao cobre filas principais e fila de webhook", () => {
  const { service } = loadRetentionWithStubs();
  const names = service.getManagedQueueNames();
  for (const expected of [
    "prazo-producao-queue",
    "financeiro-ml-sku-catalog-sync",
    "Filtro Anuncios Export Queue v3",
    "promo-jobs",
    "meli-webhook-notifications",
  ]) {
    assert.equal(names.includes(expected), true, expected);
  }
});

test("cleanup toca somente completed e failed", async () => {
  const { service, cleanCalls } = loadRetentionWithStubs();
  const result = await service.runBullRetentionCleanup({
    queueNames: ["queue-a"],
    policy: {
      enabled: true,
      completedRetentionMs: 1000,
      failedRetentionMs: 2000,
      cleanLimit: 100,
      maxBatches: 1,
      intervalMs: 60_000,
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    cleanCalls.map((call) => call.status),
    ["completed", "failed"],
  );
  assert.deepEqual(
    cleanCalls.map((call) => call.grace),
    [1000, 2000],
  );
});
