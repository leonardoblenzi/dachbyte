"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { createMagaluRetirementService } = require("../src/services/internalRetirementService");
const { createMagaluRetirementHandler } = require("../src/routes/internalRetirement.routes");

test("Hub deactivation disables the exact Magalu tenant without deleting history", async () => {
  const statements = [];
  const service = createMagaluRetirementService({
    query: async (sql, values) => {
      statements.push({ sql, values });
      if (sql.includes("from magalu.accounts")) return { rows: [{ id: 7, status: "active", dach_tenant_id: "dach-1", magalu_tenant_id: "magalu-1" }] };
      return { rows: [], rowCount: 1 };
    },
    unlinkLocalAccount: async () => { throw new Error("must_not_unlink_on_deactivate"); }
  });
  const result = await service({ action: "deactivate", tenant_id: "dach-1", external_account_id: "magalu-1", resource_key: "magalu:magalu-1", actor_id: "admin", reason: "Encerrar", operation_id: "op-1" });
  assert.equal(result.state, "disabled");
  assert.ok(statements.some((item) => item.sql.includes("status='disabled'")));
  assert.ok(!statements.some((item) => item.sql.includes("delete from")));
});

test("Hub deletion reuses Magalu unlink and its write-operation blockers", async () => {
  let unlinked = false;
  const service = createMagaluRetirementService({
    query: async () => ({ rows: [{ id: 7, status: "disabled", dach_tenant_id: "dach-1", magalu_tenant_id: "magalu-1" }] }),
    unlinkLocalAccount: async () => { unlinked = true; return { alreadyRevoked: false }; }
  });
  const result = await service({ action: "delete", tenant_id: "dach-1", external_account_id: "magalu-1", resource_key: "magalu:magalu-1", actor_id: "admin", reason: "Encerrar", operation_id: "op-2" });
  assert.equal(result.state, "deleted");
  assert.equal(unlinked, true);
});

test("Magalu internal retirement endpoint rejects requests without its dedicated secret", async () => {
  let called = false;
  const handler = createMagaluRetirementHandler({
    secret: "dedicated-secret",
    retire: async () => { called = true; return { ok: true, state: "disabled" }; }
  });
  let status = 200;
  const res = { status(code) { status = code; return this; }, json() { return this; } };
  await handler({ headers: {}, body: {} }, res);
  assert.equal(status, 401);
  assert.equal(called, false);
});

test("Magalu mounts the internal endpoint before browser Suite authentication", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
  assert.ok(source.includes('app.use("/internal/hub/retirement"'));
  assert.ok(source.indexOf('app.use("/internal/hub/retirement"') < source.indexOf("app.use(suiteAuth)"));
});
