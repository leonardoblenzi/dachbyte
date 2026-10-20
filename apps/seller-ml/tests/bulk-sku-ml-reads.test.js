"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { withRetry } = require("../services/bulkSkuMlReads");

test("large jobs retry transient ML reads but not permanent errors", async () => {
  let calls = 0;
  const transient = { get: async () => { calls += 1; if (calls === 1) throw Object.assign(new Error("rate"), { status: 429 }); return { ok: true }; } };
  assert.deepEqual(await withRetry(transient, async () => {}).get("/items/MLB123456", {}), { ok: true });
  assert.equal(calls, 2);
  calls = 0;
  const permanent = { get: async () => { calls += 1; throw Object.assign(new Error("bad"), { status: 400 }); } };
  await assert.rejects(withRetry(permanent, async () => {}).get("/items/MLB123456", {}), /bad/);
  assert.equal(calls, 1);
});
