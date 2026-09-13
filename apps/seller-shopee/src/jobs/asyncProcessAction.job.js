"use strict";

const LogisticsController = require("../controllers/LogisticsController");
const ProductsController = require("../controllers/ProductsController");
const {
  insertProcessExecutionLog,
} = require("../repositories/processExecutionSqlRepository");
const { settleShopCredits } = require("../services/hubResourceBillingService");

const ACTION_HANDLERS = {
  "logistics.spx.enable": {
    controller: LogisticsController.enableSpx,
    path: "/jobs/logistics/spx/enable",
  },
  "logistics.spx.disable": {
    controller: LogisticsController.disableSpx,
    path: "/jobs/logistics/spx/disable",
  },
  "logistics.seller.enable": {
    controller: LogisticsController.enableSellerLogistics,
    path: "/jobs/logistics/seller/enable",
  },
  "logistics.seller.disable": {
    controller: LogisticsController.disableSellerLogistics,
    path: "/jobs/logistics/seller/disable",
  },
  "logistics.conflicts.keep_spx": {
    controller: LogisticsController.resolveConflictsKeepSpx,
    path: "/jobs/logistics/conflicts/keep-spx",
  },
  "logistics.conflicts.keep_seller": {
    controller: LogisticsController.resolveConflictsKeepSeller,
    path: "/jobs/logistics/conflicts/keep-seller",
  },
  "logistics.mapping.apply": {
    controller: LogisticsController.applyAutomaticMapping,
    path: "/jobs/logistics/mapping/apply",
  },
  "logistics.configure": {
    controller: LogisticsController.configure,
    path: "/jobs/logistics/configure",
  },
  "products.deadline.apply": {
    controller: ProductsController.deadlineControlApply,
    path: "/jobs/products/deadline-control/apply",
  },
  "products.relaunch.pause": {
    controller: ProductsController.relaunchPause,
    path: "/jobs/products/relaunch/pause",
  },
  "products.relaunch.delete": {
    controller: ProductsController.relaunchDelete,
    path: "/jobs/products/relaunch/delete",
  },
  "products.status.bulk": {
    controller: ProductsController.bulkListingStatus,
    path: "/jobs/products/status/bulk",
  },
};

function buildMockReq(data = {}) {
  const auth = data.auth && typeof data.auth === "object" ? data.auth : {};
  return {
    method: "JOB",
    originalUrl: data.path || "/jobs/async-process-action",
    path: data.path || "/jobs/async-process-action",
    headers: {
      "user-agent": "bullmq/asyncProcessActionWorker",
    },
    ip: "queue_worker",
    socket: {
      remoteAddress: "queue_worker",
    },
    auth: {
      userId: auth.userId == null ? null : Number(auth.userId),
      email: auth.email ? String(auth.email) : null,
      role: auth.role ? String(auth.role) : null,
      accountId: auth.accountId == null ? null : Number(auth.accountId),
      activeShopId:
        auth.activeShopId == null ? null : Number(auth.activeShopId),
      sid: null,
    },
    params: data.params && typeof data.params === "object" ? data.params : {},
    query: data.query && typeof data.query === "object" ? data.query : {},
    body: data.body && typeof data.body === "object" ? data.body : {},
  };
}

function runControllerAction(controller, req) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = Number(code) || 200;
        return this;
      },
      json(payload) {
        if (!resolved) {
          resolved = true;
          resolve({
            statusCode: Number(this.statusCode || 200),
            payload,
          });
        }
        return this;
      },
      send(payload) {
        if (!resolved) {
          resolved = true;
          resolve({
            statusCode: Number(this.statusCode || 200),
            payload,
          });
        }
        return this;
      },
    };

    Promise.resolve(controller(req, res, reject))
      .then(() => {
        if (!resolved) {
          resolved = true;
          resolve({
            statusCode: Number(res.statusCode || 200),
            payload: null,
          });
        }
      })
      .catch(reject);
  });
}

function toErrorPayload(error) {
  const message = String(
    error?.message || error?.shopee?.message || "Falha ao executar processo.",
  );
  const code = String(error?.code || error?.shopee?.error || "process_failed");
  return {
    error: code,
    message,
  };
}

