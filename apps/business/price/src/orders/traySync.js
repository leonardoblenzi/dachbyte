"use strict";

const { withTenant } = require("../db");
const { audit } = require("../audit");
const { redactForStorage } = require("../redact");
const tray = require("../integrations/tray");
const { getConnection } = require("../integrations/tokenStore");
const { normalizeTrayOrder, syncWindow } = require("./normalization");

const RESOURCE = "tray.orders";

function safeError(error) {
  return String(error?.message || "Falha desconhecida").replace(/https?:\/\/\S+/gi, "[URL]").slice(0, 1000);
}

async function checkpointFor(auth, connectionId) {
  return withTenant(auth.tenantId, auth.userId, async (client) => (await client.query(
    "SELECT cursor,last_success_at FROM volt_price.sync_checkpoints WHERE connection_id=$1 AND resource=$2",
    [connectionId, RESOURCE],
  )).rows[0] || null);
}

async function startRun(auth, connectionId, mode, filters) {
  try {
    return await withTenant(auth.tenantId, auth.userId, async (client) => (await client.query(
      `INSERT INTO volt_price.sync_runs(tenant_id,connection_id,resource,mode,filters,created_by)
       VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING id,started_at`,
      [auth.tenantId, connectionId, RESOURCE, mode, JSON.stringify(filters), auth.userId],
    )).rows[0]);
  } catch (error) {
    if (error.code === "23505") throw Object.assign(new Error("Ja existe uma sincronizacao Tray em andamento."), { statusCode: 409, code: "sync_in_progress" });
    throw error;
  }
}

async function persistPage(auth, runId, normalizedOrders) {
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    let upserted = 0;
    for (const order of normalizedOrders) {
      if (!order.sourceOrderId) continue;
      await client.query(
        `INSERT INTO volt_price.orders
          (tenant_id,source_channel,source_order_id,status,order_date,modified_at,total_amount,marketplace,marketplace_order_id,marketplace_account_id,marketplace_account_source,raw_data,normalized_data,reconciliation_status,match_confidence,match_reason,matched_at)
         VALUES($1,'tray',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,CASE WHEN $13='matched' THEN now() ELSE NULL END)
         ON CONFLICT (tenant_id,source_channel,source_order_id) DO UPDATE SET
          status=EXCLUDED.status,order_date=EXCLUDED.order_date,modified_at=EXCLUDED.modified_at,total_amount=EXCLUDED.total_amount,
          marketplace=CASE WHEN volt_price.orders.match_reason='manual' THEN volt_price.orders.marketplace ELSE COALESCE(EXCLUDED.marketplace,volt_price.orders.marketplace) END,
          marketplace_order_id=CASE WHEN volt_price.orders.match_reason='manual' THEN volt_price.orders.marketplace_order_id ELSE COALESCE(EXCLUDED.marketplace_order_id,volt_price.orders.marketplace_order_id) END,
          marketplace_account_id=CASE WHEN volt_price.orders.match_reason='manual' THEN volt_price.orders.marketplace_account_id ELSE COALESCE(EXCLUDED.marketplace_account_id,volt_price.orders.marketplace_account_id) END,
          marketplace_account_source=CASE WHEN volt_price.orders.match_reason='manual' THEN 'manual' ELSE COALESCE(EXCLUDED.marketplace_account_source,volt_price.orders.marketplace_account_source) END,
          reconciliation_status=CASE WHEN volt_price.orders.match_reason='manual' THEN volt_price.orders.reconciliation_status WHEN EXCLUDED.reconciliation_status='matched' THEN 'matched' ELSE volt_price.orders.reconciliation_status END,
          match_confidence=CASE WHEN volt_price.orders.match_reason='manual' THEN volt_price.orders.match_confidence WHEN EXCLUDED.reconciliation_status='matched' THEN EXCLUDED.match_confidence ELSE volt_price.orders.match_confidence END,
          match_reason=CASE WHEN volt_price.orders.match_reason='manual' THEN volt_price.orders.match_reason WHEN EXCLUDED.reconciliation_status='matched' THEN EXCLUDED.match_reason ELSE volt_price.orders.match_reason END,
          matched_at=CASE WHEN volt_price.orders.match_reason='manual' THEN volt_price.orders.matched_at WHEN EXCLUDED.reconciliation_status='matched' THEN COALESCE(volt_price.orders.matched_at,now()) ELSE volt_price.orders.matched_at END,
          raw_data=EXCLUDED.raw_data,normalized_data=EXCLUDED.normalized_data,updated_at=now()`,
        [auth.tenantId, order.sourceOrderId, order.status, order.orderDate, order.modifiedAt, order.totalAmount,
          order.marketplace, order.marketplaceOrderId, order.marketplaceAccountId, order.marketplaceAccountSource,
          JSON.stringify(redactForStorage(order.raw)), JSON.stringify(order.normalizedData), order.reconciliationStatus,
          order.matchConfidence, order.matchReason],
      );
      upserted += 1;
    }
    await client.query(
      "UPDATE volt_price.sync_runs SET pages=pages+1,records_seen=records_seen+$2,records_upserted=records_upserted+$3 WHERE id=$1",
      [runId, normalizedOrders.length, upserted],
    );
    return upserted;
  });
}

