"use strict";

const { query, queryOne, withClient } = require("../config/postgres");

const CURRENT_PRICE_PROMOTION_STATUSES = Object.freeze(["ongoing"]);
const CURRENT_PRICE_PROMOTION_STATUS_SQL = CURRENT_PRICE_PROMOTION_STATUSES.map((status) => `'${status}'`).join(", ");
// Shopee uses NORMAL for published listings. ACTIVE is accepted for legacy/webhook
// records that have already been normalized by older synchronizations.
const PRICING_ACTIVE_PRODUCT_STATUSES = Object.freeze(["NORMAL", "ACTIVE"]);
const PRICING_ACTIVE_PRODUCT_STATUS_SQL = PRICING_ACTIVE_PRODUCT_STATUSES.map((status) => `'${status}'`).join(", ");

function asNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asBigIntString(value) {
  return value == null ? null : String(value);
}

function toPriceCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number * 100)) : 0;
}

function toProductKey(productId, modelId) {
  return `${productId}:${modelId == null || modelId === "" ? 0 : modelId}`;
}

function mapProductRow(row) {
  return {
    key: toProductKey(row.product_id, row.model_id),
    productId: asNumber(row.product_id),
    itemId: asBigIntString(row.item_id),
    modelId: row.model_id == null ? null : asBigIntString(row.model_id),
    title: row.title || "Produto sem nome",
    sku: row.sku || null,
    status: row.status || null,
    imageUrl: row.image_url || null,
    costCents: asNumber(row.cost_cents, 0),
    currentPriceCents: toPriceCents(row.current_price),
    activePromotionPriceCents: asNumber(row.active_promotion_price_cents),
    hasActiveCampaign: Boolean(row.has_active_campaign),
    // Separate from hasActiveCampaign, which remains the discount-campaign signal.
    giftCampaign: row.gift_campaign_id ? {
      id: String(row.gift_campaign_id),
      name: row.gift_campaign_name || "Campanha de brinde",
      status: row.gift_campaign_status || null,
      minSpendCents: asNumber(row.gift_campaign_min_spend_cents, 0),
      giftProvisionCents: asNumber(row.gift_campaign_provision_cents, 0),
      startsAt: row.gift_campaign_starts_at || null,
      endsAt: row.gift_campaign_ends_at || null,
    } : null,
  };
}

function buildProductFilters({ shopId, q = "", withoutCost = false, minPriceCents = null, maxPriceCents = null, productKey = "" } = {}) {
  const params = [Number(shopId)];
  const clauses = [
    'p."shopId" = $1',
    `UPPER(TRIM(COALESCE(p.status, ''))) IN (${PRICING_ACTIVE_PRODUCT_STATUS_SQL})`,
  ];
  const search = String(q || "").trim();
  if (search) {
    params.push(`%${search}%`);
    const token = `$${params.length}`;
    clauses.push(`(
      CAST(p."itemId" AS TEXT) ILIKE ${token}
      OR COALESCE(p.title, '') ILIKE ${token}
      OR COALESCE(p."itemSku", '') ILIKE ${token}
      OR EXISTS (SELECT 1 FROM "ProductModel" search_model WHERE search_model."productId" = p.id AND (CAST(search_model."modelId" AS TEXT) ILIKE ${token} OR COALESCE(search_model.sku, '') ILIKE ${token}))
    )`);
  }
  if (withoutCost) clauses.push('COALESCE(p."costCents", 0) <= 0');
  if (String(productKey || "").trim()) {
    params.push(String(productKey).trim());
    clauses.push(`CONCAT(p.id::text, ':', COALESCE(pm."modelId"::text, '0')) = $${params.length}`);
  }
  if (minPriceCents != null && minPriceCents !== "" && Number.isFinite(Number(minPriceCents))) {
    params.push(Math.max(0, Math.round(Number(minPriceCents))));
    clauses.push(`ROUND(COALESCE(p."priceMin", 0)::numeric * 100) >= $${params.length}`);
  }
  if (maxPriceCents != null && maxPriceCents !== "" && Number.isFinite(Number(maxPriceCents))) {
    params.push(Math.max(0, Math.round(Number(maxPriceCents))));
    clauses.push(`ROUND(COALESCE(p."priceMin", 0)::numeric * 100) <= $${params.length}`);
  }
  return { params, whereSql: clauses.join(" AND ") };
}

