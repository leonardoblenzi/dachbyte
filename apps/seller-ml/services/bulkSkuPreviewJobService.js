"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ExcelJS = require("exceljs");
const { HEADERS, cellText } = require("./bulkSkuWorkbookService");
const { loadLiveItems, rowsFromItem, assertAccount } = require("./bulkSkuService");
const { targetKey, classifyRows } = require("./bulkSkuPreviewService");
const mlApi = require("./anuncioCadastro/mercadoLivreApi");
const { withRetry } = require("./bulkSkuMlReads");

const IMPORT_DIR = path.join(__dirname, "..", "results", "bulk-sku", "imports");
const MAX_UPLOAD_ROWS = 200000;

function importPath(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error("ID de importacao invalido.");
  return path.join(IMPORT_DIR, `${id}.xlsx`);
}

async function* readEditedRows(filename, batchSize = 100) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filename, { entries: "emit", sharedStrings: "cache", hyperlinks: "ignore", styles: "ignore", worksheets: "emit" });
  let found = false;
  let batch = [];
  let total = 0;
  for await (const sheet of reader) {
    if (found) break;
    found = true;
    for await (const group of sheet) for (const row of Array.isArray(group) ? group : [group]) {
      const cells = HEADERS.map((_, index) => cellText(row.getCell(index + 1)).trim());
      if (row.number === 1) {
        if (cells.some((value, index) => value !== HEADERS[index])) throw Object.assign(new Error("Cabecalhos da planilha nao correspondem ao modelo exportado."), { status: 400 });
        continue;
      }
      if (!cells[6]) continue;
      total += 1;
      if (total > MAX_UPLOAD_ROWS) throw Object.assign(new Error("A planilha excede 200.000 alteracoes por lote."), { status: 400 });
      batch.push({ ...Object.fromEntries(HEADERS.map((key, index) => [key, cells[index]])), row_number: row.number });
      if (batch.length >= batchSize) { yield batch; batch = []; }
    }
  }
  if (!found) throw Object.assign(new Error("Planilha vazia."), { status: 400 });
  if (batch.length) yield batch;
  if (!total) throw Object.assign(new Error("Preencha ao menos um SKU novo antes de importar."), { status: 400 });
}

async function countEditedRows(filename) {
  let count = 0;
  for await (const batch of readEditedRows(filename, 1000)) count += batch.length;
  return count;
}

async function createPreview(ctx, uploadedPath, db = require("../db/db"), enqueue = (id) => require("./bulkSkuQueueService").enqueuePreviewJob(id)) {
  assertAccount(ctx);
  const actor = String(ctx.requestedBy || ctx.userId || "").trim();
  if (!actor) throw Object.assign(new Error("Usuario nao identificado."), { status: 403 });
  const id = crypto.randomUUID();
  fs.mkdirSync(IMPORT_DIR, { recursive: true });
  fs.renameSync(uploadedPath, importPath(id));
  try {
    await db.query(`insert into ml.bulk_sku_jobs (id, account_key, account_label, requested_by, status, total_rows)
      values ($1,$2,$3,$4,'preview_queued',0)`, [id, String(ctx.accountKey), String(ctx.accountLabel || ctx.sellerId), actor]);
    await enqueue(id);
  } catch (error) {
    try { fs.unlinkSync(importPath(id)); } catch (_) {}
    await db.query("update ml.bulk_sku_jobs set status = 'failed', error_message = $2 where id = $1", [id, String(error.message || "Fila indisponivel").slice(0, 500)]).catch(() => {});
    throw error;
  }
  return { id, status: "preview_queued" };
}

async function runPreview(id, {
  db = require("../db/db"), ml = mlApi,
  loadCredentials = require("./estoqueAtualizacaoWorkerCredentials").loadWorkerCredentials,
  onProgress = async () => {},
} = {}) {
  const found = await db.query("select * from ml.bulk_sku_jobs where id = $1 and status in ('preview_queued','previewing')", [id]);
  const job = found.rows[0];
  if (!job) return { skipped: true };
  const credentials = await loadCredentials(job.account_key);
  const ctx = { accountKey: job.account_key, sellerId: Number(credentials.mlCreds.meli_user_id), accessToken: credentials.accessToken };
  const reads = withRetry(ml);
  await db.query("update ml.bulk_sku_jobs set status = 'previewing', started_at = coalesce(started_at, now()) where id = $1", [id]);
  const seen = new Set();
  let scanned = Number(job.previewed_rows || 0);
  let lastRow = Number(job.last_row_number || 0);
  let ready = Number(job.ready_rows || 0);
  try {
  const total = await countEditedRows(importPath(id));
  await db.query("update ml.bulk_sku_jobs set total_rows = $2 where id = $1", [id, total]);
  if (lastRow) {
    const previous = await db.query("select mlb, variation_id from ml.bulk_sku_job_rows where job_id = $1", [id]);
    for (const row of previous.rows) seen.add(targetKey(row.mlb, row.variation_id));
  }
    for await (const batch of readEditedRows(importPath(id))) {
      const pending = batch.filter((row) => row.row_number > lastRow);
      if (!pending.length) continue;
      const ids = pending.map((row) => row.mlb).filter((value) => /^MLB\d{6,}$/i.test(value));
      const items = await loadLiveItems(ctx, reads, ids);
      const live = new Map(items.flatMap((item) => rowsFromItem(item, job.account_label).map((row) => [targetKey(row.mlb, row.id_variacao), { sku: row.sku_atual, ean: row.ean_gtin_atual }])));
      const classified = classifyRows(pending, live, job.account_label, { seen });
      await db.withClient(async (client) => {
        await client.query("begin");
        try {
          for (const row of classified) {
            await client.query(`insert into ml.bulk_sku_job_rows
              (job_id, mlb, variation_id, row_number, variation_name, old_sku, new_sku, ean_snapshot, state, message, warning)
              values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (job_id,row_number) do nothing`, [
              id, String(row.mlb).toUpperCase(), String(row.id_variacao || ""), row.row_number,
              String(row.nome_variacao || ""), String(row.sku_atual || ""), String(row.sku_novo || ""),
              String(row.ean_gtin_atual || ""), row.state, row.message, row.warning,
            ]);
          }
          scanned += pending.length;
          lastRow = pending[pending.length - 1].row_number;
          ready += classified.filter((row) => row.state === "ready").length;
          await client.query("update ml.bulk_sku_jobs set previewed_rows = $2, ready_rows = $3, last_row_number = $4 where id = $1", [id, scanned, ready, lastRow]);
          await client.query("commit");
        } catch (error) { await client.query("rollback"); throw error; }
      });
      await onProgress(scanned);
    }
    await db.query("update ml.bulk_sku_jobs set status = 'preview', finished_at = now() where id = $1", [id]);
    return { id, previewed_rows: scanned, ready_rows: ready };
  } catch (error) {
    await db.query("update ml.bulk_sku_jobs set status = 'failed', finished_at = now(), error_message = $2 where id = $1", [id, String(error.message || "Falha na conferencia").slice(0, 500)]);
    throw error;
  } finally { try { fs.unlinkSync(importPath(id)); } catch (_) {} }
}

module.exports = { importPath, readEditedRows, countEditedRows, createPreview, runPreview };
