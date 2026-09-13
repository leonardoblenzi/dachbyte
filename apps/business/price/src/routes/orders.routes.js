"use strict";

const express = require("express");
const { authenticate, requirePasswordChangeComplete, requireCsrf } = require("../auth");
const { requirePermission } = require("../permissions");
const { withTenant } = require("../db");
const { audit } = require("../audit");
const { redactForStorage } = require("../redact");
const { syncTrayOrders } = require("../orders/traySync");
const { normalizeTrayOrder } = require("../orders/normalization");
const { validateMarketplaceLink } = require("../orders/marketplaceLink");
const tray = require("../integrations/tray");
const { syncShopeeOrders, RESOURCE: SHOPEE_SYNC_RESOURCE } = require("../orders/shopeeSync");
const { normalizeShopeeOrder } = require("../orders/shopeeNormalization");
const { resolveShopeeConnectionForOrder } = require("../orders/shopeeAccount");
const shopee = require("../integrations/shopee");

const router = express.Router();
router.use(authenticate, requirePasswordChangeComplete);

async function unlinkMarketplaceOrder(client, orderId) {
  return (await client.query(
    `UPDATE volt_price.orders
     SET marketplace=NULL,marketplace_order_id=NULL,marketplace_connection_id=NULL,
         marketplace_account_id=NULL,marketplace_account_source=NULL,reconciliation_status='unmatched',
         match_confidence=NULL,match_reason=NULL,matched_at=NULL,updated_at=now()
     WHERE id=$1
     RETURNING id,reconciliation_status,marketplace_account_id,marketplace_account_source`,
    [orderId],
  )).rows[0];
}

