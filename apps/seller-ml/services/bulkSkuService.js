"use strict";

const { variationName, gtinValues, sellerSku } = require("./bulkSkuPreviewService");
const { itemsBulkPath, normalizeBulkResponse } = require("./meliBulk");
const { targetKey, classifyRows } = require("./bulkSkuPreviewService");
const { exportWorkbook, parseWorkbook, MAX_ROWS } = require("./bulkSkuWorkbookService");
const crypto = require("node:crypto");
const mlApi = require("./anuncioCadastro/mercadoLivreApi");

function assertAccount(ctx) {
  if (!ctx?.accountKey || !ctx?.sellerId || !ctx?.accessToken) {
    throw Object.assign(new Error("Conta Mercado Livre ativa nao identificada."), { status: 409 });
  }
}

function rowsFromItem(item, accountLabel) {
  const variations = Array.isArray(item?.variations) ? item.variations : [];
  const base = { conta: String(accountLabel || ""), mlb: String(item?.id || "") };
  if (!variations.length) return [{
    ...base, id_variacao: "", nome_variacao: "Produto único",
    ean_gtin_atual: gtinValues(item?.attributes).join(", "),
    sku_atual: sellerSku(item?.attributes, item?.seller_custom_field), sku_novo: "",
  }];
  return variations.map((variation) => ({
    ...base, id_variacao: String(variation.id), nome_variacao: variationName(variation.attribute_combinations),
    ean_gtin_atual: gtinValues(variation.attributes).join(", "),
    sku_atual: sellerSku(variation.attributes, variation.seller_custom_field), sku_novo: "",
  }));
}

function replaceSku(attributes, sku) {
  const rows = Array.isArray(attributes) ? attributes : [];
  const kept = rows.filter((attribute) => String(attribute?.id || "").toUpperCase() !== "SELLER_SKU")
    .map((attribute) => ({ ...attribute }));
  return [...kept, { id: "SELLER_SKU", value_name: String(sku) }];
}

function planSkuPayload(item, changes, sellerId) {
  if (Number(item?.seller_id) !== Number(sellerId)) throw Object.assign(new Error("Anuncio de outra conta no lote."), { status: 403 });
  const variations = Array.isArray(item?.variations) ? item.variations : [];
  const readyRows = [];
  const staleRows = [];
  const missingRows = [];
  const alreadyRows = [];
  const updateByVariation = new Map();
  for (const row of changes) {
    const variationId = String(row.variation_id || "");
    const target = variationId ? variations.find((variation) => String(variation.id) === variationId) : (!variations.length ? item : null);
    if (!target) { missingRows.push(row); continue; }
    const currentSku = sellerSku(target.attributes, target.seller_custom_field);
    if (currentSku === String(row.new_sku)) { alreadyRows.push(row); continue; }
    if (currentSku !== String(row.old_sku)) { staleRows.push(row); continue; }
    readyRows.push(row);
    updateByVariation.set(variationId, row);
  }
  let body = null;
  if (readyRows.length) {
    body = variations.length
      ? { variations: variations.map((variation) => {
        const row = updateByVariation.get(String(variation.id));
        return row ? { id: variation.id, attributes: replaceSku(variation.attributes, row.new_sku) } : { id: variation.id };
      }) }
      : { attributes: [{ id: "SELLER_SKU", value_name: readyRows[0].new_sku }] };
  }
  return { body, readyRows, staleRows, missingRows, alreadyRows };
}

function readSkuAt(item, variationId) {
  const id = String(variationId || "");
  const target = id ? (item.variations || []).find((variation) => String(variation.id) === id) : item;
  return target ? sellerSku(target.attributes, target.seller_custom_field) : null;
}

