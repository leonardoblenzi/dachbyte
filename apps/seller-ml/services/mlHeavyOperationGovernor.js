"use strict";

const crypto = require("crypto");
const { getSharedRedis } = require("../lib/redisClient");

const DEFAULT_LEASE_MS = Math.max(
  30_000,
  Number(process.env.ML_HEAVY_OPERATION_LEASE_MS || 5 * 60 * 1000),
);
const DEFAULT_WAIT_MS = Math.max(
  250,
  Number(process.env.ML_HEAVY_OPERATION_WAIT_MS || 1500),
);
const DEFAULT_MAX_WAIT_MS = Math.max(
  DEFAULT_WAIT_MS,
  Number(process.env.ML_HEAVY_OPERATION_MAX_WAIT_MS || 30 * 60 * 1000),
);

function normalizeAccountKey(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.toLowerCase() === "default") {
    throw new Error("heavy_operation_account_required");
  }
  return normalized;
}

function accountHash(accountKey) {
  return crypto
    .createHash("sha1")
    .update(normalizeAccountKey(accountKey))
    .digest("hex");
}

function normalizeLane(value) {
  const lane = String(value || "write").trim().toLowerCase();
  return lane === "read" ? "read" : "write";
}

function lockKey(accountKey, lane = "write") {
  return `ml:heavy-operation:${normalizeLane(lane)}:lock:${accountHash(accountKey)}`;
}

function metaKey(accountKey, lane = "write") {
  return `ml:heavy-operation:${normalizeLane(lane)}:meta:${accountHash(accountKey)}`;
}

function redisClient() {
  return getSharedRedis("ml:heavy-operation-governor");
}

function safeLeaseMs(value) {
  return Math.max(30_000, Number(value || DEFAULT_LEASE_MS));
}

async function readHolder(redis, accountKey, lane = "write") {
  try {
    const raw = await redis.get(metaKey(accountKey, lane));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function acquireHeavyOperationLease({
  accountKey,
  kind = "heavy_write",
  ownerId = null,
  leaseMs = DEFAULT_LEASE_MS,
  metadata = null,
  lane = "write",
} = {}) {
  const account = normalizeAccountKey(accountKey);
  const normalizedLane = normalizeLane(lane);
  const ttl = safeLeaseMs(leaseMs);
  const ownerToken = `${String(kind || "heavy_write")}:${String(ownerId || crypto.randomUUID())}:${crypto.randomUUID()}`;
  const redis = redisClient();
  const acquired = await redis.set(lockKey(account, normalizedLane), ownerToken, "PX", ttl, "NX");

  if (acquired !== "OK") {
    return {
      acquired: false,
      accountKey: account,
      holder: await readHolder(redis, account, normalizedLane),
      async refresh() { return false; },
      async release() { return false; },
    };
  }

  const holder = {
    account_key: account,
    lane: normalizedLane,
    kind: String(kind || "heavy_write"),
    owner_id: ownerId == null ? null : String(ownerId),
    owner_token: ownerToken,
    acquired_at: new Date().toISOString(),
    lease_ms: ttl,
    metadata: metadata && typeof metadata === "object" ? metadata : null,
  };
  await redis
    .set(metaKey(account, normalizedLane), JSON.stringify(holder), "PX", ttl)
    .catch(() => {});

  return {
    acquired: true,
    accountKey: account,
    holder,
    ownerToken,
    leaseMs: ttl,
    async refresh() {
      const script = `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          redis.call('PEXPIRE', KEYS[1], ARGV[2])
          if redis.call('EXISTS', KEYS[2]) == 1 then
            redis.call('PEXPIRE', KEYS[2], ARGV[2])
          end
          return 1
        end
        return 0
      `;
      const result = await redis.eval(
        script,
        2,
        lockKey(account, normalizedLane),
        metaKey(account, normalizedLane),
        ownerToken,
        String(ttl),
      );
      return Number(result || 0) === 1;
    },
    async release() {
      const script = `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          redis.call('DEL', KEYS[1])
          redis.call('DEL', KEYS[2])
          return 1
        end
        return 0
      `;
      const result = await redis.eval(
        script,
        2,
        lockKey(account, normalizedLane),
        metaKey(account, normalizedLane),
        ownerToken,
      );
      return Number(result || 0) === 1;
    },
  };
}

async function waitForHeavyOperationLease({
  accountKey,
  kind = "heavy_write",
  ownerId = null,
  leaseMs = DEFAULT_LEASE_MS,
  waitMs = DEFAULT_WAIT_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  metadata = null,
  onWait = null,
  shouldCancel = null,
  lane = "write",
} = {}) {
  const startedAt = Date.now();
  const sleepMs = Math.max(250, Number(waitMs || DEFAULT_WAIT_MS));
  const deadlineMs = Math.max(sleepMs, Number(maxWaitMs || DEFAULT_MAX_WAIT_MS));

  while (true) {
    if (typeof shouldCancel === "function" && await shouldCancel()) {
      const error = new Error("heavy_operation_wait_cancelled");
      error.code = "HEAVY_OPERATION_WAIT_CANCELLED";
      throw error;
    }

    const lease = await acquireHeavyOperationLease({
      accountKey,
      kind,
      ownerId,
      leaseMs,
      metadata,
      lane,
    });
    if (lease.acquired) {
      return {
        ...lease,
        waitedMs: Math.max(0, Date.now() - startedAt),
      };
    }

    if (Date.now() - startedAt >= deadlineMs) {
      const error = new Error("heavy_operation_wait_timeout");
      error.code = "HEAVY_OPERATION_WAIT_TIMEOUT";
      error.holder = lease.holder || null;
      throw error;
    }

    if (typeof onWait === "function") {
      await onWait(lease.holder || null, Math.max(0, Date.now() - startedAt));
    }
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}

async function getHeavyOperationHolder(accountKey, lane = "write") {
  const account = normalizeAccountKey(accountKey);
  return readHolder(redisClient(), account, normalizeLane(lane));
}

module.exports = {
  acquireHeavyOperationLease,
  waitForHeavyOperationLease,
  getHeavyOperationHolder,
  _test: {
    accountHash,
    lockKey,
    metaKey,
    normalizeAccountKey,
    normalizeLane,
    safeLeaseMs,
  },
};
