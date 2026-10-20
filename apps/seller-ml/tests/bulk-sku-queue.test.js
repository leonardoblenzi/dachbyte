"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { enqueueBulkSkuJob } = require("../services/bulkSkuQueueService");

test("queue contains only the persisted job ID, never account credentials or spreadsheet rows", async () => {
  const calls = [];
  const queue = { add: async (...args) => { calls.push(args); return { id: args[1].jobId }; } };
  await enqueueBulkSkuJob("job-1", queue);
  assert.deepEqual(calls[0][0], "bulk-sku-apply");
  assert.deepEqual(calls[0][1], { jobId: "job-1" });
  assert.equal(calls[0][2].jobId, "job-1");
});

test("dedicated ML worker starts the bulk SKU processor", () => {
  const source = fs.readFileSync(require("node:path").join(__dirname, "../worker.js"), "utf8");
  assert.match(source, /bulkSkuQueueService\.initWorker\(\)/);
});
