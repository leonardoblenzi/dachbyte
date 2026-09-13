const {
  parseRangeDays,
} = require("../services/OrderSyncService");
const { findShopForAccountById } = require("../repositories/runtimeSqlRepository");
const { orderSyncQueue } = require("../config/queue");
const crypto = require("crypto");

function buildManualSyncJobId(shopId) {
  return "orderSync:manual:" + Number(shopId) + ":" + Date.now() + ":" + crypto.randomBytes(5).toString("hex");
}

function mapJobState(job, state) {
  const normalizedState = String(state || "waiting").toLowerCase();
  return {
    ok: true,
    jobId: String(job?.id || ""),
    status: normalizedState === "completed" ? "completed" : normalizedState === "failed" ? "failed" : normalizedState === "active" ? "active" : "queued",
    state: normalizedState,
    result: job?.returnvalue || null,
    failedReason: job?.failedReason ? String(job.failedReason) : null,
  };
}

async function sync(req, res, next) {
  try {
    if (!req.auth) {
      return res
        .status(401)
        .json({ error: "unauthorized", message: "Não autenticado." });
    }

    const shopDbId = req.auth.activeShopId || null;
    if (!shopDbId) {
      return res.status(409).json({
        error: "select_shop_required",
        message: "Selecione uma loja para continuar.",
      });
    }

    const shop = await findShopForAccountById(shopDbId, req.auth.accountId);

    if (!shop) {
      return res.status(404).json({ error: "shop_not_found" });
    }

    const rangeDays = parseRangeDays(req.query.rangeDays);

    // Consultar pedido, pacote e renda por meses pode exceder o timeout do proxy.
    await orderSyncQueue.resume();
    const jobId = buildManualSyncJobId(shop.id);
    const job = await orderSyncQueue.add(
      "sync_shop",
      {
        shopId: shop.id,
        rangeDays,
        accountId: Number(req.auth.accountId),
        requestedByUserId: Number(req.auth.userId),
        origin: "manual",
      },
      { jobId, attempts: 1, removeOnComplete: 500, removeOnFail: 1000 },
    );

    return res.status(202).json({
      ok: true,
      status: "queued",
      jobId: String(job?.id || jobId),
      rangeDays,
    });
  } catch (e) {
    return next(e);
  }
}

async function status(req, res, next) {
  try {
    const jobId = String(req.params.jobId || "").trim();
    const job = await orderSyncQueue.getJob(jobId);
    if (!job) return res.status(404).json({ error: "sync_job_not_found" });

    const jobAccountId = Number(job.data?.accountId);
    if (!Number.isFinite(jobAccountId) || jobAccountId !== Number(req.auth?.accountId)) {
      return res.status(403).json({ error: "forbidden" });
    }

    return res.json(mapJobState(job, await job.getState()));
  } catch (e) {
    return next(e);
  }
}

module.exports = { sync, status };