async function applyGroup(mlb, changes, ctx, ml = mlApi) {
  const current = await ml.get(`/items/${encodeURIComponent(mlb)}`, { accessToken: ctx.accessToken });
  const plan = planSkuPayload(current, changes, ctx.sellerId);
  const results = new Map();
  for (const row of plan.staleRows) results.set(row.row_number, { row_number: row.row_number, state: "stale", message: "SKU atual mudou no ML." });
  for (const row of plan.missingRows) results.set(row.row_number, { row_number: row.row_number, state: "missing", message: "Variacao nao encontrada." });
  for (const row of plan.alreadyRows) results.set(row.row_number, { row_number: row.row_number, state: "unchanged", message: "SKU ja estava atualizado." });
  if (plan.body) {
    let writeError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await ml.request(`/items/${encodeURIComponent(mlb)}`, { accessToken: ctx.accessToken, method: "PUT", body: plan.body });
        writeError = null;
        break;
      } catch (error) {
        writeError = error;
        const status = Number(error?.status || error?.statusCode || 0);
        if (![429, 500, 502, 503, 504].includes(status) || attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    if (writeError) {
      for (const row of plan.readyRows) results.set(row.row_number, { row_number: row.row_number, state: "error", message: String(writeError.message || "Falha no ML").slice(0, 500) });
    } else {
      let verified = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        verified = await ml.get(`/items/${encodeURIComponent(mlb)}`, { accessToken: ctx.accessToken });
        if (plan.readyRows.every((row) => readSkuAt(verified, row.variation_id) === row.new_sku)) break;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
      }
      for (const row of plan.readyRows) {
        const applied = readSkuAt(verified, row.variation_id) === row.new_sku;
        results.set(row.row_number, { row_number: row.row_number, state: applied ? "applied" : "unverified", message: applied ? "SKU confirmado no ML." : "Envio aceito; confira a atualizacao no ML." });
      }
    }
  }
  return changes.map((row) => results.get(row.row_number));
}

async function loadLiveItems(ctx, ml, ids) {
  assertAccount(ctx);
  const items = [];
  const uniqueIds = [...new Set(ids.map((id) => String(id || "").trim().toUpperCase()))];
  for (let index = 0; index < uniqueIds.length; index += 20) {
    const slice = uniqueIds.slice(index, index + 20);
    const payload = await ml.get(itemsBulkPath(slice), { accessToken: ctx.accessToken });
    const returned = normalizeBulkResponse(payload).filter((entry) => Number(entry.code || 200) === 200).map((entry) => entry.body).filter(Boolean);
    for (const item of returned) {
      if (Number(item.seller_id) !== Number(ctx.sellerId)) throw Object.assign(new Error("Anuncio de outra conta no lote."), { status: 403 });
      items.push(item);
    }
  }
  return items;
}

async function buildPreviewRows(buffer, ctx, ml) {
  assertAccount(ctx);
  const imported = (await parseWorkbook(buffer)).filter((row) => String(row.sku_novo || "").trim());
  if (!imported.length) throw Object.assign(new Error("Preencha ao menos um SKU novo antes de importar."), { status: 400 });
  const ids = imported.map((row) => row.mlb).filter((id) => /^MLB\d{6,}$/i.test(id));
  const items = await loadLiveItems(ctx, ml, ids);
  const liveByKey = new Map(items.flatMap((item) => rowsFromItem(item, ctx.accountLabel).map((row) => [targetKey(row.mlb, row.id_variacao), { sku: row.sku_atual, ean: row.ean_gtin_atual }])));
  return classifyRows(imported, liveByKey, ctx.accountLabel);
}

async function exportRows(ctx, ml = mlApi) {
  assertAccount(ctx);
  const ids = [];
  let scrollId = "";
  for (let page = 0; page < 60; page += 1) {
    const query = { search_type: "scan", limit: 100 };
    if (scrollId) query.scroll_id = scrollId;
    const payload = await ml.get(`/users/${encodeURIComponent(ctx.sellerId)}/items/search`, { accessToken: ctx.accessToken, query });
    const results = Array.isArray(payload?.results) ? payload.results : [];
    ids.push(...results);
    if (ids.length > MAX_ROWS) throw Object.assign(new Error("A conta excede 5.000 anuncios. Exporte um recorte menor."), { status: 400 });
    scrollId = String(payload?.scroll_id || "");
    if (!results.length || !scrollId) break;
  }
  const items = await loadLiveItems(ctx, ml, ids);
  const rows = items.flatMap((item) => rowsFromItem(item, ctx.accountLabel));
  if (rows.length > MAX_ROWS) throw Object.assign(new Error("A conta excede 5.000 SKUs. Exporte um recorte menor."), { status: 400 });
  return exportWorkbook(rows);
}

