"use strict";

const Bull = require("bull");
const fetch = require("node-fetch");
const db = require("../db/db");
const { makeBullClient } = require("../lib/redisClient");
const TokenService = require("./tokenService");

const ML_API_BASE = "https://api.mercadolibre.com";
const QUEUE_NAME = "financeiro-ml-sku-catalog-sync";
const ACTIVE_STATUSES = ["active"];
const MARGIN_MAX_RANGE_DAYS = 92;
const RECENT_SALES_ORDER_LIMIT = 5000;

let queueInstance = null;
let workerStarted = false;

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeSku(value) {
  return normalizeString(value).toUpperCase();
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getQueue() {
  if (!queueInstance) {
    queueInstance = new Bull(QUEUE_NAME, {
      createClient: (type) => makeBullClient(type, QUEUE_NAME),
    });
  }
  return queueInstance;
}

async function setJobProgress(job, value) {
  const progress = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  if (typeof job?.progress === "function") return job.progress(progress);
  if (typeof job?.updateProgress === "function") return job.updateProgress(progress);
  job._progress = progress;
  return progress;
}

async function getJobProgress(job) {
  try {
    if (typeof job?.progress === "function") {
      const value = job.progress();
      return typeof value?.then === "function" ? await value : value;
    }
  } catch {
    // Bull v3 exposes progress as a synchronous method in this runtime.
  }
  return job?._progress || 0;
}

async function prepareAuth(context = {}) {
  const creds = context?.mlCreds && typeof context.mlCreds === "object"
    ? { ...context.mlCreds }
    : {};
  if (!creds.account_key && context.accountKey) creds.account_key = context.accountKey;
  const token = await TokenService.renovarTokenSeNecessario(creds);
  return { token, creds };
}

async function mlRequest(state, path, query = {}, retries = 1) {
  const url = new URL(`${ML_API_BASE}${path}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value == null || value === "") return;
    url.searchParams.set(key, String(value));
  });

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url.toString(), {
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${state.token}`,
        "x-format-new": "true",
      },
    });

    if (response.status === 401 && attempt < retries) {
      const refreshed = await TokenService.renovarToken(state.creds);
      state.token = refreshed.access_token;
      continue;
    }

    const text = await response.text().catch(() => "");
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const err = new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      err.status = response.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }
  return {};
}

async function fetchSeller(state) {
  const payload = await mlRequest(state, "/users/me", {}, 1);
  return {
    id: payload?.id ? String(payload.id) : null,
    nickname: payload?.nickname || null,
  };
}

function pickAttrValue(attr) {
  return normalizeString(
    attr?.value_name ||
      attr?.value_id ||
      (Array.isArray(attr?.values) ? attr.values[0]?.name || attr.values[0]?.id : ""),
  );
}

function isSkuAttr(attr) {
  const id = String(attr?.id || "").toUpperCase();
  const name = String(attr?.name || "").trim().toLowerCase();
  return ["SELLER_SKU", "SKU"].includes(id) || name === "sku" || name.includes("sku");
}

function isIdentifierAttr(attr) {
  const id = String(attr?.id || "").toUpperCase();
  const name = String(attr?.name || "").trim().toLowerCase();
  return (
    ["GTIN", "EAN", "UPC", "JAN", "ISBN", "ISBN10", "ISBN13", "GTIN14"].includes(id) ||
    ["gtin", "ean", "upc", "jan", "isbn"].includes(name) ||
    name.includes("codigo de barras") ||
    name.includes("código de barras")
  );
}

function collectAttrValues(attr) {
  const out = [];
  [attr?.value_name, attr?.value_id].forEach((value) => {
    const normalized = normalizeString(value);
    if (normalized) out.push(normalized);
  });
  if (Array.isArray(attr?.values)) {
    attr.values.forEach((value) => {
      [value?.name, value?.id].forEach((raw) => {
        const normalized = normalizeString(raw);
        if (normalized) out.push(normalized);
      });
    });
  }
  return out;
}

