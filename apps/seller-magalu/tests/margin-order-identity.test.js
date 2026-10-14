"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {identifyVisibleOrders} = require("../src/services/marginOrderIdentityService");

test("identifies only visible orders owned by the selected account", async () => {
  const seen = [];
  const result = await identifyVisibleOrders({
    accountId: 7,
    codes: ["OWN-1", "FOREIGN-1", "OWN-2"],
    eligible: async (accountId, codes) => {
      assert.equal(accountId, 7);
      assert.deepEqual(codes, ["OWN-1", "FOREIGN-1", "OWN-2"]);
      return ["OWN-1", "OWN-2"];
    },
    reconcile: async (accountId, code) => {
      seen.push([accountId, code]);
      return {code};
    },
  });
  assert.deepEqual(seen, [[7, "OWN-1"], [7, "OWN-2"]]);
  assert.deepEqual(result.map(row => row.code), ["OWN-1", "OWN-2"]);
});

test("caps an identification batch at twenty distinct orders", async () => {
  const seen = [];
  await identifyVisibleOrders({
    accountId: 7,
    codes: [...Array.from({length: 25}, (_, index) => String(index)), "0"],
    eligible: async (_accountId, codes) => codes,
    reconcile: async (_accountId, code) => { seen.push(code); return {code}; },
  });
  assert.equal(seen.length, 20);
  assert.equal(new Set(seen).size, 20);
});

test("reconciles no more than three orders concurrently", async () => {
  let active = 0, maximum = 0;
  await identifyVisibleOrders({
    accountId: 7,
    codes: ["1", "2", "3", "4", "5", "6"],
    eligible: async (_accountId, codes) => codes,
    reconcile: async (_accountId, code) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return {code};
    },
  });
  assert.equal(maximum, 3);
});

test("keeps other orders available when one reconciliation fails", async () => {
  const rows = await identifyVisibleOrders({
    accountId: 7,
    codes: ["FAIL", "OK"],
    eligible: async (_accountId, codes) => codes,
    reconcile: async (_accountId, code) => {
      if (code === "FAIL") throw new Error("remote failure");
      return {code};
    },
  });
  assert.deepEqual(rows, [{code:"FAIL", state:"failed"}, {code:"OK"}]);
});

test("identity endpoint validates account access and order ownership before remote reads", () => {
  const root = join(__dirname, "..", "src");
  const route = readFileSync(join(root, "routes", "uxAnalytics.routes.js"), "utf8");
  const controller = readFileSync(join(root, "controllers", "uxAnalyticsController.js"), "utf8");
  const repository = readFileSync(join(root, "repositories", "orderRepository.js"), "utf8");
  assert.match(route, /post\("\/margins\/orders\/identify",controller\.identifyMarginOrders\)/);
  assert.match(controller, /const a=await accountFor\(req\)/);
  assert.match(controller, /ownedCodes\(accountId,codes\)/);
  assert.match(repository, /async function ownedCodes\(accountId,codes\)/);
  assert.match(repository, /account_id=\$1 and code=any\(\$2::text\[\]\)/);
});
