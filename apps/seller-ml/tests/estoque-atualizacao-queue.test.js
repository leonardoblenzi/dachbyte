"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function mockQueueDependencies(request, parent, isMain) {
  if (request === "node-fetch") return global.fetch;
  if (request === "bull") return class Bull {};
  if (request === "./authAuditService") return { recordAuthEvent: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
};
const queueService = require("../services/estoqueAtualizacaoQueueService");
Module._load = originalLoad;

test("stock queue stores account identity but never caller credentials", async () => {
  let data;
  queueService._test.setQueue({
    add: async (payload) => {
      data = payload;
      return { id: "job-1" };
    },
  });
  queueService._test.setCredentialResolver(async () => ({
    accessToken: "fresh-token",
    mlCreds: { refresh_token: "fresh-refresh" },
  }));

  await queueService.enqueueStockUpdateJob({
    accessToken: "request-token",
    mlCreds: { access_token: "request-token", refresh_token: "request-refresh" },
    accountKey: "drossi",
    changes: [{ mlb: "MLB123456789", expected_current_stock: 1, new_stock: 2 }],
  });

  assert.equal(data.accountKey, "drossi");
  assert.equal(JSON.stringify(data).includes("request-token"), false);
  assert.equal(JSON.stringify(data).includes("request-refresh"), false);
  assert.equal(Object.hasOwn(data, "accessToken"), false);
  assert.equal(Object.hasOwn(data, "mlCreds"), false);
  queueService._test.resetCredentialResolver();
});

test("stock worker resolves fresh credentials from accountKey", async () => {
  let processed;
  queueService._test.setCredentialResolver(async (accountKey) => {
    assert.equal(accountKey, "drossi");
    return { accessToken: "fresh-token", mlCreds: { refresh_token: "fresh-refresh" } };
  });
  queueService._test.setStockProcessor(async (input) => {
    processed = input;
    return { summary: { processed: 1, applied: 1 }, processed: 1, canceled: false };
  });
  const job = {
    id: "job-2",
    data: { accountKey: "drossi", changes: [{ mlb: "MLB123456789" }], auditContext: {} },
    update: async () => {},
    progress: async () => {},
  };

  await queueService._test.processJob(job);

  assert.equal(processed.accessToken, "fresh-token");
  assert.equal(processed.mlCreds.refresh_token, "fresh-refresh");
  assert.equal(Object.hasOwn(job.data, "accessToken"), false);
  queueService._test.resetCredentialResolver();
  queueService._test.resetStockProcessor();
});

test("stock retry job never copies source credentials into Bull data", async () => {
  let retryData;
  const source = {
    id: "source-job",
    data: {
      accountKey: "drossi",
      accountLabel: "DRossi",
      accessToken: "old-access-token",
      mlCreds: { refresh_token: "old-refresh-token" },
    },
    returnvalue: {
      rows: [{
        mlb: "MLB123456789", variation_id: null, actual_current_stock: 1,
        requested_stock: 2, retryable: true, write_applied: false,
      }],
    },
    getState: async () => "completed",
  };
  queueService._test.setQueue({
    getJob: async () => source,
    add: async (data) => { retryData = data; return { id: "retry-job" }; },
  });

  await queueService.retryFailedStockJob("source-job", { accountKey: "drossi" });

  assert.equal(JSON.stringify(retryData).includes("old-access-token"), false);
  assert.equal(JSON.stringify(retryData).includes("old-refresh-token"), false);
  assert.equal(Object.hasOwn(retryData, "mlCreds"), false);
});
