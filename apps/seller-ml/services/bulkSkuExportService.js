"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ExcelJS = require("exceljs");
const mlApi = require("./anuncioCadastro/mercadoLivreApi");
const { withRetry } = require("./bulkSkuMlReads");
const { HEADERS } = require("./bulkSkuWorkbookService");
const { rowsFromItem, loadLiveItems, assertAccount } = require("./bulkSkuService");

const RESULTS_DIR = path.join(__dirname, "..", "results", "bulk-sku");
const STATUSES = new Set(["all", "active", "paused"]);

function normalizeStatus(value) {
  const status = String(value || "active").trim().toLowerCase();
  if (!STATUSES.has(status)) throw Object.assign(new Error("Filtro de status invalido."), { status: 400 });
  return status;
}

function exportPath(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw Object.assign(new Error("ID de exportacao invalido."), { status: 400 });
  return path.join(RESULTS_DIR, `${id}.xlsx`);
}

async function scanSellerItems(ctx, status, ml = mlApi, onPage = async () => {}) {
  let scrollId = "";
  const seenCursors = new Set();
  let scanned = 0;
  for (let page = 0; page < 1000; page += 1) {
    const query = { search_type: "scan", limit: 100 };
    if (status !== "all") query.status = status;
    if (scrollId) query.scroll_id = scrollId;
    const payload = await ml.get(`/users/${encodeURIComponent(ctx.sellerId)}/items/search`, { accessToken: ctx.accessToken, query });
    const ids = Array.isArray(payload?.results) ? payload.results : [];
    if (ids.length) { await onPage(ids, payload); scanned += ids.length; }
    const next = String(payload?.scroll_id || "");
    if (!next || seenCursors.has(next)) return scanned;
    seenCursors.add(next);
    scrollId = next;
  }
  throw new Error("A busca ultrapassou o limite operacional de paginas do ML.");
}

async function createExport(ctx, status, db = require("../db/db"), enqueue = (id) => require("./bulkSkuQueueService").enqueueExportJob(id)) {
  assertAccount(ctx);
  const actor = String(ctx.requestedBy || ctx.userId || "").trim();
  if (!actor) throw Object.assign(new Error("Usuario nao identificado."), { status: 403 });
  const id = crypto.randomUUID();
  const selected = normalizeStatus(status);
  await db.query(`insert into ml.bulk_sku_exports (id, account_key, account_label, requested_by, seller_id, filter_status, status)
    values ($1,$2,$3,$4,$5,$6,'queued')`, [id, String(ctx.accountKey), String(ctx.accountLabel || ctx.sellerId), actor, String(ctx.sellerId), selected]);
  try { await enqueue(id); }
  catch (error) { await db.query("update ml.bulk_sku_exports set status = 'failed', error_message = $2 where id = $1", [id, String(error.message || "Fila indisponivel").slice(0, 500)]); throw error; }
  return { id, status: "queued", filter_status: selected };
}

async function getExport(id, ctx, db = require("../db/db")) {
  assertAccount(ctx);
  const actor = String(ctx.requestedBy || ctx.userId || "").trim();
  const result = await db.query("select * from ml.bulk_sku_exports where id = $1 and account_key = $2 and requested_by = $3", [id, String(ctx.accountKey), actor]);
  return result.rows[0] || null;
}

async function runExport(id, {
  db = require("../db/db"), ml = mlApi,
  loadCredentials = require("./estoqueAtualizacaoWorkerCredentials").loadWorkerCredentials,
  onProgress = async () => {},
} = {}) {
  const found = await db.query("select * from ml.bulk_sku_exports where id = $1 and status in ('queued','running')", [id]);
  const job = found.rows[0];
  if (!job) return { skipped: true };
  const credentials = await loadCredentials(job.account_key);
  const ctx = { accountKey: job.account_key, sellerId: Number(credentials.mlCreds.meli_user_id), accessToken: credentials.accessToken };
  const reads = withRetry(ml);
  if (String(ctx.sellerId) !== String(job.seller_id)) throw new Error("Conta mudou durante a exportacao.");
  await db.query("update ml.bulk_sku_exports set status = 'running', started_at = coalesce(started_at, now()) where id = $1", [id]);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const filename = exportPath(id);
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename, useStyles: false, useSharedStrings: false });
  const sheet = workbook.addWorksheet("Alteracao de SKUs");
  sheet.addRow(HEADERS).commit();
  let itemCount = 0;
  let rowCount = 0;
  let estimated = Number(job.estimated_items || 0);
  try {
    await scanSellerItems(ctx, job.filter_status, reads, async (ids, payload) => {
      const reported = Number(payload?.paging?.total || 0);
      if (reported > 0) estimated = reported;
      const items = await loadLiveItems(ctx, reads, ids);
      for (const item of items) for (const row of rowsFromItem(item, job.account_label)) {
        sheet.addRow(HEADERS.map((key) => String(row[key] ?? ""))).commit();
        rowCount += 1;
      }
      itemCount += ids.length;
      await db.query("update ml.bulk_sku_exports set scanned_items = $2, exported_rows = $3, estimated_items = $4 where id = $1", [id, itemCount, rowCount, estimated]);
      await onProgress(itemCount);
    });
    sheet.commit();
    await workbook.commit();
    await db.query("update ml.bulk_sku_exports set status = 'finished', finished_at = now(), scanned_items = $2, exported_rows = $3 where id = $1", [id, itemCount, rowCount]);
    return { id, scanned_items: itemCount, exported_rows: rowCount };
  } catch (error) {
    try { fs.unlinkSync(filename); } catch (_) {}
    await db.query("update ml.bulk_sku_exports set status = 'failed', finished_at = now(), error_message = $2 where id = $1", [id, String(error.message || "Falha na exportacao").slice(0, 500)]);
    throw error;
  }
}

module.exports = { normalizeStatus, exportPath, scanSellerItems, createExport, getExport, runExport };
