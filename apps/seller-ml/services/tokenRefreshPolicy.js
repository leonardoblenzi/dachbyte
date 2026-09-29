"use strict";

const DEFAULT_REFRESH_SKEW_MS = 90 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 8 * 1000;
const DEFAULT_LOCK_POLL_MS = 100;

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function refreshSkewMs() {
  return positiveInt(
    process.env.ML_TOKEN_REFRESH_SKEW_MS,
    DEFAULT_REFRESH_SKEW_MS,
    5_000,
    10 * 60 * 1000,
  );
}

function refreshLockTimeoutMs() {
  return positiveInt(
    process.env.ML_TOKEN_REFRESH_LOCK_TIMEOUT_MS,
    DEFAULT_LOCK_TIMEOUT_MS,
    1_000,
    60_000,
  );
}

function refreshLockPollMs() {
  return positiveInt(
    process.env.ML_TOKEN_REFRESH_LOCK_POLL_MS,
    DEFAULT_LOCK_POLL_MS,
    25,
    2_000,
  );
}

function parseDateMs(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function evaluateAccessToken(creds = {}, nowMs = Date.now(), skewMs = refreshSkewMs()) {
  const accessToken = String(creds.access_token || "").trim();
  if (!accessToken) {
    return { usable: false, should_refresh: true, reason: "access_token_missing" };
  }

  const expiresAtMs = parseDateMs(creds.access_expires_at);
  if (expiresAtMs == null) {
    // Tokens legados nem sempre possuem access_expires_at. Não fazemos /users/me
    // só para validar; a chamada real ao ML será a autoridade.
    return {
      usable: true,
      should_refresh: false,
      reason: "expiry_unknown_assume_usable",
      expires_at_ms: null,
    };
  }

  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs > skewMs) {
    return {
      usable: true,
      should_refresh: false,
      reason: "access_token_fresh",
      expires_at_ms: expiresAtMs,
      remaining_ms: remainingMs,
    };
  }

  return {
    usable: false,
    should_refresh: true,
    reason: remainingMs <= 0 ? "access_token_expired" : "access_token_near_expiry",
    expires_at_ms: expiresAtMs,
    remaining_ms: remainingMs,
  };
}

function isReplayableBody(body) {
  if (body == null) return true;
  if (typeof body === "string") return true;
  if (Buffer.isBuffer(body)) return true;
  if (body instanceof URLSearchParams) return true;
  if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer) return true;
  return false;
}

module.exports = {
  DEFAULT_REFRESH_SKEW_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_POLL_MS,
  evaluateAccessToken,
  isReplayableBody,
  parseDateMs,
  refreshLockPollMs,
  refreshLockTimeoutMs,
  refreshSkewMs,
};