async function persistProcessExecution({
  requestedAt,
  finishedAt,
  durationMs,
  action,
  path,
  auth,
  statusCode,
  success,
  errorCode,
  errorMessage,
  requestBody,
  responseBody,
  jobId,
}) {
  await insertProcessExecutionLog({
    requestedAt,
    finishedAt,
    durationMs,
    method: "JOB",
    path: `${path || "/jobs/async-process-action"}#${String(action || "unknown")}`,
    queryString: jobId ? `jobId=${encodeURIComponent(String(jobId))}` : null,
    statusCode,
    success,
    errorCode: errorCode || null,
    errorMessage: errorMessage || null,
    requestBody: requestBody || null,
    responseBody: responseBody || null,
    ip: "queue_worker",
    userAgent: "bullmq/asyncProcessActionWorker",
    userId: auth?.userId == null ? null : Number(auth.userId),
    userEmail: auth?.email ? String(auth.email) : null,
    userRole: auth?.role ? String(auth.role) : null,
    accountId: auth?.accountId == null ? null : Number(auth.accountId),
  });
}

async function processAsyncActionJob(job) {
  const startedAt = new Date();
  const data = job?.data && typeof job.data === "object" ? job.data : {};
  const action = String(data.action || "").trim();
  const handler = ACTION_HANDLERS[action];
  const auth = data.auth && typeof data.auth === "object" ? data.auth : {};
  const creditReservation =
    data.creditReservation && typeof data.creditReservation === "object"
      ? data.creditReservation
      : null;
  let creditReservationSettled = false;
  const requestBody =
    data.payload && typeof data.payload === "object" ? data.payload : {};

  if (!handler || typeof handler.controller !== "function") {
    const finishedAt = new Date();
    const errorPayload = {
      error: "action_invalid",
      message: `Ação inválida para job assíncrono: ${action || "-"}.`,
    };
    await persistProcessExecution({
      requestedAt: startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      action,
      path: "/jobs/async-process-action",
      auth,
      statusCode: 400,
      success: false,
      errorCode: errorPayload.error,
      errorMessage: errorPayload.message,
      requestBody,
      responseBody: errorPayload,
      jobId: job?.id,
    });
    throw new Error(errorPayload.message);
  }

  await job.updateProgress({
    phase: "running",
    action,
    startedAt: startedAt.toISOString(),
  });

  try {
    const req = buildMockReq({
      auth,
      body: requestBody,
      path: handler.path,
    });
    const response = await runControllerAction(handler.controller, req);
    const statusCode = Number(response?.statusCode || 200);
    const success = statusCode >= 200 && statusCode < 400;
    const finishedAt = new Date();
    const responseBody = {
      ...(response?.payload && typeof response.payload === "object"
        ? response.payload
        : { payload: response?.payload ?? null }),
      _job: {
        id: String(job?.id || ""),
        action,
      },
    };

    await persistProcessExecution({
      requestedAt: startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      action,
      path: handler.path,
      auth,
      statusCode,
      success,
      errorCode: success
        ? null
        : String(responseBody?.error || "job_failed"),
      errorMessage: success
        ? null
        : String(responseBody?.message || "Falha no processamento do job."),
      requestBody,
      responseBody,
      jobId: job?.id,
    });

    await job.updateProgress({
      phase: success ? "completed" : "failed",
      action,
      finishedAt: finishedAt.toISOString(),
      statusCode,
    });

    if (!success) {
      if (creditReservation) {
        await settleShopCredits(creditReservation, { release: true });
        creditReservationSettled = true;
      }
      throw new Error(
        String(responseBody?.message || "Processo finalizado com falha."),
      );
    }

    if (creditReservation) {
      await settleShopCredits(creditReservation, { release: false });
      creditReservationSettled = true;
    }

    return {
      ok: true,
      action,
      statusCode,
      result: responseBody,
    };
  } catch (error) {
    const finishedAt = new Date();
    const errorPayload = toErrorPayload(error);
    await persistProcessExecution({
      requestedAt: startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      action,
      path: handler.path,
      auth,
      statusCode: Number(error?.statusCode || 500),
      success: false,
      errorCode: errorPayload.error,
      errorMessage: errorPayload.message,
      requestBody,
      responseBody: {
        ...errorPayload,
        _job: {
          id: String(job?.id || ""),
          action,
        },
      },
      jobId: job?.id,
    });
    if (creditReservation && !creditReservationSettled) {
      await settleShopCredits(creditReservation, { release: true });
    }
    throw error;
  }
}

processAsyncActionJob.__test = { actionHandlers: ACTION_HANDLERS };
module.exports = processAsyncActionJob;
