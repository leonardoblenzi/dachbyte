"use strict";

const { createError } = require("../core/errors");

function integrationError(message, code, { retryable = true, statusCode = 500 } = {}) {
  const error = createError(message, statusCode, code);
  error.retryable = retryable;
  return error;
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(provider)) {
    throw integrationError("Provedor de integracao invalido.", "INTEGRATION_PROVIDER_INVALID", { retryable: false, statusCode: 400 });
  }
  return provider;
}

function backoffMs(attempt) {
  const base = Math.max(1000, Number(process.env.VOLT_CORE_JOB_RETRY_BASE_MS || 5000));
  const cap = Math.max(base, Number(process.env.VOLT_CORE_JOB_RETRY_MAX_MS || 15 * 60 * 1000));
  return Math.min(cap, base * (2 ** Math.max(0, Number(attempt || 1) - 1)));
}

function normalizeCredentialRef(value) {
  if (value == null || String(value).trim() === "") return null;
  const ref = String(value).trim();
  if (!/^[a-z][a-z0-9+.-]{1,31}:[^\s]{1,512}$/i.test(ref)) {
    throw integrationError("credentialRef deve apontar para um resolvedor externo (ex.: env:NOME).", "INTEGRATION_CREDENTIAL_REF_INVALID", { retryable: false, statusCode: 400 });
  }
  const scheme = ref.slice(0, ref.indexOf(":")).toLowerCase();
  if (["plain", "raw", "secret", "token", "password"].includes(scheme)) {
    throw integrationError("credentialRef nao pode armazenar segredo inline.", "INTEGRATION_CREDENTIAL_REF_INSECURE", { retryable: false, statusCode: 400 });
  }
  return ref;
}

function sanitizeHeaders(headers = {}) {
  const allowed = ["content-type", "user-agent", "x-request-id", "x-event-id", "x-signature-version"];
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = String(key || "").toLowerCase();
    if (allowed.includes(lower)) normalized[lower] = String(value ?? "").slice(0, 500);
  }
  return normalized;
}

function assertConfigHasNoSecrets(value, path = "config") {
  if (!value || typeof value !== "object") return;
  const forbidden = /(password|passwd|secret|token|authorization|api[_-]?key|access[_-]?key|refresh[_-]?key|private[_-]?key)/i;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.test(key)) {
      throw integrationError(`Segredo nao pode ser persistido em ${path}.${key}; use credentialRef.`, "INTEGRATION_SECRET_STORAGE_FORBIDDEN", { retryable: false, statusCode: 400 });
    }
    if (child && typeof child === "object") assertConfigHasNoSecrets(child, `${path}.${key}`);
  }
}

module.exports = { assertConfigHasNoSecrets, backoffMs, integrationError, normalizeCredentialRef, normalizeProvider, sanitizeHeaders };
