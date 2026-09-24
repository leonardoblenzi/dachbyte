"use strict";

const crypto = require("node:crypto");
const env = require("../config/env");
const { getValidAccessToken, refreshAccount } = require("./magaluTokenService");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableMethod(method) {
  return ["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase());
}

async function resolveToken(options) {
  if (options.token) return String(options.token);
  if (!options.accountId) return "";
  const token = await getValidAccessToken(options.accountId, {
    dachTenantId: options.dachTenantId || null,
    minValiditySeconds: options.minValiditySeconds == null ? 120 : options.minValiditySeconds,
  });
  return token.accessToken;
}

async function request(pathOrUrl, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const baseUrl = options.baseUrl || env.MAGALU_API_BASE_URL;
  const url = /^https?:\/\//i.test(String(pathOrUrl || ""))
    ? String(pathOrUrl)
    : `${baseUrl}${String(pathOrUrl || "").startsWith("/") ? "" : "/"}${pathOrUrl}`;
  const attempts = Math.max(1, Number(options.attempts || 3));
  const requestId = options.requestId || crypto.randomUUID();
  let token = await resolveToken(options);
  let refreshedAfter401 = false;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || 12000));
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "X-Request-ID": requestId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.body == null ? {} : { "Content-Type": "application/json" }),
          ...(options.headers || {}),
        },
        body: options.body == null
          ? undefined
          : typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const raw = await response.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch (_error) { data = raw; }
      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          data,
          requestId: response.headers.get("x-request-id") || requestId,
          headers: response.headers,
        };
      }

      // Uma única renovação explícita em 401 para chamadas vinculadas a conta.
      // Não reaplicamos automaticamente POST/PATCH/PUT, evitando escrita dupla.
      if (
        response.status === 401 &&
        options.accountId &&
        !refreshedAfter401 &&
        isRetryableMethod(method)
      ) {
        const refreshed = await refreshAccount(options.accountId, {
          dachTenantId: options.dachTenantId || null,
        });
        token = refreshed.accessToken;
        refreshedAfter401 = true;
        continue;
      }

      const error = new Error(data?.message || data?.error || `Magalu HTTP ${response.status}`);
      error.status = response.status;
      error.payload = data;
      error.requestId = response.headers.get("x-request-id") || requestId;
      lastError = error;
      const retryable = isRetryableMethod(method) && (response.status === 429 || response.status >= 500);
      if (!retryable || attempt >= attempts) throw error;
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 350 * attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableMethod(method) || (error?.status && error.status < 500 && error.status !== 429)) {
        throw error;
      }
      await sleep(350 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("Falha desconhecida na API Magalu.");
}

module.exports = { request };
