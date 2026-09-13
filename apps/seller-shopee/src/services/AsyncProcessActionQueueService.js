"use strict";

const crypto = require("crypto");
const { asyncProcessActionQueue } = require("../config/queue");
const { findShopForAccountById } = require("../repositories/runtimeSqlRepository");
const {
  reserveShopCredits,
  settleShopCredits,
} = require("./hubResourceBillingService");
const {
  estimateShopeeOperationCredits,
  operationKeyForAsyncAction,
} = require("./shopeeCreditCosts");
const { isMasterAdminAuth } = require("../config/masterAdmin");

const ALLOWED_ACTIONS = new Set([
  "logistics.spx.enable",
  "logistics.spx.disable",
  "logistics.seller.enable",
  "logistics.seller.disable",
  "logistics.conflicts.keep_spx",
  "logistics.conflicts.keep_seller",
  "logistics.mapping.apply",
  "logistics.configure",
  "products.deadline.apply",
  "products.relaunch.pause",
  "products.relaunch.delete",
  "products.status.bulk",
]);

function normalizeAction(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function buildUniqueJobId(action, auth = {}) {
  const rand = crypto.randomBytes(6).toString("hex");
  const safeAction = String(action || "unknown").replace(/[^a-z0-9_.-]/gi, "_");
  const accountId =
    auth?.accountId == null ? "na" : String(Number(auth.accountId) || "na");
  const activeShopId =
    auth?.activeShopId == null
      ? "na"
      : String(Number(auth.activeShopId) || "na");
  return `async_${safeAction}_${accountId}_${activeShopId}_${Date.now()}_${rand}`;
}

function sanitizePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return payload;
}

function buildAuthSnapshot(auth) {
  return {
    userId: auth?.userId == null ? null : Number(auth.userId),
    email: auth?.email ? String(auth.email) : null,
    role: auth?.role ? String(auth.role) : null,
    accountId: auth?.accountId == null ? null : Number(auth.accountId),
    accountName: auth?.accountName ? String(auth.accountName) : null,
    tenantGlobalId: auth?.tenantGlobalId ? String(auth.tenantGlobalId) : null,
    activeShopId:
      auth?.activeShopId == null ? null : Number(auth.activeShopId),
  };
}

function userCanReadJob(auth, jobData = {}) {
  if (isMasterAdminAuth(auth)) return true;
  const snapshot = jobData?.auth && typeof jobData.auth === "object" ? jobData.auth : {};
  const authAccountId = auth?.accountId == null ? null : Number(auth.accountId);
  const jobAccountId =
    snapshot?.accountId == null ? null : Number(snapshot.accountId);
  if (authAccountId != null && jobAccountId != null && authAccountId === jobAccountId) {
    return true;
  }
  const authUserId = auth?.userId == null ? null : Number(auth.userId);
  const jobUserId = snapshot?.userId == null ? null : Number(snapshot.userId);
  if (authUserId != null && jobUserId != null && authUserId === jobUserId) {
    return true;
  }
  return false;
}

function mapJobState(job, state) {
  const returnValue =
    job?.returnvalue && typeof job.returnvalue === "object"
      ? job.returnvalue
      : null;
  const failedReason = job?.failedReason
    ? String(job.failedReason)
    : null;
  const status =
    state === "completed"
      ? "completed"
      : state === "failed"
        ? "failed"
        : state === "active"
          ? "active"
          : state === "delayed"
            ? "delayed"
            : "waiting";

  return {
    jobId: String(job?.id || ""),
    name: String(job?.name || ""),
    status,
    state,
    action: String(job?.data?.action || ""),
    progress: job?.progress ?? null,
    requestedAt: job?.timestamp ? new Date(job.timestamp).toISOString() : null,
    processedAt: job?.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedAt: job?.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    failedReason,
    result: returnValue,
  };
}

