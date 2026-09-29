"use strict";

process.env.ML_DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test?sslmode=disable";

const test = require("node:test");
const assert = require("node:assert/strict");
const { withPgAdvisoryLock } = require("../services/pgAdvisoryLock");

test("advisory lock usa a mesma sessao para lock, callback e unlock", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params, client });
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }] };
      throw new Error(`query inesperada: ${sql}`);
    },
  };
  const fakeDb = {
    async withClient(fn) {
      return fn(client);
    },
  };

  const result = await withPgAdvisoryLock(
    "stage4_test_lock",
    async (lockedClient) => {
      assert.equal(lockedClient, client);
      return { ok: true };
    },
    { db: fakeDb },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /pg_try_advisory_lock/);
  assert.match(calls[1].sql, /pg_advisory_unlock/);
  assert.equal(calls[0].client, calls[1].client);
});

test("advisory lock retorna skipped quando outra instancia possui o lock", async () => {
  let callbackCalled = false;
  const client = {
    async query(sql) {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: false }] };
      throw new Error("unlock nao deveria ser chamado");
    },
  };
  const fakeDb = { withClient: async (fn) => fn(client) };

  const result = await withPgAdvisoryLock(
    "stage4_busy",
    async () => {
      callbackCalled = true;
    },
    { db: fakeDb },
  );

  assert.equal(callbackCalled, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "lock_not_acquired");
});
