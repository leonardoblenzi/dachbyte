"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function clearModule(relative) { try { delete require.cache[require.resolve(relative)]; } catch (_error) {} }
async function withLoadStubs(stubs, load, run) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return original.call(this, request, parent, isMain);
  };
  try { return await run(load()); } finally { Module._load = original; }
}

test("catalog queue reuses the active account job instead of adding another full sync", async () => {
  const adds = [];
  const existing = { id: "magalu-catalog-full-7", getState: async () => "active" };
  class FakeQueue {
    async getJob() { return existing; }
    async add(name, data, options) { adds.push({ name, data, options }); return { id: options.jobId }; }
  }
  clearModule("../src/queues/magaluQueue");
  await withLoadStubs({
    "bullmq": { Queue: FakeQueue },
    "../config/redis": { ensureRedisConnected: async () => ({}) },
    "../config/queueNames": { catalogSync: "magalu-catalog-sync" },
  }, () => require("../src/queues/magaluQueue"), async (queue) => {
    const job = await queue.enqueueCatalogSync(7, { dachTenantId: "dach-7" });
    assert.deepEqual(job, { id: "magalu-catalog-full-7", scheduled: false });
    assert.equal(adds.length, 0);
  });
});