async function finishRun(auth, { runId, connectionId, cursor, totals, request }) {
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    await client.query(
      `INSERT INTO volt_price.sync_checkpoints(tenant_id,connection_id,resource,cursor,last_success_at)
       VALUES($1,$2,$3,$4::jsonb,now())
       ON CONFLICT(tenant_id,connection_id,resource) DO UPDATE SET cursor=EXCLUDED.cursor,last_success_at=now(),updated_at=now()`,
      [auth.tenantId, connectionId, RESOURCE, JSON.stringify(cursor)],
    );
    await client.query("UPDATE volt_price.sync_runs SET status='succeeded',finished_at=now() WHERE id=$1", [runId]);
    await client.query("UPDATE volt_price.integration_connections SET last_sync_at=now(),last_error=NULL,updated_at=now() WHERE id=$1", [connectionId]);
    await audit(client, { tenantId: auth.tenantId, actorUserId: auth.userId, action: "tray.orders.sync", resourceType: "sync_run", resourceId: runId, metadata: totals, ip: request?.ip, userAgent: request?.get?.("user-agent") });
  });
}

async function failRun(auth, runId, connectionId, error) {
  const message = safeError(error);
  await withTenant(auth.tenantId, auth.userId, async (client) => {
    await client.query("UPDATE volt_price.sync_runs SET status='failed',error_code=$2,error_message=$3,finished_at=now() WHERE id=$1", [runId, String(error?.code || "sync_failed").slice(0, 100), message]);
    await client.query("UPDATE volt_price.integration_connections SET last_error=$2,updated_at=now() WHERE id=$1", [connectionId, message]);
  }).catch(() => {});
}

async function syncTrayOrders(auth, options = {}, request = null) {
  const connection = await getConnection(auth, "tray", options.connectionId || null);
  if (!connection) throw Object.assign(new Error("Tray nao conectado."), { statusCode: 409, code: "tray_not_connected" });
  const checkpoint = await checkpointFor(auth, connection.id);
  const window = syncWindow({ from: options.from, to: options.to, checkpoint });
  const filters = { status: options.status || null, from: window.from, to: window.to };
  const run = await startRun(auth, connection.id, window.mode, filters);
  let page = 1;
  let totalSeen = 0;
  let totalSynced = 0;
  let maxModifiedAt = checkpoint?.cursor?.maxModifiedAt || null;
  try {
    while (true) {
      const data = await tray.listOrders(auth, { ...filters, page, limit: 50, connectionId: connection.id });
      const rawOrders = data.Orders || data.orders || [];
      const normalizedOrders = rawOrders.map(normalizeTrayOrder);
      totalSeen += normalizedOrders.length;
      totalSynced += await persistPage(auth, run.id, normalizedOrders);
      for (const order of normalizedOrders) {
        if (order.modifiedAt && (!maxModifiedAt || new Date(order.modifiedAt) > new Date(maxModifiedAt))) maxModifiedAt = order.modifiedAt;
      }
      const paging = data.paging || {};
      const maxPage = Math.max(1, Math.ceil(Number(paging.total || rawOrders.length) / Number(paging.limit || 50)));
      if (!rawOrders.length || page >= maxPage) break;
      page += 1;
      if (page > 10000) throw Object.assign(new Error("Protecao de paginacao Tray acionada."), { code: "tray_pagination_guard" });
    }
    const totals = { totalSeen, totalSynced, pages: page, mode: window.mode, from: window.from, to: window.to };
    await finishRun(auth, { runId: run.id, connectionId: connection.id, cursor: { maxModifiedAt, windowFrom: window.from, windowTo: window.to }, totals, request });
    return { success: true, runId: run.id, ...totals };
  } catch (error) {
    await failRun(auth, run.id, connection.id, error);
    throw error;
  }
}

module.exports = { syncTrayOrders, safeError, RESOURCE };