async function listPricingProducts(filters = {}) {
  const { params, whereSql } = buildProductFilters(filters);
  const result = await query(
    `
      SELECT
        p.id AS product_id,
        p."itemId" AS item_id,
        pm."modelId" AS model_id,
        p.title,
        COALESCE(NULLIF(pm.sku, ''), NULLIF(p."itemSku", '')) AS sku,
        p.status,
        p."costCents" AS cost_cents,
        COALESCE(pm.price, p."priceMin", 0) AS current_price,
        (
          SELECT MIN(COALESCE(di."modelPromotionPrice", di."promotionPrice"))
          FROM "DiscountItem" di
          INNER JOIN "DiscountCampaign" dc ON dc.id = di."campaignId"
          WHERE dc."shopId" = p."shopId"
            AND LOWER(TRIM(COALESCE(dc.status, ''))) IN (${CURRENT_PRICE_PROMOTION_STATUS_SQL})
            AND di."itemId" = p."itemId"
            AND (di."modelId" IS NULL OR di."modelId" = pm."modelId")
        ) AS active_promotion_price_cents,
        EXISTS (
          SELECT 1
          FROM "DiscountItem" di
          INNER JOIN "DiscountCampaign" dc ON dc.id = di."campaignId"
          WHERE dc."shopId" = p."shopId"
            AND LOWER(TRIM(COALESCE(dc.status, ''))) IN ('upcoming', 'ongoing')
            AND di."itemId" = p."itemId"
            AND (di."modelId" IS NULL OR di."modelId" = pm."modelId")
        ) AS has_active_campaign,
        active_gift_campaign.id AS gift_campaign_id,
        active_gift_campaign.name AS gift_campaign_name,
        active_gift_campaign.status AS gift_campaign_status,
        active_gift_campaign."minSpendCents" AS gift_campaign_min_spend_cents,
        active_gift_campaign.gift_provision_cents AS gift_campaign_provision_cents,
        active_gift_campaign."startAt" AS gift_campaign_starts_at,
        active_gift_campaign."endAt" AS gift_campaign_ends_at,
        (
          SELECT pi.url FROM "ProductImage" pi
          WHERE pi."productId" = p.id
          ORDER BY pi.id ASC LIMIT 1
        ) AS image_url
      FROM "Product" p
      LEFT JOIN "ProductModel" pm ON pm."productId" = p.id
      LEFT JOIN LATERAL (
        SELECT
          gc.id,
          gc.name,
          gc.status,
          gc."minSpendCents",
          gc."startAt",
          gc."endAt",
          COALESCE(MAX(gcgi."costCents" * gcgi.quantity), 0)::integer AS gift_provision_cents
        FROM "GiftCampaign" gc
        INNER JOIN "GiftCampaignMainItem" gcmi
          ON gcmi."campaignId" = gc.id
          AND gcmi."shopId" = gc."shopId"
        LEFT JOIN "GiftCampaignGiftItem" gcgi
          ON gcgi."campaignId" = gc.id
          AND gcgi."shopId" = gc."shopId"
        WHERE gc."shopId" = p."shopId"
          AND gc.status = 'published'
          AND NOW() BETWEEN gc."startAt" AND gc."endAt"
          AND gcmi."productId" = p.id
          AND (gcmi."modelId" IS NULL OR gcmi."modelId" = pm."modelId")
        GROUP BY gc.id, gc.name, gc.status, gc."minSpendCents", gc."startAt", gc."endAt"
        ORDER BY gc."startAt" ASC, gc."createdAt" ASC
        LIMIT 1
      ) active_gift_campaign ON TRUE
      WHERE ${whereSql}
      ORDER BY COALESCE(p.title, '') ASC, p.id ASC, pm."modelId" ASC NULLS FIRST
    `,
    params,
  );
  return result.rows.map(mapProductRow);
}

