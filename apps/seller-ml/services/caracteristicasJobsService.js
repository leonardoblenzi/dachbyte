"use strict";

const Bull = require("bull");
const { makeBullClient, getSharedRedis } = require("../lib/redisClient");
const CaracteristicasService = require("./caracteristicasService");
const { attachJobReview } = require("./jobReviewHelper");
const { attachJobContract, backendJobIdFromUid } = require("./jobContract");
const { recordAuthEvent } = require("./authAuditService");
const { reserveCredits, settleCredits } = require("./hubCreditsService");

const QUEUE_NAME = "ml-caracteristicas";

function resolveJobId(value) {
  return backendJobIdFromUid("caracteristicas", value);
}
const TTL_SECONDS = Math.max(
  3600,
  Number(process.env.CARACTERISTICAS_JOB_TTL_SECONDS || 3 * 24 * 60 * 60),
);
const CHUNK_SIZE = Math.max(
  100,
  Number(process.env.CARACTERISTICAS_JOB_CHUNK_SIZE || 500),
);
const META_UPDATE_EVERY = Math.max(
  1,
  Number(process.env.CARACTERISTICAS_META_UPDATE_EVERY || 25),
);
const WORKER_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.CARACTERISTICAS_WORKER_CONCURRENCY || 4)),
);

let queueInstance = null;
let redisClient = null;
let workerStarted = false;

function getQueue() {
  if (!queueInstance) {
    queueInstance = new Bull(QUEUE_NAME, {
      createClient: (type) => makeBullClient(type, QUEUE_NAME),
    });
  }
  return queueInstance;
}

function getRedis() {
  if (!redisClient) redisClient = getSharedRedis("app");
  return redisClient;
}