function extractEans(attrs = []) {
  const values = [];
  for (const attr of Array.isArray(attrs) ? attrs : []) {
    if (isIdentifierAttr(attr)) values.push(...collectAttrValues(attr));
  }
  return Array.from(new Set(values.map(normalizeString).filter(Boolean)));
}

function extractCatalogRows(item = {}) {
  const attrs = Array.isArray(item.attributes) ? item.attributes : [];
  const itemSkuAttr = attrs.find(isSkuAttr);
  const itemSku = normalizeSku(
    item.seller_custom_field || item.seller_sku || pickAttrValue(itemSkuAttr),
  );
  const itemEans = extractEans(attrs);
  const common = {
    mlb: String(item.id || ""),
    title: item.title || String(item.id || ""),
    status: item.status || null,
    category_id: item.category_id || null,
    listing_type_id: item.listing_type_id || null,
    price: numberOrZero(item.price),
    thumbnail: item.secure_thumbnail || item.thumbnail || null,
    permalink: item.permalink || null,
  };

  // Em anuncios com variacoes, o SKU item-level pode ser apenas um SKU-base.
  // Sempre prefira os SKUs das variacoes quando eles existirem, para que a
  // base de custos preserve exatamente o SKU que aparece nas orders.
  const variationRows = [];
  for (const variation of Array.isArray(item.variations) ? item.variations : []) {
    const variationAttrs = Array.isArray(variation?.attributes) ? variation.attributes : [];
    const variationSkuAttr = variationAttrs.find(isSkuAttr);
    const variationSku = normalizeSku(
      variation?.seller_custom_field || variation?.seller_sku || pickAttrValue(variationSkuAttr),
    );
    if (!variationSku) continue;
    variationRows.push({
      ...common,
      reference_sku: variationSku,
      variation_id: normalizeString(variation?.id),
      stock: numberOrZero(variation?.available_quantity),
      eans: Array.from(new Set([...itemEans, ...extractEans(variationAttrs)])),
    });
  }
  if (variationRows.length) return variationRows;

  if (!itemSku) return [];
  return [{
    ...common,
    reference_sku: itemSku,
    variation_id: "",
    stock: numberOrZero(item.available_quantity),
    eans: itemEans,
  }];
}