async function enqueueAsyncProcessAction({ action, payload, auth }) {
  const normalizedAction = normalizeAction(action);
  if (!ALLOWED_ACTIONS.has(normalizedAction)) {
    const error = new Error(`Ação não suportada: ${normalizedAction || "-"}`);
    error.statusCode = 400;
    error.code = "action_invalid";
    throw error;
  }

  const authSnapshot = buildAuthSnapshot(auth);
  if (!Number.isFinite(Number(authSnapshot.accountId))) {
    const error = new Error("Conta ativa não encontrada para enfileirar processo.");
    error.statusCode = 400;
    error.code = "account_required";
    throw error;
  }
  if (!Number.isFinite(Number(authSnapshot.activeShopId))) {
    const error = new Error("Loja ativa não selecionada para enfileirar processo.");
    error.statusCode = 400;
    error.code = "active_shop_required";
    throw error;
  }

  const jobId = buildUniqueJobId(normalizedAction, authSnapshot);
  let creditReservation = null;
  const creditOperationKey = operationKeyForAsyncAction(normalizedAction);
  if (creditOperationKey) {
    const shop = await findShopForAccountById(authSnapshot.activeShopId, authSnapshot.accountId);
    if (shop) {
      const credits = estimateShopeeOperationCredits(creditOperationKey, sanitizePayload(payload));
      creditReservation = await reserveShopCredits({
        auth: authSnapshot,
        shop,
        operationKey: creditOperationKey,
        credits,
        idempotencyKey: `shopee:${creditOperationKey}:${jobId}`,
        metadata: {
          async_action: normalizedAction,
          job_id: jobId,
        },
      });
    }
  }

  await asyncProcessActionQueue.resume();
  const job = await asyncProcessActionQueue.add(
    "run",
    {
      action: normalizedAction,
      payload: sanitizePayload(payload),
      auth: authSnapshot,
      creditReservation,
      requestedAt: new Date().toISOString(),
    },
    {
      jobId,
      attempts: 1,
      removeOnComplete: 500,
      removeOnFail: 1000,
    },
  );

  return {
    ok: true,
    jobId: String(job?.id || jobId),
    action: normalizedAction,
    queueName: asyncProcessActionQueue.name,
    status: "queued",
    creditReservation: creditReservation
      ? {
          bypass: Boolean(creditReservation.bypass),
          reserved_credits: Number(creditReservation.reserved_credits || 0),
          reason: creditReservation.reason || null,
        }
      : null,
  };
}

async function getAsyncProcessActionStatus({ jobId, auth }) {
  const normalizedJobId = String(jobId || "").trim();
  if (!normalizedJobId) {
    const error = new Error("jobId inválido.");
    error.statusCode = 400;
    throw error;
  }

  const job = await asyncProcessActionQueue.getJob(normalizedJobId);
  if (!job) {
    const error = new Error("Job não encontrado.");
    error.statusCode = 404;
    error.code = "job_not_found";
    throw error;
  }

  if (!userCanReadJob(auth, job.data || {})) {
    const error = new Error("Sem permissão para consultar este job.");
    error.statusCode = 403;
    error.code = "forbidden";
    throw error;
  }

  const state = await job.getState();
  return mapJobState(job, state);
}

async function cancelAsyncProcessAction({ jobId, auth }) {
  const normalizedJobId = String(jobId || "").trim();
  if (!normalizedJobId) {
    const error = new Error("jobId inválido.");
    error.statusCode = 400;
    throw error;
  }

  const job = await asyncProcessActionQueue.getJob(normalizedJobId);
  if (!job) {
    const error = new Error("Job não encontrado.");
    error.statusCode = 404;
    error.code = "job_not_found";
    throw error;
  }

  if (!userCanReadJob(auth, job.data || {})) {
    const error = new Error("Sem permissão para cancelar este job.");
    error.statusCode = 403;
    error.code = "forbidden";
    throw error;
  }

  const state = String((await job.getState()) || "").toLowerCase();
  if (!["waiting", "delayed", "paused"].includes(state)) {
    return {
      ok: true,
      jobId: normalizedJobId,
      cancelled: false,
      state,
      message: "Job não está em estado cancelável.",
    };
  }

  if (job.data?.creditReservation) {
    await settleShopCredits(job.data.creditReservation, { release: true }).catch(() => {});
  }

  await job.remove();
  return {
    ok: true,
    jobId: normalizedJobId,
    cancelled: true,
    state,
    message: "Job removido da fila.",
  };
}

module.exports = {
  enqueueAsyncProcessAction,
  getAsyncProcessActionStatus,
  cancelAsyncProcessAction,
  __test: { allowedActions: ALLOWED_ACTIONS },
};
