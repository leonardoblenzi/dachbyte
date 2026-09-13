"use strict";

const Bull = require("bull");
const { makeBullClient } = require("../lib/redisClient");
const db = require("../db/db");
const TokenService = require("./tokenService");
const { decryptToken } = require("./tokenCrypto");
const filtroQueue = require("./filtroAnunciosQueueService");
const AutomationReportService = require("./automationReportService");
const { sendAutomationReportEmail } = require("./automationReportEmailService");

const POLL_INTERVAL_MS = Math.max(5000, Number(process.env.REPORT_AUTOMATION_POLL_INTERVAL_MS || 15000));
const QUERY_TIMEOUT_MS = Math.max(5 * 60 * 1000, Number(process.env.REPORT_AUTOMATION_QUERY_TIMEOUT_MS || 45 * 60 * 1000));
const CSV_TIMEOUT_MS = Math.max(2 * 60 * 1000, Number(process.env.REPORT_AUTOMATION_CSV_TIMEOUT_MS || 30 * 60 * 1000));

let workerStarted = false;

const queue = new Bull("ml-report-automation-runs", {
  createClient: (type) => makeBullClient(type, "ml-report-automation-runs"),
  settings: {
    lockDuration: Math.max(60 * 1000, Number(process.env.REPORT_AUTOMATION_LOCK_DURATION_MS || 30 * 60 * 1000)),
    stalledInterval: Math.max(30 * 1000, Number(process.env.REPORT_AUTOMATION_STALLED_INTERVAL_MS || 2 * 60 * 1000)),
    maxStalledCount: 2,
  },
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(value) {
  return String(value || "").trim();
}

function defaultCsvFields(automation) {
  const fields = [
    "mlb",
    "item_id",
    "sku",
    "gtin",
    "title",
    "status",
    "date_created",
    "tipo",
    "envio",
    "stock_total",
    "current_price_cents",
    "sold_quantity_total",
    "sales_units",
    "sold_value_cents",
    "ultima_venda",
  ];

  if (automation?.enrichment === "category") {
    fields.push("category_id", "category_name", "category_path");
  }
  if (automation?.enrichment === "visits") {
    fields.push("visits");
  }
  if (automation?.enrichment === "ads") {
    fields.push("ads_in_campaign", "ads_status", "ads_clicks", "ads_impressions", "ads_spend_cents", "ads_revenue_cents", "ads_roas");
  }
  if (automation?.enrichment === "promos") {
    fields.push("promo_active", "promo_pct", "promo_name", "promo_status", "promo_base_price", "promo_current_price");
  }
  if (automation?.enrichment === "variations") {
    fields.push("variation_id", "variation_name", "variation_details");
  }

  return fields;
}

function buildMlCreds(account) {
  return {
    app_id:
      process.env.ML_APP_ID ||
      process.env.APP_ID ||
      process.env.CLIENT_ID ||
      process.env.MERCADOLIBRE_APP_ID ||
      null,
    client_secret:
      process.env.ML_CLIENT_SECRET ||
      process.env.CLIENT_SECRET ||
      process.env.MERCADOLIBRE_CLIENT_SECRET ||
      null,
    redirect_uri:
      process.env.ML_REDIRECT_URI ||
      process.env.REDIRECT_URI ||
      process.env.MERCADOLIBRE_REDIRECT_URI ||
      null,
    meli_conta_id: account.id,
    account_key: String(account.id),
    accountKey: String(account.id),
    meli_user_id: account.meli_user_id,
    site_id: account.site_id || "MLB",
    access_token: account.access_token ? decryptToken(account.access_token) : null,
    refresh_token: account.refresh_token ? decryptToken(account.refresh_token) : null,
    access_expires_at: account.access_expires_at || null,
    scope: account.scope || null,
  };
}

async function loadAccount(meliContaId) {
  const { rows } = await db.query(
    `select mc.id,
            mc.empresa_id,
            mc.apelido,
            mc.meli_user_id,
            mc.site_id,
            mt.access_token,
            mt.access_expires_at,
            mt.refresh_token,
            mt.scope
       from meli_contas mc
       join meli_tokens mt on mt.meli_conta_id = mc.id
      where mc.id = $1
      limit 1`,
    [meliContaId],
  );
  return rows[0] || null;
}

async function updateRun(runId, patch) {
  const allowed = {
    status: "status",
    started_at: "started_at",
    finished_at: "finished_at",
    query_job_id: "query_job_id",
    csv_job_id: "csv_job_id",
    csv_url: "csv_url",
    rows_count: "rows_count",
    email_result_json: "email_result_json",
    error_message: "error_message",
  };
  const sets = [];
  const params = [runId];
  for (const [key, column] of Object.entries(allowed)) {
    if (!(key in patch)) continue;
    params.push(
      key === "email_result_json"
        ? JSON.stringify(patch[key] || {})
        : patch[key],
    );
    sets.push(`${column} = $${params.length}${key === "email_result_json" ? "::jsonb" : ""}`);
  }
  if (!sets.length) return;
  await db.query(
    `update report_automation_runs
        set ${sets.join(", ")},
            updated_at = now()
      where id = $1`,
    params,
  );
}

async function updateAutomationAfterRun({ automationId, status, error = null }) {
  await db.query(
    `update report_automations
        set last_run_at = now(),
            last_status = $2,
            last_error = $3,
            updated_at = now()
      where id = $1`,
    [automationId, status, error ? String(error).slice(0, 1000) : null],
  );
}

async function loadRun(runId) {
  const { rows } = await db.query(
    `select *
       from report_automation_runs
      where id = $1
      limit 1`,
    [runId],
  );
  return AutomationReportService.mapRun(rows[0]);
}

async function waitForFiltroJob(jobId, { currentContaId, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await filtroQueue.getStatus(jobId, { currentContaId });
    if (!status) throw new Error("Job de relatorio nao encontrado.");
    if (status.status === "concluido") return status;
    if (status.status === "erro" || status.status === "failed" || status.status === "falhou") {
      throw new Error(status.error || "Job de relatorio falhou.");
    }
    if (status.status === "cancelado") {
      throw new Error("Job de relatorio foi cancelado.");
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Timeout aguardando conclusao do relatorio.");
}

async function processRun(runId) {
  const run = await loadRun(runId);
  if (!run) throw new Error("Execucao de automacao nao encontrada.");

  const automation = await AutomationReportService.getAutomation({
    id: run.automation_id,
    empresaId: run.empresa_id,
  });
  if (!automation) throw new Error("Automacao nao encontrada.");

  const account = await loadAccount(run.meli_conta_id);
  if (!account) throw new Error("Conta Mercado Livre sem token OAuth.");

  const mlCreds = buildMlCreds(account);
  const token = await TokenService.renovarTokenSeNecessario(mlCreds);
  const filters = AutomationReportService.buildFiltroFilters(automation);
  const accountLabel = automation.account_label || account.apelido || account.meli_user_id || String(account.id);

  await updateRun(runId, { status: "running", started_at: new Date() });
  filtroQueue.initWorker?.();
  const queryJobId = await filtroQueue.enqueue({
    token,
    mlCreds,
    filters,
    account: {
      meli_conta_id: account.id,
      label: accountLabel,
    },
    cancelOpenJobs: false,
  });
  await updateRun(runId, { query_job_id: String(queryJobId) });

  const queryStatus = await waitForFiltroJob(queryJobId, {
    currentContaId: Number(account.id),
    timeoutMs: QUERY_TIMEOUT_MS,
  });

  const rowsCount = Number(queryStatus.result_total ?? queryStatus.total ?? 0);
  await updateRun(runId, { status: "generating_csv", rows_count: Number.isFinite(rowsCount) ? rowsCount : null });

  const csvJobId = await filtroQueue.enqueueCsvExport({
    sourceJobId: queryJobId,
    token,
    mlCreds,
    account: {
      meli_conta_id: account.id,
      label: accountLabel,
    },
    fields: defaultCsvFields(automation),
    sourceMeta: await filtroQueue.getMeta(queryJobId),
    filename: `${normalize(automation.name).replace(/[^a-z0-9_-]+/gi, "_") || "relatorio"}_${queryJobId}.csv`,
  });
  filtroQueue.initWorker?.();
  await updateRun(runId, { csv_job_id: String(csvJobId) });

  const csvStatus = await waitForFiltroJob(csvJobId, {
    currentContaId: Number(account.id),
    timeoutMs: CSV_TIMEOUT_MS,
  });
  const csvUrl = csvStatus.download_csv_url || `/api/analytics/filtro-anuncios/jobs/${encodeURIComponent(String(csvJobId))}/download.csv`;

  await updateRun(runId, { status: "sending_email", csv_url: csvUrl });
  const freshRun = await loadRun(runId);
  const emailResult = await sendAutomationReportEmail({
    automation,
    run: freshRun || { rows_count: rowsCount },
    recipients: automation.recipients,
    csvUrl,
  });

  const finalStatus = emailResult?.sent ? "sent" : emailResult?.skipped ? "skipped" : "failed";
  await updateRun(runId, {
    status: finalStatus,
    finished_at: new Date(),
    email_result_json: emailResult,
    error_message: finalStatus === "failed" ? "Email nao enviado." : null,
  });
  await updateAutomationAfterRun({ automationId: automation.id, status: finalStatus });

  return { ok: true, run_id: runId, status: finalStatus, csv_url: csvUrl };
}

async function enqueueRun(runId) {
  const job = await queue.add(
    "send_report",
    { runId: Number(runId) },
    { attempts: 1, removeOnComplete: 50, removeOnFail: 50 },
  );
  return String(job.id);
}

function initWorker() {
  if (workerStarted) return queue;
  workerStarted = true;
  queue.process("send_report", Math.max(1, Math.min(2, Number(process.env.REPORT_AUTOMATION_CONCURRENCY || 1))), async (job) => {
    const runId = Number(job.data?.runId);
    if (!Number.isFinite(runId) || runId <= 0) throw new Error("runId invalido.");
    try {
      return await processRun(runId);
    } catch (error) {
      await updateRun(runId, {
        status: "failed",
        finished_at: new Date(),
        error_message: error?.message || String(error),
      }).catch(() => null);

      const run = await loadRun(runId).catch(() => null);
      if (run?.automation_id) {
        await updateAutomationAfterRun({
          automationId: run.automation_id,
          status: "failed",
          error: error?.message || String(error),
        }).catch(() => null);
      }
      throw error;
    }
  });
  console.log("[ReportAutomation] worker iniciado.");
  return queue;
}

module.exports = {
  enqueueRun,
  initWorker,
  processRun,
};
