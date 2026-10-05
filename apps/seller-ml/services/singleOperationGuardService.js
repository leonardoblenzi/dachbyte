"use strict";

const crypto = require("crypto");
const { getSharedRedis } = require("../lib/redisClient");
const {
  getRequestIp,
  getRequestUserAgent,
  recordAuthEvent,
} = require("./authAuditService");

const COOLDOWN_SECONDS = 10 * 60;

const POLICIES = Object.freeze({
  "listing.delete": Object.freeze({
    burstLimit: 15,
    sustainedLimit: 50,
    bulkOperation: "listing.bulk-delete",
  }),
  "promotions.remove": Object.freeze({
    burstLimit: 20,
    sustainedLimit: 100,
    bulkOperation: "promotions.remove",
  }),
  "production-time.apply": Object.freeze({
    burstLimit: 30,
    sustainedLimit: 150,
    bulkOperation: "production-time.apply",
  }),
  "dimensions.apply": Object.freeze({
    burstLimit: 30,
    sustainedLimit: 150,
    bulkOperation: "dimensions.apply",
  }),
  "listing.status": Object.freeze({
    burstLimit: 40,
    sustainedLimit: 200,
    bulkOperation: "listing.activate|listing.pause|listing.close",
  }),
});

function normalizeOperation(value) {
  return String(value || "").trim().toLowerCase();
}

function accountIdentity(res) {
  const meliContaId = String(res?.locals?.mlCreds?.meli_conta_id || "").trim();
  if (meliContaId) return `meli:${meliContaId}`;
  const accountKey = String(res?.locals?.accountKey || "").trim();
  if (accountKey) return `account:${accountKey}`;
  return null;
}

function accountHash(identity) {
  return crypto.createHash("sha256").update(String(identity || "")).digest("hex").slice(0, 24);
}

function redis() {
  return getSharedRedis("single-operation-guard");
}

function keys(identity, operation) {
  const prefix = `ml:single-guard:${accountHash(identity)}:${operation}`;
  return {
    attempts1m: `${prefix}:attempts:60`,
    attempts10m: `${prefix}:attempts:600`,
    success1m: `${prefix}:success:60`,
    success10m: `${prefix}:success:600`,
    cooldown: `${prefix}:cooldown`,
  };
}

async function incrWindow(client, key, ttlSeconds) {
  const value = Number(await client.incr(key));
  if (value === 1) await client.expire(key, ttlSeconds);
  return value;
}

async function checkAndRecordAttempt({ res, operation }) {
  const normalizedOperation = normalizeOperation(operation);
  const policy = POLICIES[normalizedOperation];
  if (!policy) throw new Error(`single_operation_guard_unknown_operation:${normalizedOperation || "empty"}`);

  const identity = accountIdentity(res);
  if (!identity) {
    return {
      allowed: true,
      guarded: false,
      reason: "account_identity_missing",
      operation: normalizedOperation,
      policy,
    };
  }

  try {
    const client = redis();
    const k = keys(identity, normalizedOperation);
    const cooldownTtl = Number(await client.ttl(k.cooldown));
    if (cooldownTtl > 0) {
      return {
        allowed: false,
        guarded: true,
        operation: normalizedOperation,
        policy,
        retryAfterSeconds: cooldownTtl,
        reason: "cooldown_active",
      };
    }

    const [attempts1m, attempts10m] = await Promise.all([
      incrWindow(client, k.attempts1m, 60),
      incrWindow(client, k.attempts10m, 600),
    ]);

    if (
      attempts1m > policy.burstLimit ||
      attempts10m > policy.sustainedLimit
    ) {
      await client.set(k.cooldown, "1", "EX", COOLDOWN_SECONDS);
      return {
        allowed: false,
        guarded: true,
        operation: normalizedOperation,
        policy,
        attempts1m,
        attempts10m,
        retryAfterSeconds: COOLDOWN_SECONDS,
        reason:
          attempts1m > policy.burstLimit
            ? "burst_limit_exceeded"
            : "sustained_limit_exceeded",
      };
    }

    return {
      allowed: true,
      guarded: true,
      operation: normalizedOperation,
      policy,
      attempts1m,
      attempts10m,
      retryAfterSeconds: 0,
    };
  } catch (error) {
    console.warn(
      "[single-operation-guard] Redis indisponivel; fail-open:",
      error?.message || error,
    );
    return {
      allowed: true,
      guarded: false,
      reason: "redis_unavailable",
      operation: normalizedOperation,
      policy,
    };
  }
}