router.get("/", requirePermission("orders.read"), async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const filters = [];
    const values = [];

    if (req.query.status) {
      values.push(String(req.query.status));
      filters.push(`orders.status=$${values.length}`);
    }
    if (req.query.from) {
      values.push(String(req.query.from));
      filters.push(`orders.order_date >= $${values.length}::date`);
    }
    if (req.query.to) {
      values.push(String(req.query.to));
      filters.push(`orders.order_date <= $${values.length}::date`);
    }

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const data = await withTenant(req.vpAuth.tenantId, req.vpAuth.userId, async (client) => {
      const total = (await client.query(
        `SELECT count(*)::int count FROM volt_price.orders orders ${where}`,
        values,
      )).rows[0].count;
      const rows = (await client.query(
        `SELECT orders.id,orders.source_channel,orders.source_order_id,orders.status,orders.order_date,orders.modified_at,orders.total_amount,
                orders.marketplace,orders.marketplace_order_id,orders.marketplace_connection_id,
                connection.display_name AS marketplace_connection_display_name,
                connection.external_account_id AS marketplace_connection_external_account_id,
                orders.created_at,orders.updated_at
         FROM volt_price.orders
         LEFT JOIN volt_price.integration_connections connection ON connection.id=orders.marketplace_connection_id
         ${where}
         ORDER BY orders.order_date DESC NULLS LAST,orders.id DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset],
      )).rows;
      return { rows, total, page, limit };
    });

    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get("/sync/status", requirePermission("orders.read"), async (req, res, next) => {
  try {
    const data = await withTenant(req.vpAuth.tenantId, req.vpAuth.userId, async (client) => {
      const run = (await client.query(
        `SELECT id,status,mode,filters,pages,records_seen,records_upserted,error_code,error_message,
                started_at,finished_at
         FROM volt_price.sync_runs
         WHERE resource='tray.orders'
         ORDER BY started_at DESC
         LIMIT 1`,
      )).rows[0] || null;
      const checkpoint = (await client.query(
        `SELECT cursor,last_success_at,updated_at
         FROM volt_price.sync_checkpoints
         WHERE resource='tray.orders'
         ORDER BY updated_at DESC
         LIMIT 1`,
      )).rows[0] || null;
      return { run, checkpoint };
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.post("/sync/tray", requireCsrf, requirePermission("orders.sync"), async (req, res, next) => {
  try {
    res.json(await syncTrayOrders(req.vpAuth, req.body || {}, req));
  } catch (error) {
    next(error);
  }
});

router.get("/sync/shopee/status", requirePermission("orders.read"), async (req, res, next) => {
  try {
    const connectionId = String(req.query.connectionId || "").trim();
    if (!connectionId) throw Object.assign(new Error("connectionId da loja Shopee e obrigatorio."), { statusCode: 400, code: "shopee_connection_required" });
    const data = await withTenant(req.vpAuth.tenantId, req.vpAuth.userId, async (client) => {
      const run = (await client.query(
        `SELECT id,status,mode,filters,pages,records_seen,records_upserted,error_code,error_message,started_at,finished_at
         FROM volt_price.sync_runs WHERE resource=$1 AND connection_id=$2 ORDER BY started_at DESC LIMIT 1`,
        [SHOPEE_SYNC_RESOURCE, connectionId],
      )).rows[0] || null;
      const checkpoint = (await client.query(
        `SELECT cursor,last_success_at,updated_at FROM volt_price.sync_checkpoints
         WHERE resource=$1 AND connection_id=$2 ORDER BY updated_at DESC LIMIT 1`,
        [SHOPEE_SYNC_RESOURCE, connectionId],
      )).rows[0] || null;
      return { run, checkpoint };
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.post("/sync/shopee", requireCsrf, requirePermission("orders.sync"), async (req, res, next) => {
  try {
    res.json(await syncShopeeOrders(req.vpAuth, req.body || {}, req));
  } catch (error) {
    next(error);
  }
});

router.get("/unmatched", requirePermission("orders.read"), async (req, res, next) => {
  try {
    const rows = await withTenant(req.vpAuth.tenantId, req.vpAuth.userId, async (client) => (
      await client.query(
        `SELECT id,source_order_id,status,order_date,total_amount,marketplace,marketplace_order_id,
                reconciliation_status,match_reason,updated_at
         FROM volt_price.orders
         WHERE reconciliation_status IN ('unmatched','review')
         ORDER BY order_date DESC NULLS LAST,id DESC
         LIMIT 500`,
      )
    ).rows);
    res.json({ rows });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/hydrate-tray", requireCsrf, requirePermission("orders.sync"), async (req, res, next) => {
  try {
    const order = await withTenant(req.vpAuth.tenantId, req.vpAuth.userId, async (client) => (
      await client.query("SELECT * FROM volt_price.orders WHERE id=$1", [req.params.id])
    ).rows[0]);

    if (!order) throw Object.assign(new Error("Pedido nao encontrado."), { statusCode: 404 });

    const normalized = normalizeTrayOrder(
      await tray.getOrderComplete(req.vpAuth, order.source_order_id, req.body?.connectionId),
    );

    await withTenant(req.vpAuth.tenantId, req.vpAuth.userId, async (client) => client.query(
      `UPDATE volt_price.orders
       SET raw_data=$2::jsonb,
           normalized_data=$3::jsonb,
           marketplace=CASE WHEN match_reason='manual' THEN marketplace ELSE COALESCE($4,marketplace) END,
           marketplace_order_id=CASE WHEN match_reason='manual' THEN marketplace_order_id ELSE COALESCE($5,marketplace_order_id) END,
           reconciliation_status=CASE
             WHEN match_reason='manual' THEN reconciliation_status
             WHEN $6='matched' THEN 'matched'
             ELSE reconciliation_status
           END,
           match_confidence=CASE
             WHEN match_reason='manual' THEN match_confidence
             WHEN $6='matched' THEN $7
             ELSE match_confidence
           END,
           match_reason=CASE
             WHEN match_reason='manual' THEN match_reason
             WHEN $6='matched' THEN $8
             ELSE match_reason
           END,
           matched_at=CASE WHEN $6='matched' THEN COALESCE(matched_at,now()) ELSE matched_at END,
           updated_at=now()
       WHERE id=$1`,
      [
        order.id,
        JSON.stringify(redactForStorage(normalized.raw)),
        JSON.stringify(normalized.normalizedData),
        normalized.marketplace,
        normalized.marketplaceOrderId,
        normalized.reconciliationStatus,
        normalized.matchConfidence,
        normalized.matchReason,
      ],
    ));

    res.json({
      success: true,
      marketplace: normalized.marketplace,
      marketplaceOrderId: normalized.marketplaceOrderId,
      reconciliationStatus: normalized.reconciliationStatus,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/hydrate-shopee", requireCsrf, requirePermission("orders.sync"), async (req, res, next) => {
  try {
    const { order, connection } = await resolveShopeeConnectionForOrder(req.vpAuth, req.params.id);
    const response = await shopee.orderDetail(req.vpAuth, [order.marketplace_order_id], connection.id);
    const details = response?.response?.order_list || response?.order_list || [];
    const detail = details.find((value) => String(value?.order_sn || value?.orderSn) === String(order.marketplace_order_id));
    if (!detail) throw Object.assign(new Error("Shopee nao retornou o pedido solicitado."), { statusCode: 502, code: "shopee_order_detail_missing" });
    const normalized = normalizeShopeeOrder(detail, connection.external_account_id);
    await withTenant(req.vpAuth.tenantId, req.vpAuth.userId, async (client) => client.query(
      `UPDATE volt_price.orders
       SET status=$2,order_date=$3,modified_at=$4,total_amount=$5,raw_data=$6::jsonb,normalized_data=$7::jsonb,
           marketplace=CASE WHEN match_reason='manual' THEN marketplace ELSE $8 END,
           marketplace_order_id=CASE WHEN match_reason='manual' THEN marketplace_order_id ELSE $9 END,
           marketplace_account_id=CASE WHEN match_reason='manual' THEN marketplace_account_id ELSE $10 END,
           marketplace_account_source=CASE WHEN match_reason='manual' THEN 'manual' ELSE $11 END,
           reconciliation_status=CASE WHEN match_reason='manual' THEN reconciliation_status ELSE 'matched' END,
           match_confidence=CASE WHEN match_reason='manual' THEN match_confidence ELSE 1 END,
           match_reason=CASE WHEN match_reason='manual' THEN match_reason ELSE 'shopee_sync' END,
           matched_at=CASE WHEN match_reason='manual' THEN matched_at ELSE COALESCE(matched_at,now()) END,
           updated_at=now()
       WHERE id=$1`,
      [order.id, normalized.status, normalized.orderDate, normalized.modifiedAt, normalized.totalAmount,
        JSON.stringify(redactForStorage(normalized.raw)), JSON.stringify(normalized.normalizedData),
        normalized.marketplace, normalized.marketplaceOrderId, normalized.marketplaceAccountId, normalized.marketplaceAccountSource],
    ));
    res.json({ success: true, marketplace: "shopee", marketplaceOrderId: normalized.marketplaceOrderId, shopId: normalized.marketplaceAccountId });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id/link-marketplace", requireCsrf, requirePermission("orders.sync"), async (req, res, next) => {
  try {
    const { marketplace, externalOrderId, connectionId } = validateMarketplaceLink(req.body);

    const result = await withTenant(req.vpAuth.tenantId, req.vpAuth.userId, async (client) => {
      const before = (await client.query(
        `SELECT id,marketplace,marketplace_order_id,marketplace_connection_id,reconciliation_status,match_reason
         FROM volt_price.orders WHERE id=$1`,
        [req.params.id],
      )).rows[0];

      if (!before) throw Object.assign(new Error("Pedido nao encontrado."), { statusCode: 404 });

      const connection = (await client.query(
        `SELECT id FROM volt_price.integration_connections
         WHERE id=$1 AND channel=$2 AND status='active'`,
        [connectionId, marketplace],
      )).rows[0];
      if (!connection) {
        throw Object.assign(new Error("Conta vinculada nao encontrada, inativa ou de outro marketplace."), { statusCode: 400 });
      }

      const after = (await client.query(
        `UPDATE volt_price.orders
         SET marketplace=$2,marketplace_order_id=$3,reconciliation_status='matched',
             marketplace_connection_id=$4,match_confidence=1,match_reason='manual',matched_at=now(),updated_at=now()
         WHERE id=$1
         RETURNING id,marketplace,marketplace_order_id,marketplace_connection_id,reconciliation_status,match_confidence,match_reason`,
        [req.params.id, marketplace, externalOrderId, connection.id],
      )).rows[0];

      await audit(client, {
        tenantId: req.vpAuth.tenantId,
        actorUserId: req.vpAuth.userId,
        action: "order.marketplace.link",
        resourceType: "order",
        resourceId: String(req.params.id),
        before,
        after,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });
      return after;
    });

    res.json({ success: true, order: result });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id/link-marketplace", requireCsrf, requirePermission("orders.sync"), async (req, res, next) => {
  try {
    const result = await withTenant(req.vpAuth.tenantId, req.vpAuth.userId, async (client) => {
      const before = (await client.query(
        `SELECT id,marketplace,marketplace_order_id,marketplace_connection_id,reconciliation_status,match_reason
         FROM volt_price.orders WHERE id=$1`,
        [req.params.id],
      )).rows[0];

      if (!before) throw Object.assign(new Error("Pedido nao encontrado."), { statusCode: 404 });

      const after = await unlinkMarketplaceOrder(client, req.params.id);

      await audit(client, {
        tenantId: req.vpAuth.tenantId,
        actorUserId: req.vpAuth.userId,
        action: "order.marketplace.unlink",
        resourceType: "order",
        resourceId: String(req.params.id),
        before,
        after,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });
      return after;
    });

    res.json({ success: true, order: result });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", requirePermission("orders.read"), async (req, res, next) => {
  try {
    const row = await withTenant(req.vpAuth.tenantId, req.vpAuth.userId, async (client) => (
      await client.query("SELECT * FROM volt_price.orders WHERE id=$1", [req.params.id])
    ).rows[0]);

    if (!row) throw Object.assign(new Error("Pedido nao encontrado."), { statusCode: 404 });
    res.json({ order: row });
  } catch (error) {
    next(error);
  }
});

module.exports = { ordersRouter: router, unlinkMarketplaceOrder };