function makeId() {
  return `job_caracteristicas_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function metaKey(jobId) {
  return `ml:caracteristicas:${jobId}:meta`;
}

function inputManifestKey(jobId) {
  return `ml:caracteristicas:${jobId}:input`;
}

function inputChunkKey(jobId, index) {
  return `ml:caracteristicas:${jobId}:input:${index}`;
}

function resultManifestKey(jobId) {
  return `ml:caracteristicas:${jobId}:results`;
}

function resultChunkKey(jobId, index) {
  return `ml:caracteristicas:${jobId}:results:${index}`;
}

function fileKey(jobId) {
  return `ml:caracteristicas:${jobId}:file`;
}

function normalizeAccountKey(value) {
  const text = String(value || "").trim();
  return text || null;
}

function canAccessJob(job, accountKey) {
  const wanted = normalizeAccountKey(accountKey);
  const current = normalizeAccountKey(job?.data?.accountKey);
  return Boolean(wanted && current && current !== "default" && wanted === current);
}

function clampProgress(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

async function readJson(key) {
  try {
    const raw = await getRedis().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeJson(key, value) {
  await getRedis().set(key, JSON.stringify(value), "EX", TTL_SECONDS);
}

async function updateMeta(jobId, values) {
  const current = (await readJson(metaKey(jobId))) || {};
  const merged = { ...current, ...values, updated_at: new Date().toISOString() };
  await writeJson(metaKey(jobId), merged);
  return merged;
}

async function writeChunkedRows(jobId, rows, manifestKey, chunkKeyFactory) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const chunks = [];
  for (let offset = 0; offset < safeRows.length; offset += CHUNK_SIZE) {
    const key = chunkKeyFactory(jobId, chunks.length);
    await writeJson(key, safeRows.slice(offset, offset + CHUNK_SIZE));
    chunks.push(key);
  }
  await writeJson(manifestKey(jobId), {
    __chunked: true,
    total: safeRows.length,
    chunk_size: CHUNK_SIZE,
    chunks,
  });
}

async function appendResultChunk(jobId, rows) {
  const safeRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!safeRows.length) return;
  const manifest = (await readJson(resultManifestKey(jobId))) || {
    __chunked: true,
    total: 0,
    chunk_size: CHUNK_SIZE,
    chunks: [],
  };
  const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
  const key = resultChunkKey(jobId, chunks.length);
  await writeJson(key, safeRows);
  await writeJson(resultManifestKey(jobId), {
    __chunked: true,
    total: Number(manifest.total || 0) + safeRows.length,
    chunk_size: CHUNK_SIZE,
    chunks: [...chunks, key],
  });
}

async function forEachChunk(manifestKeyValue, callback) {
  const manifest = await readJson(manifestKeyValue);
  if (!manifest?.__chunked || !Array.isArray(manifest.chunks)) return;
  for (const key of manifest.chunks) {
    const rows = await readJson(key);
    if (Array.isArray(rows) && rows.length) await callback(rows);
  }
}

async function processJob(job) {
  if (job?.data?.type === "export_workbook") {
    return processWorkbookExportJob(job);
  }

  const jobId = String(job.id);
  const { categoryId, dryRun, mlCreds } = job.data || {};
  const inputManifest = await readJson(inputManifestKey(jobId));
  const total = Math.max(0, Number(inputManifest?.total || 0));
  let processed = 0;
  let applied = 0;
  let skipped = 0;
  let errors = 0;
  let resultBuffer = [];
  const previewResults = [];
  let cancelRequested = false;

  await writeJson(resultManifestKey(jobId), {
    __chunked: true,
    total: 0,
    chunk_size: CHUNK_SIZE,
    chunks: [],
  });
  await updateMeta(jobId, {
    state: "processando",
    status: "processando",
    progress: 0,
    processed: 0,
    total,
    applied: 0,
    skipped: 0,
    errors: 0,
    completed: false,
    started_at: new Date().toISOString(),
  });
  await job.progress(0);
  await auditCaracteristicasEvent(job, "characteristics_job_started", "success", {
    total_items: total,
    category_id: categoryId || null,
    dry_run: Boolean(dryRun),
  });

  const state = await CaracteristicasService.prepareState(mlCreds || {});
  const categoryAttributes = await CaracteristicasService.fetchCategoryAttributes(
    state,
    categoryId,
  );

  await forEachChunk(inputManifestKey(jobId), async (rows) => {
    for (const row of rows) {
      if (processed % META_UPDATE_EVERY === 0) {
        const latestMeta = (await readJson(metaKey(jobId))) || {};
        cancelRequested = latestMeta.cancel_requested === true;
      }
      if (cancelRequested) {
        if (resultBuffer.length) await appendResultChunk(jobId, resultBuffer);
        await updateMeta(jobId, {
          state: "cancelado",
          status: "cancelado",
          progress: 100,
          processed,
          applied,
          skipped,
          errors,
          completed: true,
          cancel_requested: false,
          finished_at: new Date().toISOString(),
          preview_results: previewResults,
        });
        await job.progress(100);
        const error = new Error("JOB_CANCELLED");
        error.cancelled = true;
        throw error;
      }

      let result;
      const validationErrors = Array.isArray(row.validation_errors)
        ? row.validation_errors.filter(Boolean)
        : [];
      if (validationErrors.length) {
        result = {
          id: row.id,
          status: "error",
          reason: validationErrors.join(" | "),
          validation_error: true,
        };
      } else {
        try {
          result = await CaracteristicasService.applyRowValues(
            state,
            row.id,
            categoryId,
            categoryAttributes,
            Array.isArray(row.attributes) ? row.attributes : [],
            { dryRun: Boolean(dryRun) },
          );
        } catch (error) {
          result = {
            id: row.id,
            status: "error",
            reason: error?.message || "Erro inesperado na aplicacao.",
          };
        }
      }

      result = {
        ...result,
        id: row.id || result?.id || "",
        sku: row.sku || "",
        title: row.title || "",
        item_status: row.item_status || "",
        category_id: row.category_id || categoryId,
        permalink: row.permalink || "",
      };
      if (result.status === "skipped") result.status = "error";

      resultBuffer.push(result);
      if (previewResults.length < 100) previewResults.push(result);
      processed += 1;
      if (result.status === "applied") applied += 1;
      else if (result.status === "dry_run") skipped += 1;
      else if (result.status === "error") errors += 1;

      await auditCaracteristicasEvent(
        job,
        "characteristics_item_processed",
        result.status === "applied" || result.status === "dry_run"
          ? "success"
          : result.status === "skipped"
            ? "warn"
            : "error",
        {
          mlb_id: result.id || row.id || "",
          item_id: result.id || row.id || "",
          sku: result.sku || row.sku || "",
          title: result.title || row.title || "",
          item_index: processed,
          total_items: total,
          item_status: result.status,
          category_id: result.category_id || row.category_id || categoryId,
          dry_run: Boolean(dryRun),
          requested_attributes: result.submitted_attributes || row.attributes || [],
          applied_attributes:
            result.status === "applied" ? result.applied_attributes || result.submitted_attributes || [] : [],
          ml_body: result.response || result.details || null,
          message: safeText(result.reason || result.message || ""),
        },
      );

      if (resultBuffer.length >= CHUNK_SIZE) {
        await appendResultChunk(jobId, resultBuffer);
        resultBuffer = [];
      }

      if (processed === 1 || processed === total || processed % META_UPDATE_EVERY === 0) {
        const progress = total > 0 ? clampProgress((processed / total) * 100) : 100;
        await updateMeta(jobId, {
          state: `processando ${processed}/${total}`,
          status: "processando",
          progress,
          processed,
          total,
          applied,
          skipped,
          errors,
          preview_results: previewResults,
        });
        await job.progress(progress);
      }
    }
  });

  if (resultBuffer.length) await appendResultChunk(jobId, resultBuffer);
  const stateText = `concluido: ${applied} ok, ${errors} erros, ${skipped} ignorados`;
  await updateMeta(jobId, {
    state: stateText,
    status: "concluido",
    progress: 100,
    processed,
    total,
    applied,
    skipped,
    errors,
    completed: true,
    finished_at: new Date().toISOString(),
    preview_results: previewResults,
  });
  await job.progress(100);
  await auditCaracteristicasEvent(job, "characteristics_job_completed", errors > 0 ? "warn" : "success", {
    total_items: total,
    processed,
    applied,
    skipped,
    errors,
    category_id: categoryId || null,
    dry_run: Boolean(dryRun),
  });
  return { total, processed, applied, skipped, errors };
}

async function processWorkbookExportJob(job) {
  const jobId = String(job.id);
  const { categoryId, mode, mlCreds } = job.data || {};
  await updateMeta(jobId, {
    state: "gerando planilha",
    status: "processando",
    progress: 10,
    processed: 0,
    total: 1,
    completed: false,
    started_at: new Date().toISOString(),
  });
  await job.progress(10);

  const file = await CaracteristicasService.buildCategoryWorkbook(mlCreds || {}, {
    category_id: categoryId,
    mode,
  });

  await writeJson(fileKey(jobId), {
    filename: file.filename,
    content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer_base64: Buffer.from(file.buffer).toString("base64"),
  });

  await updateMeta(jobId, {
    state: "planilha pronta",
    status: "concluido",
    progress: 100,
    processed: 1,
    total: 1,
    applied: 1,
    skipped: 0,
    errors: 0,
    completed: true,
    file_ready: true,
    download_csv_url: `/api/caracteristicas/jobs/${encodeURIComponent(jobId)}/download.csv`,
    finished_at: new Date().toISOString(),
  });
  await job.progress(100);
  return { total: 1, processed: 1, file_ready: true };
}

async function mapJob(job) {
  if (!job) return null;
  const bullState = await job.getState().catch(() => "unknown");
  const meta = (await readJson(metaKey(job.id))) || {};
  const total = Number(meta.total ?? job.data?.total ?? 0);
  const processed = Number(meta.processed || 0);
  let status = String(meta.status || bullState || "aguardando");
  if (bullState === "waiting" || bullState === "delayed") status = "aguardando";
  if (bullState === "failed" && !meta.completed) status = "erro";
  const completed = Boolean(meta.completed) || ["completed", "failed"].includes(bullState);
  const state = meta.state || (status === "aguardando" ? "aguardando" : status);
  const isWorkbookExport = job.data?.type === "export_workbook" || meta.type === "export_workbook";
  const hasDownload = isWorkbookExport ? meta.file_ready === true : processed > 0;

  return attachJobContract(attachJobReview({
    id: String(job.id),
    title:
      meta.title ||
      `${job.data?.dryRun ? "Simular" : "Aplicar"} Caracteristicas - ${total} item(ns)`,
    state,
    status,
    progress: clampProgress(meta.progress ?? job._progress ?? 0),
    processed,
    total,
    applied: Number(meta.applied || 0),
    skipped: Number(meta.skipped || 0),
    errors: Number(meta.errors || 0),
    results: Array.isArray(meta.preview_results) ? meta.preview_results : [],
    created_at: meta.created_at || new Date(job.timestamp).toISOString(),
    updated_at: meta.updated_at || new Date(job.timestamp).toISOString(),
    completed,
    account: job.data?.accountKey || job.data?.accountLabel
      ? { key: job.data.accountKey || null, label: job.data.accountLabel || job.data.accountKey }
      : null,
  }, {
    basePath: "/api/caracteristicas/jobs",
    hasCsv: hasDownload,
    label: isWorkbookExport ? "Baixar XLSX" : null,
  }), { module: "caracteristicas", kind: isWorkbookExport ? "export_workbook" : "apply" });
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[,"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function safeText(value, max = 500) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function auditBase(job = {}) {
  const context = job?.data?.auditContext || {};
  return {
    userId: Number(context.userId) || null,
    email: context.email || null,
    ip: context.ip || null,
    userAgent: context.userAgent || null,
    accountKey: context.accountKey || job?.data?.accountKey || null,
    accountLabel: context.accountLabel || job?.data?.accountLabel || job?.data?.accountKey || null,
    meli_conta_id: context.meli_conta_id || job?.data?.mlCreds?.meli_conta_id || null,
    route: context.route || null,
    method: context.method || null,
  };
}

async function auditCaracteristicasEvent(job, evento, status, metadata = {}) {
  const base = auditBase(job);
  return recordAuthEvent({
    userId: base.userId,
    email: base.email,
    evento,
    status,
    ip: base.ip,
    userAgent: base.userAgent,
    metadata: {
      accountKey: base.accountKey,
      accountLabel: base.accountLabel,
      meli_conta_id: base.meli_conta_id,
      route: base.route,
      method: base.method,
      job_id: String(job?.id || ""),
      action: "apply_characteristics",
      ...metadata,
    },
  }).catch((err) => {
    console.error("[CaracteristicasJobsService] audit erro:", err?.message || err);
  });
}

class CaracteristicasJobsService {
  static async enqueueWorkbookExport({
    categoryId,
    mode = "filled",
    mlCreds = {},
    accountKey = null,
    accountLabel = null,
    auditContext = null,
  }) {
    const category = String(categoryId || "").trim().toUpperCase();
    if (!category) throw new Error("Categoria obrigatoria para exportar planilha.");
    const safeMode = String(mode || "filled").trim().toLowerCase() === "model" ? "model" : "filled";
    const id = makeId();
    const createdAt = new Date().toISOString();
    const title = `${safeMode === "model" ? "Gerar modelo" : "Exportar preenchido"} Caracteristicas - ${category}`;
    await writeJson(metaKey(id), {
      type: "export_workbook",
      title,
      state: "aguardando",
      status: "aguardando",
      progress: 0,
      total: 1,
      processed: 0,
      applied: 0,
      skipped: 0,
      errors: 0,
      completed: false,
      created_at: createdAt,
      updated_at: createdAt,
    });
    const job = await getQueue().add(
      {
        type: "export_workbook",
        categoryId: category,
        mode: safeMode,
        mlCreds,
        accountKey,
        accountLabel,
        total: 1,
      },
      { jobId: id, attempts: 1, removeOnComplete: 30, removeOnFail: false },
    );
    return mapJob(job);
  }

  static async enqueue({
    categoryId,
    rows = [],
    dryRun = false,
    mlCreds = {},
    accountKey = null,
    accountLabel = null,
  }) {
    const category = String(categoryId || "").trim().toUpperCase();
    const cleanRows = Array.isArray(rows)
      ? rows.map((row) => ({
          id: String(row?.id || "").trim().toUpperCase(),
          sku: String(row?.sku || "").trim(),
          title: String(row?.title || "").trim(),
          item_status: String(row?.item_status || "").trim(),
          category_id: String(row?.category_id || category).trim().toUpperCase(),
          permalink: String(row?.permalink || "").trim(),
          attributes: Array.isArray(row?.attributes) ? row.attributes : [],
          validation_errors: Array.isArray(row?.validation_errors)
            ? row.validation_errors.filter(Boolean)
            : [],
          validation_warnings: Array.isArray(row?.validation_warnings)
            ? row.validation_warnings.filter(Boolean)
            : [],
        })).filter((row) => row.id || row.validation_errors.length)
      : [];
    if (!category) throw new Error("Categoria obrigatoria para aplicar importacao.");
    if (!cleanRows.length) throw new Error("Nenhuma linha valida para aplicar.");

    const id = makeId();
    await writeChunkedRows(id, cleanRows, inputManifestKey, inputChunkKey);
    const createdAt = new Date().toISOString();
    await writeJson(metaKey(id), {
      title: `${dryRun ? "Simular" : "Aplicar"} Caracteristicas - ${cleanRows.length} item(ns)`,
      state: "aguardando",
      status: "aguardando",
      progress: 0,
      total: cleanRows.length,
      processed: 0,
      applied: 0,
      skipped: 0,
      errors: 0,
      completed: false,
      created_at: createdAt,
      updated_at: createdAt,
    });
    const creditReservation = await reserveCredits({
      mlCreds,
      operationKey: "characteristics.apply",
      units: cleanRows.length,
      idempotencyKey: `characteristics:${id}`,
    });
    let job;
    try {
      job = await getQueue().add(
        {
          categoryId: category,
          dryRun: Boolean(dryRun),
          mlCreds,
          accountKey,
          accountLabel,
          auditContext: auditContext && typeof auditContext === "object" ? auditContext : null,
          total: cleanRows.length,
          creditReservation,
        },
        { jobId: id, attempts: 1, removeOnComplete: 30, removeOnFail: false },
      );
    } catch (error) {
      await settleCredits(creditReservation, { release: true });
      throw error;
    }
    return mapJob(job);
  }

  static async listRecent(limit = 20, { accountKey = null } = {}) {
    const jobs = await getQueue().getJobs(
      ["active", "waiting", "delayed", "failed", "completed"],
      0,
      Math.max(0, Number(limit || 20) - 1),
      false,
    );
    const mapped = await Promise.all(
      jobs.filter((job) => canAccessJob(job, accountKey)).map(mapJob),
    );
    return mapped.filter(Boolean);
  }

  static async jobDetail(id, { accountKey = null } = {}) {
    const job = await getQueue().getJob(resolveJobId(id));
    if (!job || !canAccessJob(job, accountKey)) return null;
    return mapJob(job);
  }

  static async cancelJob(id, { accountKey = null } = {}) {
    const job = await getQueue().getJob(resolveJobId(id));
    if (!job || !canAccessJob(job, accountKey)) return null;
    const state = await job.getState().catch(() => "unknown");
    if (state === "completed" || state === "failed") {
      return { ok: false, status: state, error: "Job ja finalizado." };
    }
    if (state === "waiting" || state === "delayed") {
      await updateMeta(job.id, {
        state: "cancelado",
        status: "cancelado",
        progress: 100,
        completed: true,
        cancel_requested: false,
        finished_at: new Date().toISOString(),
      });
      await settleCredits(job?.data?.creditReservation, { release: true });
      await job.remove();
      return { ok: true, status: "cancelado" };
    }
    await updateMeta(job.id, {
      state: "cancelando",
      status: "cancelando",
      cancel_requested: true,
    });
    return { ok: true, status: "cancelando" };
  }

  static async getJobCsv(id, { accountKey = null } = {}) {
    const job = await getQueue().getJob(resolveJobId(id));
    if (!job || !canAccessJob(job, accountKey)) return null;
    const file = await readJson(fileKey(job.id));
    if (file?.buffer_base64) {
      return {
        filename: file.filename || `caracteristicas_${job.id}.xlsx`,
        contentType:
          file.content_type ||
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        type: "xlsx",
      };
    }
    if (job.data?.type === "export_workbook") {
      return {
        pending: true,
        filename: `caracteristicas_${job.id}.xlsx`,
      };
    }
    return { filename: `caracteristicas_${job.id}.csv` };
  }

  static async streamJobCsv(id, res) {
    const file = await readJson(fileKey(id));
    if (file?.buffer_base64) {
      res.write(Buffer.from(file.buffer_base64, "base64"));
      return;
    }
    res.write("\ufeffMLB,SKU,titulo,status,categoria,link,resultado,motivo,atributos_solicitados_json,atributos_aplicados_json\n");
    await forEachChunk(resultManifestKey(id), async (rows) => {
      const lines = rows.map((row) => [
        row?.id || "",
        row?.sku || "",
        row?.title || "",
        row?.item_status || "",
        row?.category_id || "",
        row?.permalink || "",
        ["applied", "dry_run"].includes(String(row?.status || "")) ? "sucesso" : "erro",
        row?.reason || row?.message || "",
        JSON.stringify(row?.submitted_attributes || []),
        JSON.stringify(row?.applied_attributes || []),
      ].map(csvCell).join(","));
      if (lines.length) res.write(`${lines.join("\n")}\n`);
    });
  }

  static initWorker() {
    const queue = getQueue();
    if (workerStarted) return queue;
    workerStarted = true;
    queue.process(WORKER_CONCURRENCY, async (job) => {
      try {
        return await processJob(job);
      } catch (error) {
        if (error?.cancelled) return { cancelled: true };
        const meta = (await readJson(metaKey(job.id))) || {};
        await updateMeta(job.id, {
          state: `erro: ${error?.message || error}`,
          status: "erro",
          progress: 100,
          errors: Number(meta.errors || 0) + Math.max(1, Number(meta.total || 0) - Number(meta.processed || 0)),
          completed: true,
          finished_at: new Date().toISOString(),
        });
        await auditCaracteristicasEvent(job, "characteristics_job_failed", "error", {
          total_items: Number(meta.total || 0),
          processed: Number(meta.processed || 0),
          applied: Number(meta.applied || 0),
          skipped: Number(meta.skipped || 0),
          errors: Number(meta.errors || 0),
          category_id: job?.data?.categoryId || null,
          dry_run: Boolean(job?.data?.dryRun),
          error: safeText(error?.message || String(error)),
        });
        await job.progress(100);
        throw error;
      }
    });
    queue.on("completed", async (job) => {
      await settleCredits(job?.data?.creditReservation, { release: false });
    });
    queue.on("failed", async (job) => {
      await settleCredits(job?.data?.creditReservation, { release: true });
    });
    console.log(`[CaracteristicasJobsService] worker iniciado (concurrency=${WORKER_CONCURRENCY})`);
    return queue;
  }
}

module.exports = CaracteristicasJobsService;