async function recordSuccessfulChange({ res, operation }) {
  const normalizedOperation = normalizeOperation(operation);
  if (!POLICIES[normalizedOperation]) return null;
  const identity = accountIdentity(res);
  if (!identity) return null;

  try {
    const client = redis();
    const k = keys(identity, normalizedOperation);
    const [success1m, success10m] = await Promise.all([
      incrWindow(client, k.success1m, 60),
      incrWindow(client, k.success10m, 600),
    ]);
    return { success1m, success10m };
  } catch (error) {
    console.warn(
      "[single-operation-guard] falha ao registrar sucesso:",
      error?.message || error,
    );
    return null;
  }
}

async function auditBlocked(req, res, decision) {
  return recordAuthEvent({
    userId: Number(req.user?.uid || req.user?.id || res.locals?.user?.uid || res.locals?.user?.id) || null,
    email: req.user?.email || res.locals?.user?.email || null,
    evento: "single_operation_bulk_guard_blocked",
    status: "warn",
    ip: getRequestIp(req),
    userAgent: getRequestUserAgent(req),
    metadata: {
      accountKey: res.locals?.accountKey || null,
      accountLabel: res.locals?.accountLabel || res.locals?.accountKey || null,
      meli_conta_id: res.locals?.mlCreds?.meli_conta_id || null,
      operation: decision.operation,
      bulk_operation: decision.policy?.bulkOperation || null,
      burst_limit: decision.policy?.burstLimit || null,
      sustained_limit: decision.policy?.sustainedLimit || null,
      attempts_1m: decision.attempts1m ?? null,
      attempts_10m: decision.attempts10m ?? null,
      retry_after_seconds: decision.retryAfterSeconds || COOLDOWN_SECONDS,
      reason: decision.reason || null,
      route: req.originalUrl || req.url || null,
      method: req.method || null,
    },
  }).catch((error) => {
    console.error(
      "[single-operation-guard] audit bloqueio falhou:",
      error?.message || error,
    );
  });
}

function requireSingleMlb(extractor) {
  return function singleMlbShapeMiddleware(req, res, next) {
    const raw = extractor(req);
    if (Array.isArray(raw) || (raw && typeof raw === "object")) {
      return res.status(400).json({
        success: false,
        code: "single_item_required",
        error: "Esta rota aceita exatamente um MLB por requisicao.",
      });
    }

    const mlb = String(raw || "").trim().toUpperCase();
    if (!/^MLB\d{5,}$/.test(mlb)) {
      return res.status(400).json({
        success: false,
        code: "invalid_mlb",
        error: "Informe exatamente um MLB valido nesta rota.",
      });
    }

    req.singleOperationMlb = mlb;
    return next();
  };
}

function guardSingleOperation(operation) {
  const normalizedOperation = normalizeOperation(operation);
  return async function singleOperationGuardMiddleware(req, res, next) {
    const decision = await checkAndRecordAttempt({
      res,
      operation: normalizedOperation,
    });
    req.singleOperationGuard = decision;

    if (decision.allowed) return next();

    await auditBlocked(req, res, decision);
    const retryAfter = Math.max(
      1,
      Math.trunc(Number(decision.retryAfterSeconds) || COOLDOWN_SECONDS),
    );
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({
      success: false,
      code: "bulk_operation_required",
      operation: normalizedOperation,
      bulk_operation: decision.policy?.bulkOperation || null,
      retry_after_seconds: retryAfter,
      error:
        "Volume de operacoes individuais acima do limite. Use a operacao em massa correspondente.",
    });
  };
}

module.exports = {
  COOLDOWN_SECONDS,
  POLICIES,
  accountIdentity,
  checkAndRecordAttempt,
  recordSuccessfulChange,
  requireSingleMlb,
  guardSingleOperation,
  _test: {
    accountHash,
    keys,
  },
};
