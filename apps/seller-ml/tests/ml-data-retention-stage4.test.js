"use strict";

process.env.ML_DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test?sslmode=disable";

const test = require("node:test");
const assert = require("node:assert/strict");
const Retention = require("../services/mlDataRetentionService");

test("politicas de retencao possuem defaults conservadores e configuraveis", () => {
  const policies = Retention.getRetentionPolicies({});
  const byKey = new Map(policies.map((p) => [p.key, p]));
  assert.equal(byKey.get("sku_price_history").days, 730);
  assert.equal(byKey.get("reputation_snapshots").days, 730);
  assert.equal(byKey.get("ranking_snapshots").days, 1095);
  assert.equal(byKey.get("stock_watch_events").days, 365);
  assert.equal(byKey.get("sku_sync_runs").days, 365);

  const custom = Retention.getRetentionPolicies({
    ML_DATA_RETENTION_PRICE_HISTORY_DAYS: "0",
    ML_DATA_RETENTION_RANKING_DAYS: "1500",
  });
  const customByKey = new Map(custom.map((p) => [p.key, p]));
  assert.equal(customByKey.get("sku_price_history").days, 0);
  assert.equal(customByKey.get("ranking_snapshots").days, 1500);
});

test("cleanup e limitado por lote e nao apaga tabelas inexistentes", async () => {
  let deleteCalls = 0;
  const client = {
    async query(sql, params) {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }] };
      if (sql.includes("to_regclass")) {
        return { rows: [{ table_name: params[0] === "ml.test_history" ? "ml.test_history" : null }] };
      }
      if (/delete from ml\.test_history/i.test(sql)) {
        deleteCalls += 1;
        return { rowCount: deleteCalls === 1 ? 2 : 0, rows: [] };
      }
      throw new Error(`query inesperada: ${sql}`);
    },
  };
  const fakeDb = { withClient: async (fn) => fn(client) };
  const policies = [
    {
      key: "test_history",
      tableCandidates: ["ml.test_history"],
      column: "created_at",
      kind: "timestamp",
      days: 30,
    },
    {
      key: "missing",
      tableCandidates: ["ml.missing_history"],
      column: "created_at",
      kind: "timestamp",
      days: 30,
    },
  ];

  const result = await Retention.runDataRetentionCleanup({
    db: fakeDb,
    policies,
    batchSize: 2,
    maxBatches: 3,
  });

  assert.equal(result.ok, true);
  assert.equal(result.deleted, 2);
  assert.equal(deleteCalls, 2);
  assert.equal(result.results[0].deleted, 2);
  assert.equal(result.results[1].skipped, true);
  assert.equal(result.results[1].reason, "table_not_found");
});

test("policy com zero dias fica desativada", async () => {
  const result = await Retention._test.cleanupPolicy(
    { query: async () => { throw new Error("nao deveria consultar banco"); } },
    {
      key: "disabled",
      tableCandidates: ["ml.anything"],
      column: "created_at",
      kind: "timestamp",
      days: 0,
    },
  );
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "retention_disabled");
});