async function confirmPreview(id, ctx, db = require("../db/db"), enqueue = (jobId) => require("./bulkSkuQueueService").enqueueBulkSkuJob(jobId)) {
  assertAccount(ctx);
  const actor = String(ctx.requestedBy || ctx.userId || "").trim();
  if (!actor) throw Object.assign(new Error("Usuario nao identificado."), { status: 403 });
  const result = await db.withClient(async (client) => {
    await client.query("begin");
    try {
      const found = await client.query("select * from ml.bulk_sku_jobs where id = $1 and account_key = $2 and requested_by = $3 for update", [id, String(ctx.accountKey), actor]);
      const job = found.rows[0];
      if (!job) throw Object.assign(new Error("Previa nao encontrada."), { status: 404 });
      if (job.status !== "preview") throw Object.assign(new Error("Previa ja confirmada ou encerrada."), { status: 409 });
      const count = await client.query("select count(*)::integer as count from ml.bulk_sku_job_rows where job_id = $1 and state = 'ready'", [id]);
      const ready = Number(count.rows[0]?.count || 0);
      if (!ready) throw Object.assign(new Error("Nenhuma linha pronta para alterar."), { status: 409 });
      await client.query("update ml.bulk_sku_jobs set status = 'queued', total_rows = $2 where id = $1", [id, ready]);
      await client.query("commit");
      return { id, status: "queued", total: ready };
    } catch (error) { await client.query("rollback"); throw error; }
  });
  try { await enqueue(id); }
  catch (error) {
    await db.query("update ml.bulk_sku_jobs set status = 'preview' where id = $1 and account_key = $2 and status = 'queued'", [id, String(ctx.accountKey)]);
    throw error;
  }
  return result;
}

async function getJob(id, ctx, db = require("../db/db"), { limit = 100, offset = 0 } = {}) {
  assertAccount(ctx);
  const actor = String(ctx.requestedBy || ctx.userId || "").trim();
  const job = await db.query("select * from ml.bulk_sku_jobs where id = $1 and account_key = $2 and requested_by = $3", [id, String(ctx.accountKey), actor]);
  if (!job.rowCount) return null;
  const rows = await db.query("select * from ml.bulk_sku_job_rows where job_id = $1 order by row_number limit $2 offset $3", [id, limit, offset]);
  const counts = await db.query("select state, count(*)::integer as count from ml.bulk_sku_job_rows where job_id = $1 group by state", [id]);
  return { ...job.rows[0], ...summarizeStates(counts.rows), rows: rows.rows, row_offset: offset, row_limit: limit };
}

function summarizeStates(rows) {
  const counts = Object.fromEntries(rows.map((row) => [row.state, Number(row.count || 0)]));
  return {
    success: counts.applied || 0,
    unchanged: counts.unchanged || 0,
    errors: (counts.error || 0) + (counts.stale || 0) + (counts.missing || 0) + (counts.unverified || 0),
  };
}

async function reportJob(id, ctx, stream, db = require("../db/db")) {
  const job = await getJob(id, ctx, db);
  if (!job) throw Object.assign(new Error("Lote nao encontrado."), { status: 404 });
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: false, useSharedStrings: false });
  const sheet = workbook.addWorksheet("Resultado de SKUs");
  const headers = ["linha", "mlb", "id_variacao", "sku_atual", "sku_novo", "resultado", "mensagem"];
  sheet.addRow(headers).commit();
  let cursor = 0;
  for (;;) {
    const page = await db.query("select * from ml.bulk_sku_job_rows where job_id = $1 and row_number > $2 order by row_number limit 1000", [id, cursor]);
    if (!page.rows.length) break;
    for (const row of page.rows) {
      sheet.addRow([row.row_number, row.mlb, row.variation_id, row.old_sku, row.new_sku, row.state, row.message].map((value) => String(value ?? ""))).commit();
    }
    cursor = Number(page.rows[page.rows.length - 1].row_number);
  }
  sheet.commit();
  await workbook.commit();
}

