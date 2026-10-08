"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { createShopeeRetirementService } = require("../src/services/internalRetirementService");

function makeDb(status = "ACTIVE") {
  const statements = [];
  const client = { query: async (sql, values) => {
    statements.push({ sql, values });
    if (sql.includes('FROM "Shop"')) return { rows: [{ id: 8, shopId: "555", status, tenantGlobalId: "dach-1" }] };
    return { rows: [], rowCount: 1 };
  } };
  return { statements, withClient: async (fn) => fn(client) };
}

test("Shopee deactivation targets the external shop and revokes tokens", async () => {
  const db = makeDb();
  const retire = createShopeeRetirementService({ withClient: db.withClient });
  const result = await retire({ action: "deactivate", tenant_id: "dach-1", external_account_id: "555", resource_key: "shopee:555", actor_id: "admin", reason: "Encerrar", operation_id: "op-1" });
  assert.equal(result.state, "disabled");
  assert.ok(db.statements.some((item) => item.sql.includes('DELETE FROM "OAuthToken"')));
  assert.ok(db.statements.some((item) => item.sql.includes("status = 'INACTIVE'")));
  assert.ok(!db.statements.some((item) => item.sql.includes('DELETE FROM "Shop"')));
});

test("Shopee deletion requires a deactivated shop", async () => {
  const db = makeDb();
  const retire = createShopeeRetirementService({ withClient: db.withClient });
  await assert.rejects(retire({ action: "delete", tenant_id: "dach-1", external_account_id: "555", resource_key: "shopee:555", actor_id: "admin", reason: "Encerrar", operation_id: "op-2" }), /retirement_not_disabled/);
});

test("Shopee mounts the Hub-only endpoint before browser session authentication", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/routes/index.js"), "utf8");
  assert.ok(source.includes('router.use("/internal/hub/retirement"'));
  assert.ok(source.indexOf('router.use("/internal/hub/retirement"') < source.indexOf("router.use(sessionAuth)"));
});
