"use strict";

const { withTenant } = require("../db");
const { audit } = require("../audit");
const { redactForStorage } = require("../redact");
const shopee = require("../integrations/shopee");
const { getConnection } = require("../integrations/tokenStore");
const { normalizeShopeeOrder } = require("./shopeeNormalization");

const RESOURCE = "shopee.orders";
const MAX_HISTORY_DAYS = 90;
const MAX_SLICE_DAYS = 15;
const MAX_PAGE_SIZE = 100;
const MAX_DETAIL_BATCH_SIZE = 50;
const MAX_PAGES = 10_000;

function syncError(message, code, statusCode = 400) { return Object.assign(new Error(message), { code, statusCode }); }
function safeError(error) {
  const code = String(error?.code || "shopee_sync_failed").toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 100);
  return `Shopee sync failed (${code || "shopee_sync_failed"}).`;
}
function isoDate(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || Number.isNaN(new Date(`${normalized}T00:00:00.000Z`).getTime())) {
    throw syncError(`${field} deve ser uma data ISO (AAAA-MM-DD).`, "shopee_sync_invalid_date");
  }
  return normalized;
}
function dateAt(value) { return new Date(`${value}T00:00:00.000Z`); }
function dateOnly(value) { return value.toISOString().slice(0, 10); }

function syncWindow({ from, to, checkpoint, now = new Date() }) {
  const end = isoDate(to, "to") || now.toISOString().slice(0, 10);
  const requestedStart = isoDate(from, "from");
  const endDate = dateAt(end);
  if (requestedStart) {
    const days = (endDate - dateAt(requestedStart)) / 86_400_000;
    if (days < 0 || days > MAX_HISTORY_DAYS) throw syncError(`A janela Shopee deve ter no maximo ${MAX_HISTORY_DAYS} dias.`, "shopee_sync_window_invalid");
    return { from: requestedStart, to: end, mode: "manual" };
  }
  const checkpointDate = checkpoint?.cursor?.maxModifiedAt || checkpoint?.cursor?.windowTo;
  if (checkpointDate) {
    const date = new Date(checkpointDate);
    if (!Number.isNaN(date.getTime())) {
      date.setUTCDate(date.getUTCDate() - 1);
      return { from: dateOnly(date), to: end, mode: "incremental" };
    }
  }
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - MAX_HISTORY_DAYS);
  return { from: dateOnly(start), to: end, mode: "historical" };
}