async function listJobs(ctx, db = require("../db/db")) {
  assertAccount(ctx);
  const actor = String(ctx.requestedBy || ctx.userId || "").trim();
  const scope = [String(ctx.accountKey), actor];
  const [exports, changes] = await Promise.all([
    db.query("select * from ml.bulk_sku_exports where account_key = $1 and requested_by = $2 order by created_at desc limit 30", scope),
    db.query("select * from ml.bulk_sku_jobs where account_key = $1 and requested_by = $2 order by created_at desc limit 30", scope),
  ]);
  const ids = changes.rows.map((job) => job.id);
  const countRows = ids.length ? (await db.query("select job_id, state, count(*)::integer as count from ml.bulk_sku_job_rows where job_id = any($1::text[]) group by job_id, state", [ids])).rows : [];
  const countsByJob = new Map(ids.map((id) => [String(id), summarizeStates(countRows.filter((row) => String(row.job_id) === String(id)))]));
  const statusLabel = { all: "Todos", active: "Ativos", paused: "Pausados" };
  const exportJobs = exports.rows.map((job) => ({
    adapter: "bulk-sku", id: `export-${job.id}`, kind: "sku_export", title: `Exportação de SKUs · ${statusLabel[job.filter_status] || job.filter_status}${job.status === "running" ? ` · ${job.scanned_items} anúncios` : ""}`,
    state: job.status === "finished" ? "completed" : job.status,
    completed: ["finished", "failed"].includes(job.status), processed: job.scanned_items,
    total: job.estimated_items || (job.status === "finished" ? job.scanned_items : 0), accountKey: job.account_key, accountLabel: job.account_label,
    updated_at: job.finished_at || job.created_at,
    error: job.error_message,
    review_action: job.status === "finished" ? { label: "Baixar XLSX", url: `/api/bulk-sku/exports/${job.id}/download.xlsx`, filename: `alteracao-skus-${job.filter_status}.xlsx` } : null,
  }));
  const changeJobs = changes.rows.map((job) => ({
    adapter: "bulk-sku", id: `change-${job.id}`, kind: "sku_change", title: job.status.startsWith("preview") ? `Conferência de SKUs${job.status === "previewing" ? ` · ${job.previewed_rows} linhas` : ""}` : "Alteração de SKUs",
    state: job.status === "finished" ? (countsByJob.get(String(job.id)).errors ? "partial" : "completed") : job.status === "preview" ? "completed" : job.status === "preview_queued" ? "queued" : job.status === "previewing" ? "running" : job.status,
    completed: ["preview", "finished", "failed"].includes(job.status),
    processed: job.status.startsWith("preview") ? job.previewed_rows : job.processed_rows,
    success: countsByJob.get(String(job.id)).success,
    unchanged: countsByJob.get(String(job.id)).unchanged,
    skipped: countsByJob.get(String(job.id)).unchanged,
    errors: countsByJob.get(String(job.id)).errors,
    total: job.total_rows,
    accountKey: job.account_key, accountLabel: job.account_label,
    updated_at: job.finished_at || job.created_at, error: job.error_message,
    review_action: ["finished", "failed"].includes(job.status) ? { label: "Baixar XLSX", url: `/api/bulk-sku/jobs/${job.id}/report.xlsx`, filename: "resultado-alteracao-skus.xlsx" } : null,
  }));
  return [...exportJobs, ...changeJobs].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 40);
}