async function getPricingRowsByKeys({ shopId, keys = [] }) {
  const wanted = Array.from(new Set((Array.isArray(keys) ? keys : []).map(String))).filter(Boolean);
  if (!wanted.length) return [];
  const rows = await listPricingProducts({ shopId });
  const selected = new Set(wanted);
  return rows.filter((row) => selected.has(row.key));
}

async function getPricingRowByKey({ shopId, key }) {
  const rows = await listPricingProducts({ shopId, productKey: key });
  return rows[0] || null;
}

async function getActivePricingKeys({ shopId, keys = [] }) {
  const wanted = Array.from(new Set((Array.isArray(keys) ? keys : []).map(String))).filter(Boolean);
  if (!wanted.length) return new Set();
  const result = await query(
    `
      SELECT p.id AS product_id, pm."modelId" AS model_id
      FROM "Product" p
      LEFT JOIN "ProductModel" pm ON pm."productId" = p.id
      WHERE p."shopId" = $1
        AND UPPER(TRIM(COALESCE(p.status, ''))) IN (${PRICING_ACTIVE_PRODUCT_STATUS_SQL})
        AND CONCAT(p.id::text, ':', COALESCE(pm."modelId"::text, '0')) = ANY($2::text[])
    `,
    [Number(shopId), wanted],
  );
  return new Set(result.rows.map((row) => toProductKey(row.product_id, row.model_id)));
}

async function getPricingSettings(shopId) {
  return queryOne(
    `SELECT settings."shopId" AS shop_id, settings.version, settings.config,
            settings."applicationEnabled" AS application_enabled, settings."updatedAt" AS updated_at,
            shop."taxRate" AS shop_tax_rate
     FROM "Shop" shop
     LEFT JOIN "PricingV6Setting" settings ON settings."shopId" = shop.id
     WHERE shop.id = $1
     LIMIT 1`,
    [Number(shopId)],
  );
}

async function upsertPricingSettings({ shopId, config, applicationEnabled, userId }) {
  return queryOne(
    `
      INSERT INTO "PricingV6Setting" ("shopId", version, config, "applicationEnabled", "createdByUserId", "updatedAt")
      VALUES ($1, 1, $2::jsonb, $3, $4, NOW())
      ON CONFLICT ("shopId") DO UPDATE SET
        version = "PricingV6Setting".version + 1,
        config = EXCLUDED.config,
        "applicationEnabled" = EXCLUDED."applicationEnabled",
        "updatedAt" = NOW()
      RETURNING "shopId" AS shop_id, version, config, "applicationEnabled" AS application_enabled, "updatedAt" AS updated_at
    `,
    [Number(shopId), JSON.stringify(config || {}), Boolean(applicationEnabled), userId == null ? null : Number(userId)],
  );
}

async function createSnapshot({ id, shopId, settingsVersion, selection, result, userId, expiresAt, requestKey }) {
  await query(
    `INSERT INTO "PricingV6Snapshot" (id, "shopId", "settingsVersion", selection, result, "createdByUserId", "expiresAt", "requestKey")
     VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
    [id, Number(shopId), Number(settingsVersion), JSON.stringify(selection), JSON.stringify(result), userId == null ? null : Number(userId), expiresAt, String(requestKey || "")],
  );
}

async function findReusableSnapshot({ shopId, settingsVersion, requestKey }) {
  return queryOne(
    `SELECT id, result, "createdAt" AS created_at
     FROM "PricingV6Snapshot"
     WHERE "shopId" = $1
       AND "settingsVersion" = $2
       AND "requestKey" = $3
       AND "invalidatedAt" IS NULL
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    [Number(shopId), Number(settingsVersion), String(requestKey)],
  );
}

async function invalidateReusableSnapshots({ shopId, requestKey }) {
  await query(
    `UPDATE "PricingV6Snapshot"
     SET "invalidatedAt" = NOW()
     WHERE "shopId" = $1 AND "requestKey" = $2 AND "invalidatedAt" IS NULL`,
    [Number(shopId), String(requestKey)],
  );
}


