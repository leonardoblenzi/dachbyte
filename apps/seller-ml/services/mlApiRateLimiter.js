"use strict";

const crypto = require("crypto");
const { getSharedRedis } = require("../lib/redisClient");

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_REQUESTS_PER_SECOND = 20;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_COOLDOWN_MS = 120_000;

let lastRedisWarningAt = 0;
const localTokenAccountMap = new Map();

const ACQUIRE_CONCURRENCY_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local lease_ms = tonumber(ARGV[2])
local max_concurrent = tonumber(ARGV[3])
local permit_id = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
local current = redis.call('ZCARD', key)
if current >= max_concurrent then
  return 0
end
redis.call('ZADD', key, now + lease_ms, permit_id)
redis.call('PEXPIRE', key, lease_ms + 5000)
return 1
`;

const RELEASE_CONCURRENCY_SCRIPT = `
return redis.call('ZREM', KEYS[1], ARGV[1])
`;

const ACQUIRE_RATE_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local request_id = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window_ms)
local current = redis.call('ZCARD', key)
if current >= max_requests then
  local earliest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if earliest[2] then
    local wait_ms = math.max(1, tonumber(earliest[2]) + window_ms - now)
    return {0, wait_ms}
  end
  return {0, window_ms}
end
redis.call('ZADD', key, now, request_id)
redis.call('PEXPIRE', key, window_ms + 1000)
return {1, 0}
`;

const EXTEND_COOLDOWN_SCRIPT = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local current = redis.call('PTTL', key)
if current == -2 or current < ttl then
  redis.call('SET', key, '1', 'PX', ttl)
  return ttl