function syncSlices(window) {
  const end = dateAt(window.to);
  const slices = [];
  for (let start = dateAt(window.from); start <= end;) {
    const sliceEnd = new Date(start);
    sliceEnd.setUTCDate(sliceEnd.getUTCDate() + MAX_SLICE_DAYS - 1);
    if (sliceEnd > end) sliceEnd.setTime(end.getTime());
    slices.push({ from: dateOnly(start), to: dateOnly(sliceEnd) });
    start = new Date(sliceEnd);
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return slices;
}
function listResponse(data) {
  const body = data?.response || data || {};
  return { orders: Array.isArray(body.order_list) ? body.order_list : (Array.isArray(body.orders) ? body.orders : []), more: body.more === true || body.more === 1 || body.more === "true", cursor: body.next_cursor ?? body.nextCursor ?? "" };
}
function detailResponse(data) {
  const body = data?.response || data || {};
  return Array.isArray(body.order_list) ? body.order_list : (Array.isArray(body.orders) ? body.orders : []);
}
function chunks(values, size) { const result = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result; }

function createShopeeOrderSync(dependencies = {}) {
  const withTenantFn = dependencies.withTenant || dependencies.withTenantFn || withTenant;
  const auditFn = dependencies.audit || audit;
  const redactFn = dependencies.redactForStorage || redactForStorage;
  const getConnectionFn = dependencies.getConnection || dependencies.getConnectionFn || getConnection;
  const listOrdersFn = dependencies.listOrders || shopee.listOrders;
  const orderDetailFn = dependencies.orderDetail || shopee.orderDetail;
  const normalizeFn = dependencies.normalizeShopeeOrder || normalizeShopeeOrder;
  const clock = dependencies.clock || (() => new Date());

  async function checkpointFor(auth, connectionId) {
    return withTenantFn(auth.tenantId, auth.userId, async (client) => (await client.query("SELECT cursor,last_success_at FROM volt_price.sync_checkpoints WHERE connection_id=$1 AND resource=$2", [connectionId, RESOURCE])).rows[0] || null);
  }
  async function startRun(auth, connectionId, mode, filters) {
    try {
      return await withTenantFn(auth.tenantId, auth.userId, async (client) => (await client.query(
        `INSERT INTO volt_price.sync_runs(tenant_id,connection_id,resource,mode,filters,created_by)
         VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING id,started_at`,
        [auth.tenantId, connectionId, RESOURCE, mode, JSON.stringify(filters), auth.userId],
      )).rows[0]);
    } catch (error) {
      if (error.code === "23505") throw syncError("Ja existe uma sincronizacao Shopee em andamento para esta loja.", "sync_in_progress", 409);
      throw error;
    }
  }
  async function persistPage(auth, runId, normalizedOrders) {
    return withTenantFn(auth.tenantId, auth.userId, async (client) => {
      let upserted = 0;
      for (const order of normalizedOrders) {
        if (!order.sourceOrderId) continue;
        await client.query(
          `INSERT INTO volt_price.orders
            (tenant_id,source_channel,source_order_id,status,order_date,modified_at,total_amount,marketplace,marketplace_order_id,marketplace_account_id,marketplace_account_source,raw_data,normalized_data,reconciliation_status,match_confidence,match_reason,matched_at)
           VALUES($1,'shopee',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,CASE WHEN $13='matched' THEN now() ELSE NULL END)
           ON CONFLICT (tenant_id,source_channel,source_order_id) DO UPDATE SET
            status=EXCLUDED.status,order_date=EXCLUDED.order_date,modified_at=EXCLUDED.modified_at,total_amount=EXCLUDED.total_amount,
            marketplace=CASE WHEN volt_price.orders.match_reason='manual' THEN volt_price.orders.marketplace ELSE EXCLUDED.marketplace END,
            marketplace_order_id=CASE WHEN volt_price.orders.match_reason='manual' THEN volt_price.orders.marketplace_order_id ELSE EXCLUDED.marketplace_order_id END,
            marketplace_account_id=CASE WHEN volt_price.orders.match_reason='manual' THEN volt_price.orders.marketplace_account_id ELSE EXCLUDED.marketplace_account_id END,
            marketplace_account_source=CASE WHEN volt_price.orders.match_reason='manual' THEN 'manual' ELSE EXCLUDED.marketplace_account_source END,
            reconciliation_status=CASE WHEN volt_price.orders.match_reason='manual' THEN volt_price.orders.reconciliation_status ELSE EXCLUDED.reconciliation_status END,
            match_confidence=CASE WHEN volt_price.orders.match_reason='manual' THEN volt_price.orders.match_confidence ELSE EXCLUDED.match_confidence END,
            match_reason=CASE WHEN volt_price.orders.match_reason='manual' THEN volt_price.orders.match_reason ELSE EXCLUDED.match_reason END,
            matched_at=CASE WHEN volt_price.orders.match_reason='manual' THEN volt_price.orders.matched_at ELSE COALESCE(volt_price.orders.matched_at,now()) END,
            raw_data=EXCLUDED.raw_data,normalized_data=EXCLUDED.normalized_data,updated_at=now()`,
          [auth.tenantId, order.sourceOrderId, order.status, order.orderDate, order.modifiedAt, order.totalAmount, order.marketplace, order.marketplaceOrderId, order.marketplaceAccountId, order.marketplaceAccountSource, JSON.stringify(redactFn(order.raw)), JSON.stringify(order.normalizedData), order.reconciliationStatus, order.matchConfidence, order.matchReason],
        );
        upserted += 1;
      }
      await client.query("UPDATE volt_price.sync_runs SET pages=pages+1,records_seen=records_seen+$2,records_upserted=records_upserted+$3 WHERE id=$1", [runId, normalizedOrders.length, upserted]);
      return upserted;
    });
  }
  async function finishRun(auth, { runId, connectionId, watermark, totals, request }) {
    return withTenantFn(auth.tenantId, auth.userId, async (client) => {
      await client.query(`INSERT INTO volt_price.sync_checkpoints(tenant_id,connection_id,resource,cursor,last_success_at)
        VALUES($1,$2,$3,$4::jsonb,now()) ON CONFLICT(tenant_id,connection_id,resource)
        DO UPDATE SET cursor=EXCLUDED.cursor,last_success_at=now(),updated_at=now()`, [auth.tenantId, connectionId, RESOURCE, JSON.stringify(watermark)]);
      await client.query("UPDATE volt_price.sync_runs SET status='succeeded',finished_at=now() WHERE id=$1", [runId]);
      await client.query("UPDATE volt_price.integration_connections SET last_sync_at=now(),last_error=NULL,updated_at=now() WHERE id=$1", [connectionId]);
      await auditFn(client, { tenantId: auth.tenantId, actorUserId: auth.userId, action: "shopee.orders.sync", resourceType: "sync_run", resourceId: runId, metadata: totals, ip: request?.ip, userAgent: request?.get?.("user-agent") });
    });
  }
  async function failRun(auth, runId, connectionId, error) {
    const message = safeError(error);
    await withTenantFn(auth.tenantId, auth.userId, async (client) => {
      await client.query("UPDATE volt_price.sync_runs SET status='failed',error_code=$2,error_message=$3,finished_at=now() WHERE id=$1", [runId, String(error?.code || "shopee_sync_failed").slice(0, 100), message]);
      await client.query("UPDATE volt_price.integration_connections SET last_error=$2,updated_at=now() WHERE id=$1", [connectionId, message]);
    }).catch(() => {});
  }
  async function syncShopeeOrders(auth, options = {}, request = null) {
    const connectionId = String(options.connectionId || "").trim();
    if (!connectionId) throw syncError("connectionId da loja Shopee e obrigatorio.", "shopee_connection_required");
    const connection = await getConnectionFn(auth, "shopee", connectionId);
    if (!connection || String(connection.id) !== connectionId || String(connection.status || "").toLowerCase() !== "active") throw syncError("Loja Shopee nao conectada.", "shopee_not_connected", 409);
    const pageSize = Number(options.pageSize || 50);
    const detailBatchSize = Number(options.detailBatchSize || MAX_DETAIL_BATCH_SIZE);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw syncError(`pageSize deve estar entre 1 e ${MAX_PAGE_SIZE}.`, "shopee_sync_page_size_invalid");
    if (!Number.isInteger(detailBatchSize) || detailBatchSize < 1 || detailBatchSize > MAX_DETAIL_BATCH_SIZE) throw syncError(`detailBatchSize deve estar entre 1 e ${MAX_DETAIL_BATCH_SIZE}.`, "shopee_sync_detail_batch_invalid");
    const checkpoint = await checkpointFor(auth, connection.id);
    const window = syncWindow({ from: options.from, to: options.to, checkpoint, now: clock() });
    const slices = syncSlices(window);
    const timeRangeField = window.mode === "historical" ? "create_time" : "update_time";
    const filters = { from: window.from, to: window.to, pageSize, mode: window.mode, timeRangeField, slices: slices.length };
    const run = await startRun(auth, connection.id, window.mode, filters);
    let pages = 0; let totalSeen = 0; let totalSynced = 0;
    let maxModifiedAt = checkpoint?.cursor?.maxModifiedAt || null;
    try {
      for (const slice of slices) {
        let cursor = "";
        const seenCursors = new Set();
        while (true) {
          if (++pages > MAX_PAGES) throw syncError("Protecao de paginacao Shopee acionada.", "shopee_pagination_guard", 502);
          const data = await listOrdersFn(auth, { ...filters, ...slice, cursor, connectionId: connection.id });
          const listed = listResponse(data);
          const orderSns = [...new Set(listed.orders.map((value) => String(value?.order_sn || value?.orderSn || value || "").trim()).filter(Boolean))];
          totalSeen += orderSns.length;
          const details = [];
          for (const batch of chunks(orderSns, detailBatchSize)) details.push(...detailResponse(await orderDetailFn(auth, batch, connection.id)));
          const normalizedOrders = details.map((detail) => normalizeFn(detail, connection.external_account_id)).filter((order) => order.sourceOrderId);
          totalSynced += await persistPage(auth, run.id, normalizedOrders);
          for (const order of normalizedOrders) if (order.modifiedAt && (!maxModifiedAt || new Date(order.modifiedAt) > new Date(maxModifiedAt))) maxModifiedAt = order.modifiedAt;
          if (!listed.more) break;
          const nextCursor = String(listed.cursor || "").trim();
          if (!nextCursor || seenCursors.has(nextCursor)) throw syncError("Cursor Shopee repetido ou ausente.", "shopee_pagination_guard", 502);
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
      }
      const totals = { totalSeen, totalSynced, pages, slices: slices.length, mode: window.mode, from: window.from, to: window.to, shopId: String(connection.external_account_id) };
      await finishRun(auth, { runId: run.id, connectionId: connection.id, watermark: { maxModifiedAt, windowFrom: window.from, windowTo: window.to, timeRangeField }, totals, request });
      return { success: true, runId: run.id, ...totals };
    } catch (error) { await failRun(auth, run.id, connection.id, error); throw error; }
  }
  return { syncShopeeOrders, checkpointFor, safeError };
}

const defaultShopeeOrderSync = createShopeeOrderSync();
module.exports = { ...defaultShopeeOrderSync, createShopeeOrderSync, syncWindow, syncSlices, safeError, RESOURCE, MAX_HISTORY_DAYS, MAX_SLICE_DAYS, MAX_PAGE_SIZE, MAX_DETAIL_BATCH_SIZE };
