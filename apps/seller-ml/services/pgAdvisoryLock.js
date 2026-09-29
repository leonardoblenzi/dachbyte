"use strict";

function normalizeLockKey(value) {
  const key = String(value || "").trim();
  if (!key) throw new Error("pg advisory lock key is required");
  return key;
}

async function withPgAdvisoryLock(lockKey, fn, options = {}) {
  const db = options.db || require("../db/db");
  const wait = options.wait === true;
  const key = normalizeLockKey(lockKey);

  if (!db || typeof db.withClient !== "function") {
    throw new Error("db.withClient is required for session-scoped advisory locks");
  }
  if (typeof fn !== "function") {
    throw new Error("withPgAdvisoryLock requires a callback");
  }

  return db.withClient(async (client) => {
    const sql = wait
      ? "select pg_advisory_lock(hashtext($1)) as locked"
      : "select pg_try_advisory_lock(hashtext($1)) as locked";
    const lockResult = await client.query(sql, [key]);
    const locked = wait ? true : Boolean(lockResult.rows?.[0]?.locked);

    if (!locked) {
      return { skipped: true, reason: "lock_not_acquired", lock_key: key };
    }

    try {
      return await fn(client);
    } finally {
      await client
        .query("select pg_advisory_unlock(hashtext($1)) as unlocked", [key])
        .catch((error) => {
          console.warn(`[ML][DB] Falha ao liberar advisory lock ${key}:`, error?.message || error);
        });
    }
  });
}

module.exports = {
  normalizeLockKey,
  withPgAdvisoryLock,
};
