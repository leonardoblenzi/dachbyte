"use strict";

const { variationName, gtinValues, sellerSku } = require("./bulkSkuPreviewService");
const { itemsBulkPath, normalizeBulkResponse } = require("./meliBulk");
const { targetKey, classifyRows } = require("./bulkSkuPreviewService");
const { exportWorkbook, parseWorkbook, MAX_ROWS } = require("./bulkSkuWorkbookService");
const { reportCsv } = require("./bulkSkuWorkbookService");
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

async function getJob(id, ctx, db = require("../db/db")) {
  assertAccount(ctx);
  const actor = String(ctx.requestedBy || ctx.userId || "").trim();
  const job = await db.query("select * from ml.bulk_sku_jobs where id = $1 and account_key = $2 and requested_by = $3", [id, String(ctx.accountKey), actor]);
  if (!job.rowCount) return null;
  const rows = await db.query("select * from ml.bulk_sku_job_rows where job_id = $1 order by row_number", [id]);
  return { ...job.rows[0], rows: rows.rows };
}

async function reportJob(id, ctx, db = require("../db/db")) {
  const job = await getJob(id, ctx, db);
  if (!job) throw Object.assign(new Error("Lote nao encontrado."), { status: 404 });
  return reportCsv(job.rows.map((row) => ({
    mlb: row.mlb, id_variacao: row.variation_id, sku_atual: row.old_sku,
    sku_novo: row.new_sku, resultado: row.state, mensagem: row.message,
  })));
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

module.exports = { assertAccount, rowsFromItem, replaceSku, loadLiveItems, buildPreviewRows, exportRows, previewWorkbook, confirmPreview, getJob, reportJob };