async function invalidateAllReusableSnapshots({ shopId }) {
  await query(
    `UPDATE "PricingV6Snapshot"
     SET "invalidatedAt" = NOW()
     WHERE "shopId" = $1 AND "invalidatedAt" IS NULL`,
    [Number(shopId)],
  );
}
async function getSnapshot({ id, shopId }) {
  return queryOne(
    `SELECT id, "shopId" AS shop_id, "settingsVersion" AS settings_version, selection, result, "createdAt" AS created_at, "expiresAt" AS expires_at
     FROM "PricingV6Snapshot" WHERE id = $1::uuid AND "shopId" = $2 LIMIT 1`,
    [id, Number(shopId)],
  );
}

async function createPricingJob({ id, shopId, snapshotId, conflictPolicy, idempotencyKey, userId, summary, items }) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const inserted = await client.query(
        `INSERT INTO "PricingV6Job" (id, "shopId", "snapshotId", state, "conflictPolicy", "idempotencyKey", "requestedByUserId", summary)
         VALUES ($1::uuid, $2, $3::uuid, 'awaiting_confirmation', $4, $5, $6, $7::jsonb)
         ON CONFLICT ("idempotencyKey") DO NOTHING
         RETURNING id`,
        [id, Number(shopId), snapshotId, conflictPolicy, idempotencyKey, userId == null ? null : Number(userId), JSON.stringify(summary || {})],
      );
      if (!inserted.rowCount) {
        const existing = await client.query(
          `SELECT id FROM "PricingV6Job"
           WHERE "shopId" = $1 AND "idempotencyKey" = $2
           LIMIT 1`,
          [Number(shopId), idempotencyKey],
        );
        if (!existing.rowCount) throw new Error("Job de precificação duplicado não pôde ser recuperado.");
        await client.query("COMMIT");
        return { id: existing.rows[0].id, created: false };
      }
      for (const item of items) {
        await client.query(
          `INSERT INTO "PricingV6JobItem" ("jobId", "productId", "itemId", "modelId", title, sku, "previousPriceCents", "recommendedPriceCents", "fullPriceCents", "marginRate", state)
           VALUES ($1::uuid, $2, $3::bigint, $4::bigint, $5, $6, $7, $8, $9, $10, $11)`,
          [id, item.productId || null, item.itemId, item.modelId || null, item.title || null, item.sku || null, item.currentPriceCents || null, item.recommendedPriceCents || null, item.fullPriceCents || null, item.marginRate || null, item.state || "pending"],
        );
      }
      await client.query("COMMIT");
      return { id, created: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

function mapJob(row) {
  return {
    id: row.id,
    shopId: asNumber(row.shop_id),
    snapshotId: row.snapshot_id,
    state: row.state,
    conflictPolicy: row.conflict_policy,
    progress: row.progress || {},
    summary: row.summary || {},
    errorMessage: row.error_message || null,
    cancelRequestedAt: row.cancel_requested_at || null,
    queuedAt: row.queued_at || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    createdAt: row.created_at || null,
  };
}

async function getPricingJob({ id, shopId, includeItems = false }) {
  const hasShopScope = Number.isFinite(Number(shopId));
  const row = await queryOne(
    `SELECT id, "shopId" AS shop_id, "snapshotId" AS snapshot_id, state, "conflictPolicy" AS conflict_policy, progress, summary,
            "errorMessage" AS error_message, "cancelRequestedAt" AS cancel_requested_at, "queuedAt" AS queued_at,
            "startedAt" AS started_at, "finishedAt" AS finished_at, "createdAt" AS created_at
     FROM "PricingV6Job" WHERE id = $1::uuid ${hasShopScope ? 'AND "shopId" = $2' : ""} LIMIT 1`,
    hasShopScope ? [id, Number(shopId)] : [id],
  );
  if (!row) return null;
  const job = mapJob(row);
  if (includeItems) {
    const items = await query(
      `SELECT id, "productId" AS product_id, "itemId" AS item_id, "modelId" AS model_id, title, sku, "previousPriceCents" AS previous_price_cents,
              "recommendedPriceCents" AS recommended_price_cents, "fullPriceCents" AS full_price_cents, "marginRate" AS margin_rate,
              state, "shopeeDiscountId" AS shopee_discount_id, "responsePayload" AS response_payload, "errorMessage" AS error_message
       FROM "PricingV6JobItem" WHERE "jobId" = $1::uuid ORDER BY id ASC`,
      [id],
    );
    job.items = items.rows.map((item) => ({
      id: asNumber(item.id), productId: asNumber(item.product_id), itemId: asBigIntString(item.item_id), modelId: asBigIntString(item.model_id),
      title: item.title || null, sku: item.sku || null, previousPriceCents: asNumber(item.previous_price_cents), recommendedPriceCents: asNumber(item.recommended_price_cents),
      fullPriceCents: asNumber(item.full_price_cents), marginRate: asNumber(item.margin_rate), state: item.state,
      shopeeDiscountId: asBigIntString(item.shopee_discount_id), responsePayload: item.response_payload || null, errorMessage: item.error_message || null,
    }));
  }
  return job;
}

async function listPricingJobs({ shopId, limit = 12 }) {
  const result = await query(
    `SELECT id, "shopId" AS shop_id, "snapshotId" AS snapshot_id, state, "conflictPolicy" AS conflict_policy, progress, summary,
            "errorMessage" AS error_message, "cancelRequestedAt" AS cancel_requested_at, "queuedAt" AS queued_at,
            "startedAt" AS started_at, "finishedAt" AS finished_at, "createdAt" AS created_at
     FROM "PricingV6Job" WHERE "shopId" = $1 ORDER BY "createdAt" DESC LIMIT $2`,
    [Number(shopId), Math.max(1, Math.min(Number(limit) || 12, 100))],
  );
  return result.rows.map(mapJob);
}

async function updatePricingJob({ id, shopId, state, progress, summary, errorMessage, queuedAt, startedAt, finishedAt, cancelRequestedAt }) {
  const fields = [];
  const params = [];
  const add = (sql, value) => { params.push(value); fields.push(`${sql} = $${params.length}`); };
  if (state !== undefined) add("state", state);
  if (progress !== undefined) add("progress", JSON.stringify(progress || {}));
  if (summary !== undefined) add("summary", JSON.stringify(summary || {}));
  if (errorMessage !== undefined) add('"errorMessage"', errorMessage);
  if (queuedAt !== undefined) add('"queuedAt"', queuedAt);
  if (startedAt !== undefined) add('"startedAt"', startedAt);
  if (finishedAt !== undefined) add('"finishedAt"', finishedAt);
  if (cancelRequestedAt !== undefined) add('"cancelRequestedAt"', cancelRequestedAt);
  if (!fields.length) return false;
  fields.push('"updatedAt" = NOW()');
  params.push(id, Number(shopId));
  const row = await queryOne(`UPDATE "PricingV6Job" SET ${fields.join(", ")} WHERE id = $${params.length - 1}::uuid AND "shopId" = $${params.length} RETURNING id`, params);
  return Boolean(row);
}

async function updateJobItem({ id, state, shopeeDiscountId, responsePayload, errorMessage }) {
  const fields = [];
  const params = [];
  const add = (sql, value) => { params.push(value); fields.push(`${sql} = $${params.length}`); };
  if (state !== undefined) add("state", state);
  if (shopeeDiscountId !== undefined) add('"shopeeDiscountId"', shopeeDiscountId);
  if (responsePayload !== undefined) add('"responsePayload"', JSON.stringify(responsePayload || {}));
  if (errorMessage !== undefined) add('"errorMessage"', errorMessage);
  fields.push('"updatedAt" = NOW()');
  params.push(Number(id));
  await query(`UPDATE "PricingV6JobItem" SET ${fields.join(", ")} WHERE id = $${params.length}`, params);
}

async function resetFailedJobItems(jobId) {
  const result = await query(
    `UPDATE "PricingV6JobItem"
     SET state = 'pending', "errorMessage" = NULL, "responsePayload" = NULL, "updatedAt" = NOW()
     WHERE "jobId" = $1::uuid AND state = 'failed'`,
    [jobId],
  );
  return Number(result.rowCount || 0);
}

async function createAudit({ shopId, jobId, item, action, actorUserId, payload }) {
  await query(
    `INSERT INTO "PricingV6Audit" ("shopId", "jobId", "productId", "itemId", "modelId", action, "previousPriceCents", "nextPriceCents", "marginRate", "actorUserId", payload)
     VALUES ($1, $2::uuid, $3, $4::bigint, $5::bigint, $6, $7, $8, $9, $10, $11::jsonb)`,
    [Number(shopId), jobId || null, item.productId || null, item.itemId || null, item.modelId || null, action, item.previousPriceCents || null, item.recommendedPriceCents || null, item.marginRate || null, actorUserId == null ? null : Number(actorUserId), JSON.stringify(payload || {})],
  );
}

async function listAudit({ shopId, page = 1, pageSize = 50 }) {
  const normalizedPage = Math.max(1, Number(page) || 1);
  const normalizedPageSize = Math.max(1, Math.min(Number(pageSize) || 50, 200));
  const [totalRow, result] = await Promise.all([
    queryOne('SELECT COUNT(*)::int AS total FROM "PricingV6Audit" WHERE "shopId" = $1', [Number(shopId)]),
    query(
      `SELECT id, "jobId" AS job_id, "itemId" AS item_id, "modelId" AS model_id, action, "previousPriceCents" AS previous_price_cents,
              "nextPriceCents" AS next_price_cents, "marginRate" AS margin_rate, "actorUserId" AS actor_user_id, payload, "createdAt" AS created_at
       FROM "PricingV6Audit" WHERE "shopId" = $1 ORDER BY "createdAt" DESC LIMIT $2 OFFSET $3`,
      [Number(shopId), normalizedPageSize, (normalizedPage - 1) * normalizedPageSize],
    ),
  ]);
  return { total: Number(totalRow?.total || 0), page: normalizedPage, pageSize: normalizedPageSize, rows: result.rows };
}

async function getLocalPromotionConflicts({ shopId, rows }) {
  const itemIds = Array.from(new Set((rows || []).map((row) => row.itemId).filter(Boolean)));
  if (!itemIds.length) return [];
  const result = await query(
    `SELECT di."itemId" AS item_id, di."modelId" AS model_id, dc.id AS campaign_id, dc.name, dc.status, dc."startTime" AS start_time, dc."endTime" AS end_time, dc."shopeeDiscountId" AS shopee_discount_id
     FROM "DiscountItem" di INNER JOIN "DiscountCampaign" dc ON dc.id = di."campaignId"
     WHERE dc."shopId" = $1 AND di."itemId" = ANY($2::bigint[]) AND LOWER(TRIM(COALESCE(dc.status, ''))) IN ('upcoming', 'ongoing')`,
    [Number(shopId), itemIds],
  );
  return result.rows.map((row) => ({ itemId: asBigIntString(row.item_id), modelId: asBigIntString(row.model_id), campaignId: asNumber(row.campaign_id), name: row.name, status: row.status, startTime: row.start_time, endTime: row.end_time, shopeeDiscountId: asBigIntString(row.shopee_discount_id), source: "local" }));
}

module.exports = {
  listPricingProducts,
  getPricingRowsByKeys,
  getPricingRowByKey,
  getActivePricingKeys,
  getPricingSettings,
  upsertPricingSettings,
  createSnapshot,
  findReusableSnapshot,
  invalidateReusableSnapshots,
  invalidateAllReusableSnapshots,
  getSnapshot,
  createPricingJob,
  getPricingJob,
  listPricingJobs,
  updatePricingJob,
  updateJobItem,
  resetFailedJobItems,
  createAudit,
  listAudit,
  getLocalPromotionConflicts,
  _test: {
    buildProductFilters,
    mapProductRow,
    toPriceCents,
    toProductKey,
    CURRENT_PRICE_PROMOTION_STATUSES,
    PRICING_ACTIVE_PRODUCT_STATUSES,
  },
};
