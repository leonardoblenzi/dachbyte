"use strict";

const env = require("../config/env");
const accountRepository = require("../repositories/accountRepository");
const writeRepository = require("../repositories/writeRepository");
const { buildPreview, assertWriteReady } = require("../services/writePreviewService");
const { checkAccountAccess } = require("../services/hubResourceAccessService");
const { enqueueWriteOperation } = require("../queues/magaluQueue");
const { PRICE_WRITE_SCOPE, STOCK_WRITE_SCOPE, hasScope } = require("../services/writePayload");

function int(value, fallback = 0) {
  const parsed = Number.parseInt(String(value == null ? "" : value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function resolveAccount(req) {
  const accountId = int(req.query?.account_id || req.body?.account_id || req.params?.accountId, 0);
  if (accountId <= 0) {
    const error = new Error("Selecione uma conta Magalu.");
    error.code = "MAGALU_ACCOUNT_REQUIRED";
    error.status = 400;
    throw error;
  }
  const account = await accountRepository.findAccountByIdForTenant(accountId, req.magaluIdentity.dachTenantId);
  if (!account) {
    const error = new Error("Conta Magalu não encontrada para este tenant DACH.");
    error.code = "MAGALU_ACCOUNT_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  return account;
}

async function checkWriteAccess(identity, account) {
  return checkAccountAccess(identity, account, { force: true, action: "WRITE magalu" });
}

async function status(req, res, next) {
  try {
    const account = await resolveAccount(req);
    const scopes = Array.isArray(account.scopes) ? account.scopes : [];
    const operations = await writeRepository.listOperations(account.id, req.magaluIdentity.dachTenantId, int(req.query?.limit, 20));
    return res.json({
      ok: true,
      enabled: env.MAGALU_WRITE_ENABLED,
      account_id: account.id,
      scopes: {
        price: { required: PRICE_WRITE_SCOPE, available: hasScope(scopes, PRICE_WRITE_SCOPE) },
        stock: { required: STOCK_WRITE_SCOPE, available: hasScope(scopes, STOCK_WRITE_SCOPE) },
      },
      limits: {
        max_batch_size: env.MAGALU_WRITE_MAX_BATCH_SIZE,
        preview_ttl_seconds: env.MAGALU_WRITE_PREVIEW_TTL_SECONDS,
      },
      operations,
    });
  } catch (error) { return next(error); }
}

async function preview(req, res, next) {
  try {
    const account = await resolveAccount(req);
    const hub = await checkWriteAccess(req.magaluIdentity, account);
    if (!hub.allow) return res.status(403).json({ ok: false, error: "MAGALU_WRITE_HUB_ACCESS_DENIED", message: "O Hub não confirmou acesso para alteração no Magalu." });
    const result = await buildPreview({
      account,
      identity: req.magaluIdentity,
      resource: req.body?.resource,
      changes: req.body?.changes,
    });
    return res.json({ ok: true, ...result });
  } catch (error) { return next(error); }
}

async function apply(req, res, next) {
  try {
    const previewId = String(req.body?.preview_id || "").trim();
    if (!previewId) return res.status(400).json({ ok: false, error: "MAGALU_WRITE_PREVIEW_REQUIRED", message: "Informe preview_id." });

    const previewRecord = await writeRepository.getPreviewForIdentity(previewId, req.magaluIdentity);
    if (!previewRecord) return res.status(404).json({ ok: false, error: "MAGALU_WRITE_PREVIEW_NOT_FOUND" });
    const account = await accountRepository.findAccountByIdForTenant(previewRecord.account_id, req.magaluIdentity.dachTenantId);
    if (!account) return res.status(404).json({ ok: false, error: "MAGALU_ACCOUNT_NOT_FOUND" });
    assertWriteReady(account, previewRecord.resource_type);

    // O efeito colateral remoto exige confirmação fresca do Hub, sem cache.
    const hub = await checkWriteAccess(req.magaluIdentity, account);
    if (!hub.allow) return res.status(403).json({ ok: false, error: "MAGALU_WRITE_HUB_ACCESS_DENIED", message: "O Hub não confirmou acesso para alteração no Magalu." });

    const created = await writeRepository.createOperationsFromPreview(previewId, req.magaluIdentity);
    const results = [];
    for (const operation of created.operations) {
      if (operation.duplicate) {
        results.push({ id: operation.id, sku: operation.sku, status: operation.status, duplicate: true });
        continue;
      }
      try {
        const job = await enqueueWriteOperation(operation);
        results.push({ id: operation.id, sku: operation.sku, status: operation.status, job_id: job.id, duplicate: false });
      } catch (error) {
        await writeRepository.finishOperation(operation.id, {
          status: "failed",
          errorCode: "MAGALU_WRITE_QUEUE_FAILED",
          errorMessage: error?.message || String(error),
        });
        await writeRepository.appendAudit({
          accountId: operation.account_id,
          operationId: operation.id,
          dachTenantId: operation.dach_tenant_id,
          dachUserId: operation.dach_user_id,
          action: "WRITE_QUEUE_FAILED",
          resourceType: operation.resource_type,
          sku: operation.sku,
          details: { message: error?.message || String(error) },
        });
        results.push({ id: operation.id, sku: operation.sku, status: "failed", error: "MAGALU_WRITE_QUEUE_FAILED", duplicate: false });
      }
    }
    return res.status(202).json({ ok: true, preview_id: previewId, operations: results });
  } catch (error) { return next(error); }
}

async function reverify(req, res, next) {
  try {
    const operationId = int(req.params.operationId, 0);
    const operation = await writeRepository.getOperationForTenant(operationId, req.magaluIdentity.dachTenantId);
    if (!operation) return res.status(404).json({ ok: false, error: "MAGALU_WRITE_OPERATION_NOT_FOUND" });
    if (!["dispatching","accepted","divergent","uncertain"].includes(String(operation.status))) {
      return res.status(409).json({ ok: false, error: "MAGALU_WRITE_OPERATION_NOT_REVERIFIABLE", message: "Esta operação não está em um estado que exija reverificação." });
    }
    const account = await accountRepository.findAccountByIdForTenant(operation.account_id, req.magaluIdentity.dachTenantId);
    if (!account) return res.status(404).json({ ok: false, error: "MAGALU_ACCOUNT_NOT_FOUND" });
    // Reverificação é somente leitura. Ela continua permitida com a flag de
    // escrita desligada ou sem write scope para não apagar uma incerteza
    // remota sem antes reconciliar o estado efetivo do SKU.
    if (String(account.status || "") !== "active") {
      return res.status(409).json({ ok: false, error: "MAGALU_ACCOUNT_NOT_ACTIVE" });
    }
    const hub = await checkWriteAccess(req.magaluIdentity, account);
    if (!hub.allow) return res.status(403).json({ ok: false, error: "MAGALU_WRITE_HUB_ACCESS_DENIED", message: "O Hub não confirmou acesso para reverificar a alteração no Magalu." });
    const job = await enqueueWriteOperation(operation, { reason: "reverify" });
    await writeRepository.appendAudit({
      accountId: operation.account_id, operationId: operation.id, dachTenantId: operation.dach_tenant_id, dachUserId: req.magaluIdentity.dachUserId,
      action: "WRITE_REVERIFY_QUEUED", resourceType: operation.resource_type, sku: operation.sku, details: { previous_status: operation.status, job_id: job.id },
    });
    return res.status(202).json({ ok: true, operation_id: operation.id, status: operation.status, job_id: job.id, mode: "verification_only" });
  } catch (error) { return next(error); }
}

async function operations(req, res, next) {
  try {
    const account = await resolveAccount(req);
    const rows = await writeRepository.listOperations(account.id, req.magaluIdentity.dachTenantId, int(req.query?.limit, 50));
    return res.json({ ok: true, operations: rows });
  } catch (error) { return next(error); }
}

async function operation(req, res, next) {
  try {
    const row = await writeRepository.getOperationForTenant(int(req.params.operationId, 0), req.magaluIdentity.dachTenantId);
    if (!row) return res.status(404).json({ ok: false, error: "MAGALU_WRITE_OPERATION_NOT_FOUND" });
    return res.json({ ok: true, operation: row });
  } catch (error) { return next(error); }
}

module.exports = { status, preview, apply, reverify, operations, operation, _test: { int } };