end
return current
`;

function intFromEnv(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(raw)));
}

function boolFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(value)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(value)) return false;
  return fallback;
}

function getLimiterConfig() {
  return {
    enabled: boolFromEnv("ML_API_LIMITER_ENABLED", true),
    failClosed: boolFromEnv("ML_API_LIMITER_FAIL_CLOSED", false),
    maxConcurrent: intFromEnv(
      "ML_API_ACCOUNT_MAX_CONCURRENT",
      DEFAULT_MAX_CONCURRENT,
      1,
      64,
    ),
    requestsPerSecond: intFromEnv(
      "ML_API_ACCOUNT_REQUESTS_PER_SECOND",
      DEFAULT_REQUESTS_PER_SECOND,
      0,
      500,
    ),
    acquireTimeoutMs: intFromEnv(
      "ML_API_LIMITER_ACQUIRE_TIMEOUT_MS",
      DEFAULT_ACQUIRE_TIMEOUT_MS,
      250,
      120_000,
    ),
    pollMs: intFromEnv(
      "ML_API_LIMITER_POLL_MS",
      DEFAULT_POLL_MS,
      10,
      2_000,
    ),
    leaseMs: intFromEnv(
      "ML_API_LIMITER_LEASE_MS",
      DEFAULT_LEASE_MS,
      5_000,
      10 * 60_000,
    ),
    maxCooldownMs: intFromEnv(
      "ML_API_LIMITER_MAX_COOLDOWN_MS",
      DEFAULT_MAX_COOLDOWN_MS,
      1_000,
      15 * 60_000,
    ),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function tokenFingerprint(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function tokenMapKey(fingerprint) {
  return `ml:api-governor:v1:token-map:${String(fingerprint || "")}`;
}

function tokenMapTtlMs() {
  return intFromEnv("ML_API_TOKEN_ACCOUNT_MAP_TTL_MS", 8 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
}

async function registerMlAccessTokenAccount({ accessToken, meliContaId } = {}) {
  const fingerprint = tokenFingerprint(accessToken);
  const contaId = Number(meliContaId);
  if (!fingerprint || !Number.isFinite(contaId) || contaId <= 0) return false;

  const identity = `account:${Math.trunc(contaId)}`;
  const current = localTokenAccountMap.get(fingerprint);
  const now = Date.now();
  if (current?.identity === identity && current.expiresAt > now + 60_000) {
    return true;
  }

  const ttl = tokenMapTtlMs();
  localTokenAccountMap.set(fingerprint, { identity, expiresAt: now + ttl });
  try {
    const redis = getSharedRedis("ml-api-governor");
    await redis.set(tokenMapKey(fingerprint), identity, "PX", ttl);
    return true;
  } catch (error) {
    warnRedisOnce(error);
    return true;
  }
}

function normalizeIdentity({ accessToken, meliContaId, accountKey } = {}) {
  const contaId = Number(meliContaId);
  if (Number.isFinite(contaId) && contaId > 0) {
    return `account:${Math.trunc(contaId)}`;
  }

  const normalizedAccountKey = String(accountKey || "").trim().toLowerCase();
  if (normalizedAccountKey && normalizedAccountKey !== "default") {
    return `account-key:${crypto
      .createHash("sha256")
      .update(normalizedAccountKey)
      .digest("hex")
      .slice(0, 24)}`;
  }

  const fingerprint = tokenFingerprint(accessToken);
  return fingerprint ? `token:${fingerprint}` : null;
}

async function resolveIdentity(input = {}) {
  const direct = normalizeIdentity(input);
  if (!direct || !direct.startsWith("token:")) return direct;

  const fingerprint = tokenFingerprint(input.accessToken);
  if (!fingerprint) return direct;
  const local = localTokenAccountMap.get(fingerprint);
  if (local?.identity && local.expiresAt > Date.now()) return local.identity;
  if (local) localTokenAccountMap.delete(fingerprint);

  try {
    const redis = getSharedRedis("ml-api-governor");
    const mapped = String((await redis.get(tokenMapKey(fingerprint))) || "").trim();
    if (/^account:\d+$/.test(mapped)) {
      localTokenAccountMap.set(fingerprint, {
        identity: mapped,
        expiresAt: Date.now() + Math.min(tokenMapTtlMs(), 15 * 60 * 1000),
      });
      return mapped;
    }
  } catch (error) {
    warnRedisOnce(error);
  }
  return direct;
}

function redisKeys(identity) {
  const suffix = String(identity || "").replace(/[^a-zA-Z0-9:_-]/g, "_");
  return {
    concurrency: `ml:api-governor:v1:${suffix}:concurrency`,
    rate: `ml:api-governor:v1:${suffix}:rate`,
    cooldown: `ml:api-governor:v1:${suffix}:cooldown`,
  };
}

function makePermitId(prefix = "permit") {
  return `${prefix}:${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString("hex")}`;
}

function warnRedisOnce(error) {
  const now = Date.now();
  if (now - lastRedisWarningAt < 60_000) return;
  lastRedisWarningAt = now;
  console.warn(
    "[ML API Governor] Redis indisponivel; limitador em fail-open:",
    error?.message || error,
  );
}

async function readCooldown(redis, key) {
  const ttl = Number(await redis.pttl(key));
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
}

async function acquireConcurrency(redis, key, permitId, config, deadline) {
  for (;;) {
    const now = Date.now();
    if (now >= deadline) {
      const error = new Error("Timeout aguardando slot global de API Mercado Livre.");
      error.code = "ML_API_LIMITER_TIMEOUT";
      error.statusCode = 503;
      throw error;
    }

    const acquired = Number(
      await redis.eval(
        ACQUIRE_CONCURRENCY_SCRIPT,
        1,
        key,
        now,
        config.leaseMs,
        config.maxConcurrent,
        permitId,
      ),
    );
    if (acquired === 1) return true;
    await sleep(Math.min(config.pollMs, Math.max(1, deadline - now)));
  }
}

async function acquireRateWindow(redis, key, requestId, config, deadline) {
  if (config.requestsPerSecond <= 0) return true;

  const windowMs = 1_000;
  for (;;) {
    const now = Date.now();
    if (now >= deadline) {
      const error = new Error("Timeout aguardando janela global de API Mercado Livre.");
      error.code = "ML_API_RATE_LIMIT_TIMEOUT";
      error.statusCode = 503;
      throw error;
    }

    const result = await redis.eval(
      ACQUIRE_RATE_SCRIPT,
      1,
      key,
      now,
      windowMs,
      config.requestsPerSecond,
      requestId,
    );
    const ok = Number(Array.isArray(result) ? result[0] : 0) === 1;
    if (ok) return true;

    const retryAfter = Number(Array.isArray(result) ? result[1] : config.pollMs);
    const waitMs = Math.max(
      config.pollMs,
      Math.min(Number.isFinite(retryAfter) ? retryAfter : config.pollMs, 1_000),
    );
    await sleep(Math.min(waitMs, Math.max(1, deadline - now)));
  }
}

async function acquirePermit(identity, config = getLimiterConfig()) {
  if (!config.enabled || !identity) {
    return { acquired: false, bypassed: true, identity };
  }

  const redis = getSharedRedis("ml-api-governor");
  const keys = redisKeys(identity);
  const deadline = Date.now() + config.acquireTimeoutMs;
  const permitId = makePermitId("permit");
  const requestId = makePermitId("request");

  try {
    for (;;) {
      const cooldownMs = await readCooldown(redis, keys.cooldown);
      if (cooldownMs <= 0) break;
      if (Date.now() + cooldownMs >= deadline) {
        const error = new Error("Mercado Livre solicitou cooldown para esta conta.");
        error.code = "ML_API_COOLDOWN_ACTIVE";
        error.statusCode = 429;
        error.retryAfterMs = cooldownMs;
        throw error;
      }
      await sleep(Math.min(cooldownMs, 1_000));
    }

    await acquireConcurrency(redis, keys.concurrency, permitId, config, deadline);
    try {
      await acquireRateWindow(redis, keys.rate, requestId, config, deadline);
    } catch (error) {
      await redis.eval(RELEASE_CONCURRENCY_SCRIPT, 1, keys.concurrency, permitId).catch(() => {});
      throw error;
    }

    return {
      acquired: true,
      bypassed: false,
      identity,
      permitId,
      concurrencyKey: keys.concurrency,
    };
  } catch (error) {
    if (config.failClosed || error?.code?.startsWith("ML_API_")) throw error;
    warnRedisOnce(error);
    return { acquired: false, bypassed: true, identity };
  }
}

async function releasePermit(permit) {
  if (!permit?.acquired || !permit.concurrencyKey || !permit.permitId) return;
  try {
    const redis = getSharedRedis("ml-api-governor");
    await redis.eval(
      RELEASE_CONCURRENCY_SCRIPT,
      1,
      permit.concurrencyKey,
      permit.permitId,
    );
  } catch (error) {
    warnRedisOnce(error);
  }
}

async function withMlApiPermit(identityInput, task, config = getLimiterConfig()) {
  if (typeof task !== "function") {
    throw new TypeError("withMlApiPermit requer uma funcao task.");
  }

  const identity = await resolveIdentity(identityInput);
  if (!config.enabled || !identity) return task();

  let permit = null;
  try {
    permit = await acquirePermit(identity, config);
    return await task();
  } finally {
    await releasePermit(permit);
  }
}

async function registerMlApiCooldown(identityInput, retryAfterMs) {
  const config = getLimiterConfig();
  if (!config.enabled) return 0;

  const identity = await resolveIdentity(identityInput);
  if (!identity) return 0;

  const parsed = Number(retryAfterMs);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  const ttl = Math.max(1_000, Math.min(config.maxCooldownMs, Math.trunc(parsed)));

  try {
    const redis = getSharedRedis("ml-api-governor");
    const keys = redisKeys(identity);
    return Number(await redis.eval(EXTEND_COOLDOWN_SCRIPT, 1, keys.cooldown, ttl)) || ttl;
  } catch (error) {
    if (config.failClosed) throw error;
    warnRedisOnce(error);
    return 0;
  }
}

module.exports = {
  getLimiterConfig,
  normalizeIdentity,
  registerMlAccessTokenAccount,
  registerMlApiCooldown,
  withMlApiPermit,
  _test: {
    redisKeys,
    resolveIdentity,
    tokenFingerprint,
    tokenMapKey,
    ACQUIRE_CONCURRENCY_SCRIPT,
    ACQUIRE_RATE_SCRIPT,
  },
};