async function fetchActiveItemIdsByScan(state, sellerId) {
  const all = [];
  let scrollId = "";
  const limit = 100;

  for (;;) {
    const query = {
      status: "active",
      search_type: "scan",
      limit,
    };
    if (scrollId) query.scroll_id = scrollId;

    const payload = await mlRequest(
      state,
      `/users/${encodeURIComponent(String(sellerId))}/items/search`,
      query,
      1,
    );
    const rows = Array.isArray(payload?.results) ? payload.results : [];
    all.push(...rows.map((id) => String(id)).filter(Boolean));
    scrollId = payload?.scroll_id || "";
    if (!rows.length || !scrollId) break;
  }

  return Array.from(new Set(all));
}

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - Math.max(0, Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function toMlDateTime(date, end = false) {
  return `${date}T${end ? "23:59:59.999" : "00:00:00.000"}-03:00`;
}

async function fetchRecentSoldItemIds(state, sellerId) {
  const days = Math.max(
    MARGIN_MAX_RANGE_DAYS,
    Math.min(365, Number(process.env.ML_FINANCE_SYNC_SALES_DAYS) || MARGIN_MAX_RANGE_DAYS),
  );
  const maxOrders = Math.max(
    100,
    Math.min(10000, Number(process.env.ML_FINANCE_SYNC_SALES_ORDER_LIMIT) || RECENT_SALES_ORDER_LIMIT),
  );
  const itemIds = new Set();
  const pageSize = 50;
  const dateFrom = isoDateDaysAgo(days - 1);
  const dateTo = todayIsoDate();
  let ordersRead = 0;
  let ordersAvailable = 0;

  for (let offset = 0; ordersRead < maxOrders; offset += pageSize) {
    const payload = await mlRequest(
      state,
      "/orders/search",
      {
        seller: sellerId,
        "order.status": "paid",
        "order.date_closed.from": toMlDateTime(dateFrom, false),
        "order.date_closed.to": toMlDateTime(dateTo, true),
        sort: "date_desc",
        limit: pageSize,
        offset,
      },
      1,
    ).catch(() => null);

    const orders = Array.isArray(payload?.results) ? payload.results : [];
    ordersAvailable = Math.max(ordersAvailable, numberOrZero(payload?.paging?.total));
    ordersRead += orders.length;
    for (const order of orders) {
      for (const entry of Array.isArray(order?.order_items) ? order.order_items : []) {
        const itemId = normalizeString(entry?.item?.id || entry?.item_id);
        if (itemId) itemIds.add(itemId);
      }
    }
    if (!orders.length || orders.length < pageSize || ordersRead >= maxOrders) break;
  }

  return {
    ids: Array.from(itemIds),
    days,
    orders_read: Math.min(ordersRead, maxOrders),
    orders_available: ordersAvailable || ordersRead,
    partial: ordersAvailable > maxOrders,
  };
}

async function fetchCostLinkedItemIds(accountKey) {
  const result = await db.query(
    `select distinct ci.mlb
       from ml.mercadolivre_sku_catalog_items ci
       join ml.mercadolivre_sku_costs cst
         on cst.account_key = ci.account_key
        and cst.reference_sku = ci.reference_sku
      where ci.account_key = $1
        and coalesce(cst.custo_produto_unitario, 0) > 0
        and coalesce(ci.mlb, '') <> ''`,
    [String(accountKey || "default")],
  ).catch((error) => {
    const message = String(error?.message || "");
    if (message.includes("mercadolivre_sku_catalog_items") || message.includes("mercadolivre_sku_costs")) {
      return { rows: [] };
    }
    throw error;
  });
  return Array.from(new Set((result.rows || []).map((row) => normalizeString(row?.mlb)).filter(Boolean)));
}

async function fetchItemDetails(state, ids = []) {
  const out = [];
  const cleanIds = Array.from(new Set(ids.map(normalizeString).filter(Boolean)));
  for (let i = 0; i < cleanIds.length; i += 20) {
    const slice = cleanIds.slice(i, i + 20);
    const rows = await mlRequest(state, "/items", {
      ids: slice.join(","),
      attributes: [
        "id",
        "title",
        "thumbnail",
        "secure_thumbnail",
        "seller_custom_field",
        "price",
        "status",
        "category_id",
        "listing_type_id",
        "available_quantity",
        "permalink",
        "attributes",
        "variations",
      ].join(","),
    }).catch(() => []);

    for (const row of Array.isArray(rows) ? rows : []) {
      if (row?.code === 200 && row?.body?.id) out.push(row.body);
    }
  }
  return out;
}

async function createRun({ accountKey, sellerId }) {
  const result = await db.query(
    `insert into ml.mercadolivre_sku_sync_runs
       (account_key, seller_id, status, scope_statuses, started_at)
     values ($1, $2, 'running', $3::jsonb, now())
     returning id`,
    [String(accountKey || "default"), sellerId || null, JSON.stringify(["active", "sold_last_92d", "cost_linked"])],
  );
  return Number(result.rows[0]?.id);
}

async function updateRun(runId, patch = {}) {
  const fields = [];
  const values = [];
  const set = (column, value, cast = "") => {
    values.push(value);
    fields.push(`${column} = $${values.length}${cast}`);
  };
  Object.entries(patch).forEach(([key, value]) => {
    if (key === "meta") set("meta", JSON.stringify(value || {}), "::jsonb");
    else set(key, value);
  });
  if (!fields.length) return;
  values.push(runId);
  await db.query(
    `update ml.mercadolivre_sku_sync_runs
        set ${fields.join(", ")}, updated_at = now()
      where id = $${values.length}`,
    values,
  );
}

async function upsertCatalogItems({ accountKey, sellerId, runId, rows }) {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `delete from ml.mercadolivre_sku_catalog_items ci
        where ci.account_key = $1
          and ci.sync_run_id is distinct from $2
          and not exists (
            select 1
              from ml.mercadolivre_sku_costs cst
             where cst.account_key = ci.account_key
               and cst.reference_sku = ci.reference_sku
               and coalesce(cst.custo_produto_unitario, 0) > 0
          )`,
      [accountKey, runId],
    );

    for (const row of rows) {
      await client.query(
        `insert into ml.mercadolivre_sku_catalog_items
          (account_key, seller_id, reference_sku, mlb, variation_id, title, status,
           category_id, listing_type_id, price, stock, thumbnail, permalink, eans,
           last_synced_at, sync_run_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, now(), $15)
         on conflict (account_key, reference_sku, mlb, variation_id)
         do update set
           seller_id = excluded.seller_id,
           title = excluded.title,
           status = excluded.status,
           category_id = excluded.category_id,
           listing_type_id = excluded.listing_type_id,
           price = excluded.price,
           stock = excluded.stock,
           thumbnail = excluded.thumbnail,
           permalink = excluded.permalink,
           eans = excluded.eans,
           last_synced_at = now(),
           sync_run_id = excluded.sync_run_id,
           updated_at = now()`,
        [
          accountKey,
          sellerId,
          row.reference_sku,
          row.mlb,
          row.variation_id || "",
          row.title,
          row.status,
          row.category_id,
          row.listing_type_id,
          row.price,
          row.stock,
          row.thumbnail,
          row.permalink,
          JSON.stringify(row.eans || []),
          runId,
        ],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function savePriceHistoryRows({ accountKey, sellerId, runId, rows }) {
  if (!Array.isArray(rows) || !rows.length) return 0;

  const client = await db.pool.connect();
  try {
    await client.query("begin");
    let saved = 0;

    for (const row of rows) {
      if (!row.reference_sku || !row.mlb) continue;
      await client.query(
        `insert into ml.mercadolivre_sku_price_history
          (account_key, seller_id, reference_sku, mlb, variation_id, title, status,
           category_id, listing_type_id, price, stock, snapshot_date, captured_at,
           sync_run_id, source, meta)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, current_date, now(),
                 $12, 'sku_catalog_sync', $13::jsonb)
         on conflict (account_key, reference_sku, mlb, variation_id, snapshot_date)
         do update set
           seller_id = excluded.seller_id,
           title = excluded.title,
           status = excluded.status,
           category_id = excluded.category_id,
           listing_type_id = excluded.listing_type_id,
           price = excluded.price,
           stock = excluded.stock,
           captured_at = now(),
           sync_run_id = excluded.sync_run_id,
           source = excluded.source,
           meta = excluded.meta`,
        [
          accountKey,
          sellerId,
          row.reference_sku,
          row.mlb,
          row.variation_id || "",
          row.title,
          row.status,
          row.category_id,
          row.listing_type_id,
          row.price,
          row.stock,
          runId,
          JSON.stringify({ eans: row.eans || [] }),
        ],
      );
      saved += 1;
    }

    await client.query("commit");
    return saved;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function rebuildSkuCatalog({ accountKey, sellerId, runId }) {
  await db.query(
    `update ml.mercadolivre_sku_catalog
        set is_active = false,
            updated_at = now()
      where account_key = $1`,
    [accountKey],
  );

  await db.query(
    `insert into ml.mercadolivre_sku_catalog
      (account_key, seller_id, reference_sku, title_sample, thumbnail, item_count,
       active_item_count, paused_item_count, closed_item_count, stock_total,
       min_price, max_price, statuses, categories, eans, sample_mlbs, is_active,
       last_seen_at, last_synced_at, sync_run_id)
     select
       account_key,
       max(seller_id),
       reference_sku,
       (array_agg(title order by updated_at desc))[1],
       (array_agg(thumbnail order by updated_at desc))[1],
       count(distinct mlb)::integer,
       count(distinct mlb) filter (where status = 'active')::integer,
       count(distinct mlb) filter (where status = 'paused')::integer,
       count(distinct mlb) filter (where status = 'closed')::integer,
       coalesce(sum(stock), 0)::integer,
       min(price),
       max(price),
       coalesce(jsonb_agg(distinct status) filter (where status is not null), '[]'::jsonb),
       coalesce(jsonb_agg(distinct category_id) filter (where category_id is not null), '[]'::jsonb),
       coalesce(jsonb_agg(distinct ean_value) filter (where ean_value is not null and ean_value <> ''), '[]'::jsonb),
       coalesce(jsonb_agg(distinct mlb), '[]'::jsonb),
       bool_or(status = 'active'),
       now(),
       now(),
       $2
      from ml.mercadolivre_sku_catalog_items i
      left join lateral jsonb_array_elements_text(i.eans) ean(ean_value) on true
     where account_key = $1
       and sync_run_id = $2
     group by account_key, reference_sku
     on conflict (account_key, reference_sku)
     do update set
       seller_id = excluded.seller_id,
       title_sample = excluded.title_sample,
       thumbnail = excluded.thumbnail,
       item_count = excluded.item_count,
       active_item_count = excluded.active_item_count,
       paused_item_count = excluded.paused_item_count,
       closed_item_count = excluded.closed_item_count,
       stock_total = excluded.stock_total,
       min_price = excluded.min_price,
       max_price = excluded.max_price,
       statuses = excluded.statuses,
       categories = excluded.categories,
       eans = excluded.eans,
       sample_mlbs = excluded.sample_mlbs,
       is_active = true,
       last_seen_at = now(),
       last_synced_at = now(),
       sync_run_id = excluded.sync_run_id,
       updated_at = now()`,
    [accountKey, runId],
  );
}

async function processSyncJob(job) {
  const accountKey = String(job.data?.accountKey || "default");
  const state = await prepareAuth(job.data || {});
  const seller = await fetchSeller(state);
  if (!seller.id) throw new Error("Nao foi possivel identificar o seller Mercado Livre.");

  const runId = await createRun({ accountKey, sellerId: seller.id });
  await setJobProgress(job, 2);

  try {
    // O catalogo precisa cobrir duas necessidades diferentes:
    // 1) KPIs e monitoramento dos anuncios ativos atuais;
    // 2) resolucao de CMV para qualquer venda que a tela de Margem consiga consultar.
    // Como a Margem aceita ate 92 dias, sincronizamos tambem os MLBs vendidos nessa janela
    // e preservamos MLBs ligados a SKUs que ja possuem custo cadastrado.
    const [activeIds, recentSales, costLinkedIds] = await Promise.all([
      fetchActiveItemIdsByScan(state, seller.id),
      fetchRecentSoldItemIds(state, seller.id),
      fetchCostLinkedItemIds(accountKey),
    ]);
    const ids = Array.from(new Set([
      ...activeIds,
      ...(recentSales.ids || []),
      ...costLinkedIds,
    ].map(normalizeString).filter(Boolean)));

    await updateRun(runId, {
      total_items: ids.length,
      processed_items: 0,
      meta: {
        seller_nickname: seller.nickname,
        active_items: activeIds.length,
        sold_items_window: recentSales.ids?.length || 0,
        sold_orders_read: recentSales.orders_read || 0,
        sold_orders_available: recentSales.orders_available || 0,
        sold_orders_partial: !!recentSales.partial,
        sold_window_days: recentSales.days || MARGIN_MAX_RANGE_DAYS,
        cost_linked_items: costLinkedIds.length,
        relevant_items: ids.length,
      },
    });

    const rows = [];
    let noSkuItems = 0;
    for (let i = 0; i < ids.length; i += 20) {
      const details = await fetchItemDetails(state, ids.slice(i, i + 20));
      for (const item of details) {
        const extracted = extractCatalogRows(item);
        if (!extracted.length) noSkuItems += 1;
        rows.push(...extracted);
      }
      const processed = Math.min(i + 20, ids.length);
      await updateRun(runId, { processed_items: processed, no_sku_items: noSkuItems });
      await setJobProgress(job, ids.length ? Math.min(85, Math.round((processed / ids.length) * 85)) : 85);
    }

    await upsertCatalogItems({ accountKey, sellerId: seller.id, runId, rows });
    const priceHistoryRows = await savePriceHistoryRows({ accountKey, sellerId: seller.id, runId, rows });
    await rebuildSkuCatalog({ accountKey, sellerId: seller.id, runId });

    const totalSkus = new Set(rows.map((row) => row.reference_sku).filter(Boolean)).size;
    const activeSkus = new Set(
      rows.filter((row) => row.status === "active").map((row) => row.reference_sku).filter(Boolean),
    ).size;
    const finalMeta = {
      seller_nickname: seller.nickname,
      active_only: false,
      active_items: activeIds.length,
      active_skus: activeSkus,
      sold_items_window: recentSales.ids?.length || 0,
      sold_orders_read: recentSales.orders_read || 0,
      sold_orders_available: recentSales.orders_available || 0,
      sold_orders_partial: !!recentSales.partial,
      sold_window_days: recentSales.days || MARGIN_MAX_RANGE_DAYS,
      cost_linked_items: costLinkedIds.length,
      relevant_items: ids.length,
      price_history_rows: priceHistoryRows,
    };
    await updateRun(runId, {
      status: "completed",
      processed_items: ids.length,
      total_skus: totalSkus,
      no_sku_items: noSkuItems,
      finished_at: new Date(),
      meta: finalMeta,
    });
    await setJobProgress(job, 100);
    return {
      success: true,
      runId,
      total_items: ids.length,
      total_skus: totalSkus,
      active_items: activeIds.length,
      active_skus: activeSkus,
      sold_items_window: recentSales.ids?.length || 0,
      sold_window_days: recentSales.days || MARGIN_MAX_RANGE_DAYS,
      cost_linked_items: costLinkedIds.length,
      no_sku_items: noSkuItems,
      price_history_rows: priceHistoryRows,
    };
  } catch (error) {
    await updateRun(runId, {
      status: "failed",
      error: error?.message || String(error),
      finished_at: new Date(),
    });
    throw error;
  }
}

function initWorker() {
  if (workerStarted) return;
  workerStarted = true;
  const queue = getQueue();
  queue.process(async (job) => processSyncJob(job));
  queue.on("failed", (job, error) => {
    console.error(`[financeiro-ml-sync] Job ${job?.id} falhou:`, error?.message || error);
  });
  console.log("Worker financeiro-ml-sku-catalog-sync iniciado");
}

async function enqueue({ accountKey, mlCreds, userId }) {
  const queue = getQueue();
  const existing = await queue.getJobs(["waiting", "active", "delayed"], 0, 50);
  const same = existing.find((job) => String(job?.data?.accountKey || "") === String(accountKey || ""));
  if (same) return { success: true, job_id: String(same.id), already_running: true };

  const job = await queue.add(
    { accountKey: accountKey || "default", mlCreds: mlCreds || {}, userId: userId || null },
    { attempts: 1, removeOnComplete: false, removeOnFail: false },
  );
  return { success: true, job_id: String(job.id), already_running: false };
}

async function mapJob(job, state) {
  const result = job?.returnvalue || {};
  const progress = Number(await getJobProgress(job));
  let status = state;
  if (state === "waiting" || state === "delayed") status = "aguardando";
  if (state === "active") status = "processando";
  if (state === "completed") status = "concluido";
  if (state === "failed") status = "erro";
  return {
    id: String(job.id),
    status,
    progress: Number.isFinite(progress) ? progress : 0,
    completed: ["concluido", "erro"].includes(status),
    result,
    failedReason: job.failedReason || null,
  };
}

async function status(jobId, { accountKey }) {
  const queue = getQueue();
  const job = await queue.getJob(jobId);
  if (!job) return null;
  if (String(job.data?.accountKey || "") !== String(accountKey || "")) return null;
  const state = await job.getState().catch(() => "unknown");
  return mapJob(job, state);
}

module.exports = {
  initWorker,
  enqueue,
  status,
};
