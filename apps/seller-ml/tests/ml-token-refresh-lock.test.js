"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { withPostgresRefreshLock } = require("../services/tokenRefreshLock");

test("lock distribuido espera, executa uma vez e libera advisory lock", async () => {
  let tryCount = 0;
  let taskCount = 0;
  let unlockCount = 0;

  const client = {
    async query(sql) {
      if (sql.includes("pg_try_advisory_lock")) {
        tryCount += 1;
        return { rows: [{ locked: tryCount >= 2 }] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        unlockCount += 1;
        return { rows: [{ unlocked: true }] };
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
  };

  const db = {
    async withClient(fn) {
      return fn(client);
    },
  };

  const value = await withPostgresRefreshLock(
    db,
    123,
    async (lockedClient) => {
      taskCount += 1;
      assert.equal(lockedClient, client);
      return "ok";
    },
    { timeoutMs: 1_000, pollMs: 25 },
  );

  assert.equal(value, "ok");
  assert.equal(tryCount, 2);
  assert.equal(taskCount, 1);
  assert.equal(unlockCount, 1);
});

test("sem meli_conta_id executa sem advisory lock", async () => {
  let withClientCalled = false;
  const db = {
    async withClient() {
      withClientCalled = true;
      throw new Error("nao deveria chamar");
    },
  };

  const value = await withPostgresRefreshLock(db, null, async (client) => {
    assert.equal(client, null);
    return 42;
  });

  assert.equal(value, 42);
  assert.equal(withClientCalled, false);
});
