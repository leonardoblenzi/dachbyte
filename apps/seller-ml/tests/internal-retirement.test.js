"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { createMlRetirementService } = require("../services/internalRetirementService");

function makeDb(status = "ativa") {
  const statements = [];
  const client = { query: async (sql, values) => {
    statements.push({ sql, values });
    if (sql.includes("from meli_contas mc")) return { rows: [{ id: 9, empresa_id: 4, status, meli_user_id: "123", tenant_global_id: "dach-1" }] };
    return { rows: [], rowCount: 1 };
  } };
  return { statements, withClient: async (fn) => fn(client) };
}

test("ML deactivation uses the external account and tenant and removes usable tokens", async () => {
  const db = makeDb();
  const retire = createMlRetirementService({ withClient: db.withClient });
  const result = await retire({ action: "deactivate", tenant_id: "dach-1", external_account_id: "123", resource_key: "ml:123", actor_id: "admin", reason: "Encerrar", operation_id: "op-1" });
  assert.equal(result.state, "disabled");
  assert.ok(db.statements.some((item) => item.sql.includes("delete from meli_tokens")));
  assert.ok(db.statements.some((item) => item.sql.includes("status = 'desvinculada'")));
  assert.ok(!db.statements.some((item) => item.sql.includes("delete from meli_contas")));
});

test("ML exclusion confirms a previously deactivated account without deleting history", async () => {
  const db = makeDb("desvinculada");
  const retire = createMlRetirementService({ withClient: db.withClient });
  const result = await retire({ action: "delete", tenant_id: "dach-1", external_account_id: "123", resource_key: "ml:123", actor_id: "admin", reason: "Encerrar", operation_id: "op-2" });
  assert.equal(result.state, "deleted");
  assert.ok(!db.statements.some((item) => item.sql.includes("delete from meli_contas")));
});

test("ML exposes the authenticated internal retirement route before browser authentication", () => {
  const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
  assert.ok(source.includes('app.use("/internal/hub/retirement"'));
  assert.ok(source.indexOf('app.use("/internal/hub/retirement"') < source.indexOf("app.use(authGate)"));
});
