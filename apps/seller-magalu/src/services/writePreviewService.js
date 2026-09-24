"use strict";

const env = require("../config/env");
const catalogRepository = require("../repositories/catalogRepository");
const writeRepository = require("../repositories/writeRepository");
const portfolioReadService = require("./portfolioReadService");
const catalogPayload = require("./catalogPayload");
const {
  normalizeResource,
  buildPayload,
  currentFromRemote,
  equals,
  scopeFor,
  hasScope,
  requestHash,
} = require("./writePayload");

function disabledError() {
  const error = new Error("Escritas Magalu estão desativadas neste ambiente.");
  error.code = "MAGALU_WRITE_DISABLED";
  error.status = 503;
  return error;
}

function scopeError(scope) {
  const error = new Error(`A conta Magalu não possui o scope necessário: ${scope}. Reconecte a conta após liberar a permissão no IDM.`);
  error.code = "MAGALU_WRITE_SCOPE_MISSING";
  error.status = 403;
  error.required_scope = scope;
  return error;
}

function assertWriteReady(account, resource) {
  if (!env.MAGALU_WRITE_ENABLED) throw disabledError();
  const required = scopeFor(resource);
  if (!hasScope(account?.scopes, required)) throw scopeError(required);
  if (String(account?.status || "") !== "active") {
    const error = new Error("A conta Magalu não está ativa para escrita.");
    error.code = "MAGALU_ACCOUNT_NOT_ACTIVE";
    error.status = 409;
    throw error;
  }
  return required;
}

async function readRemote(account, resource, sku) {
  const reader = resource === "price" ? portfolioReadService.getPrice : portfolioReadService.getStock;
  try {
    const response = await reader(account.id, account.dach_tenant_id, sku);
    return { exists: true, payload: response.data || {}, status: response.status || 200, requestId: response.requestId || null };
  } catch (error) {
    if (Number(error?.status) === 404) {
      return { exists: false, payload: {}, status: 404, requestId: error?.requestId || null };
    }
    throw error;
  }
}

function normalizeChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    const error = new Error("Informe ao menos uma alteração para gerar o preview.");
    error.code = "MAGALU_WRITE_CHANGES_REQUIRED";
    error.status = 400;
    throw error;
  }
  if (changes.length > env.MAGALU_WRITE_MAX_BATCH_SIZE) {
    const error = new Error(`O lote excede o limite de ${env.MAGALU_WRITE_MAX_BATCH_SIZE} itens.`);
    error.code = "MAGALU_WRITE_BATCH_TOO_LARGE";
    error.status = 413;
    throw error;
  }
  const seen = new Set();
  return changes.map((change) => {
    const sku = String(change?.sku || "").trim();
    if (!sku) {
      const error = new Error("Todas as linhas do lote precisam de SKU.");
      error.code = "MAGALU_WRITE_SKU_REQUIRED";
      error.status = 422;
      throw error;
    }
    if (seen.has(sku)) {
      const error = new Error(`SKU duplicado no lote: ${sku}.`);
      error.code = "MAGALU_WRITE_DUPLICATE_SKU";
      error.status = 422;
      throw error;
    }
    seen.add(sku);
    return { ...change, sku };
  });
}

async function buildPreview({ account, identity, resource, changes }) {
  const type = normalizeResource(resource);
  assertWriteReady(account, type);
  const normalized = normalizeChanges(changes);
  const rows = [];

  for (const change of normalized) {
    const blocker = await writeRepository.findBlockingOperation(
      account.id,
      account.dach_tenant_id,
      type,
      change.sku,
    );
    if (blocker) {
      rows.push({
        sku: change.sku,
        valid: false,
        changed: false,
        error_code: "MAGALU_WRITE_ACTIVE_OPERATION_EXISTS",
        error: `Já existe uma operação ${blocker.status} não resolvida para este SKU. Reverifique a operação antes de criar uma nova escrita.`,
        blocking_operation_id: blocker.id,
      });
      continue;
    }
    const local = await catalogRepository.getCatalogItem(account.id, change.sku);
    if (!local || local.is_present === false) {
      rows.push({ sku: change.sku, valid: false, changed: false, error_code: "SKU_NOT_IN_LOCAL_CATALOG", error: "SKU não está presente no espelho local. Sincronize o catálogo antes de alterar." });
      continue;
    }
    try {
      const requested = buildPayload(type, change);
      const remote = await readRemote(account, type, change.sku);
      const before = remote.exists ? currentFromRemote(type, remote.payload, catalogPayload) : {};
      const changed = !remote.exists || !equals(type, before, requested);
      rows.push({
        sku: change.sku,
        title: local.title || null,
        valid: true,
        changed,
        exists: remote.exists,
        method: remote.exists ? "PATCH" : "POST",
        before,
        requested,
        request_hash: requestHash(type, change.sku, before, requested),
        remote_status: remote.status,
        request_id: remote.requestId || null,
      });
    } catch (error) {
      rows.push({
        sku: change.sku,
        title: local.title || null,
        valid: false,
        changed: false,
        error_code: error?.code || "PREVIEW_FAILED",
        error: error?.message || String(error),
        remote_status: Number(error?.status) || null,
        request_id: error?.requestId || null,
      });
    }
  }

  const expiresAt = new Date(Date.now() + env.MAGALU_WRITE_PREVIEW_TTL_SECONDS * 1000);
  const preview = await writeRepository.createPreview({
    accountId: account.id,
    dachTenantId: identity.dachTenantId,
    dachUserId: identity.dachUserId,
    resourceType: type,
    rows,
    expiresAt,
  });
  return {
    preview_id: preview.id,
    account_id: account.id,
    resource: type,
    expires_at: preview.expires_at,
    rows,
    summary: {
      total: rows.length,
      valid: rows.filter((row) => row.valid).length,
      changed: rows.filter((row) => row.valid && row.changed).length,
      noop: rows.filter((row) => row.valid && !row.changed).length,
      invalid: rows.filter((row) => !row.valid).length,
    },
  };
}

module.exports = { buildPreview, assertWriteReady, _test: { normalizeChanges, readRemote, disabledError, scopeError } };