async function applyJob(id, {
  db = require("../db/db"), ml = mlApi,
  loadCredentials = require("./estoqueAtualizacaoWorkerCredentials").loadWorkerCredentials,
  onProgress = async () => {},
} = {}) {
  return db.withClient(async (client) => {
    const lockKey = `bulk_sku:${id}`;
    const lock = await client.query("select pg_try_advisory_lock(hashtext($1)) as locked", [lockKey]);
    if (!lock.rows[0]?.locked) return { skipped: true, reason: "busy" };
    try {
      const found = await client.query("select * from ml.bulk_sku_jobs where id = $1", [id]);
      const job = found.rows[0];
      if (!job || !["queued", "running"].includes(job.status)) return { skipped: true, reason: "not_queued" };
      await client.query("update ml.bulk_sku_jobs set status = 'running', started_at = coalesce(started_at, now()) where id = $1", [id]);
      const credentials = await loadCredentials(job.account_key);
      const ctx = { accessToken: credentials.accessToken, sellerId: Number(credentials.mlCreds.meli_user_id) };
      const reads = require("./bulkSkuMlReads").withRetry(ml);
      const initialRemaining = await client.query("select count(*)::integer as count from ml.bulk_sku_job_rows where job_id = $1 and state = 'ready'", [id]);
      let processed = Math.max(0, Number(job.total_rows || 0) - Number(initialRemaining.rows[0]?.count || 0));
      await client.query("update ml.bulk_sku_jobs set processed_rows = $2 where id = $1", [id, processed]);
      let cursor = "";
      for (;;) {
        const next = await client.query("select distinct mlb from ml.bulk_sku_job_rows where job_id = $1 and state = 'ready' and mlb > $2 order by mlb limit 100", [id, cursor]);
        if (!next.rows.length) break;
        for (const { mlb } of next.rows) {
        const pending = await client.query("select * from ml.bulk_sku_job_rows where job_id = $1 and mlb = $2 and state = 'ready' order by row_number", [id, mlb]);
        const rows = pending.rows;
        if (!rows.length) { cursor = mlb; continue; }
        let results;
        try { results = await applyGroup(mlb, rows, ctx, reads); }
        catch (error) {
          results = rows.map((row) => ({ row_number: row.row_number, state: "error", message: String(error.message || "Falha no ML").slice(0, 500) }));
        }
        await client.query("begin");
        try {
          for (const result of results) {
            await client.query("update ml.bulk_sku_job_rows set state = $3, message = $4, updated_at = now() where job_id = $1 and row_number = $2 and state = 'ready'", [id, result.row_number, result.state, result.message]);
          }
          processed += results.length;
          await client.query("update ml.bulk_sku_jobs set processed_rows = $2 where id = $1", [id, processed]);
          await client.query("commit");
        } catch (error) { await client.query("rollback"); throw error; }
        await onProgress(Math.min(100, Math.round((processed / Math.max(1, Number(job.total_rows || 1))) * 100)));
        cursor = mlb;
        }
      }
      await client.query("update ml.bulk_sku_jobs set status = 'finished', finished_at = now() where id = $1", [id]);
      return { id, processed };
    } finally { await client.query("select pg_advisory_unlock(hashtext($1))", [lockKey]); }
  });
}

async function previewWorkbook(buffer, ctx, ml = mlApi, db = require("../db/db")) {
  assertAccount(ctx);
  const actor = String(ctx.requestedBy || ctx.userId || "").trim();
  if (!actor) throw Object.assign(new Error("Usuario nao identificado."), { status: 403 });
  const rows = await buildPreviewRows(buffer, ctx, ml);
  const id = crypto.randomUUID();
  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query(`insert into ml.bulk_sku_jobs (id, account_key, account_label, requested_by, status, total_rows)
        values ($1, $2, $3, $4, 'preview', $5)`, [id, String(ctx.accountKey), String(ctx.accountLabel || ctx.sellerId), actor, rows.length]);
      for (const row of rows) {
        await client.query(`insert into ml.bulk_sku_job_rows
          (job_id, mlb, variation_id, row_number, variation_name, old_sku, new_sku, ean_snapshot, state, message, warning)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
          id, String(row.mlb).toUpperCase(), String(row.id_variacao || ""), row.row_number,
          String(row.nome_variacao || ""), String(row.sku_atual || ""), String(row.sku_novo || ""),
          String(row.ean_gtin_atual || ""), row.state, row.message, row.warning,
        ]);
      }
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
  });
  return { id, rows, ready: rows.filter((row) => row.state === "ready").length, total: rows.length };
}

module.exports = { assertAccount, rowsFromItem, replaceSku, planSkuPayload, applyGroup, applyJob, loadLiveItems, buildPreviewRows, exportRows, previewWorkbook, confirmPreview, getJob, reportJob, listJobs };
