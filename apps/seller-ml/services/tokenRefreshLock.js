"use strict";

const {
  refreshLockPollMs,
  refreshLockTimeoutMs,
} = require("./tokenRefreshPolicy");

const LOCK_NAMESPACE = "seller-ml:oauth-refresh";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validAccountId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function withPostgresRefreshLock(db, meliContaId, task, options = {}) {
  const accountId = validAccountId(meliContaId);
  if (!accountId || !db || typeof db.withClient !== "function") {
    return task(null);
  }

  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1_000, Number(options.timeoutMs))
    : refreshLockTimeoutMs();
  const pollMs = Number.isFinite(Number(options.pollMs))
    ? Math.max(25, Number(options.pollMs))
    : refreshLockPollMs();
  const lockKey = `${LOCK_NAMESPACE}:${accountId}`;

  return db.withClient(async (client) => {
    const startedAt = Date.now();
    let acquired = false;

    while (!acquired) {
      const result = await client.query(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
        [lockKey],
      );
      acquired = result?.rows?.[0]?.locked === true;
      if (acquired) break;

      if (Date.now() - startedAt >= timeoutMs) {
        const error = new Error(
          `Timeout aguardando lock distribuido de refresh da conta ${accountId}.`,
        );
        error.code = "ML_TOKEN_REFRESH_LOCK_TIMEOUT";
        error.statusCode = 503;
        throw error;
      }

      await sleep(pollMs);
    }

    try {
      return await task(client);
    } finally {
      try {
        await client.query(
          "select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked",
          [lockKey],
        );
      } catch (error) {
        console.error(
          `[ML][Token] Falha ao liberar advisory lock da conta ${accountId}:`,
          error?.message || error,
        );
      }
    }
  });
}

module.exports = {
  LOCK_NAMESPACE,
  withPostgresRefreshLock,
};
