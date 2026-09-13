"use strict";

const { query, queryOne } = require("../config/postgres");

let ensurePromise = null;

function toDateFromTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(numeric * 1000);
}

function toSafeInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function getPayloadData(payload = {}) {
  return payload?.data && typeof payload.data === "object" ? payload.data : {};
}

function getPayloadAction(data = {}) {
  return data.action && typeof data.action === "object" ? data.action : {};
}

function formatNoticeDateTime(value) {
  const date = value instanceof Date ? value : toDateFromTimestamp(value) || new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

async function ensureShopeePushNoticeTable() {
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS "ShopeePushNotice" (
        id BIGSERIAL PRIMARY KEY,
        "eventKey" TEXT NOT NULL UNIQUE,
        "shopId" INTEGER NULL,
        "shopeeShopId" BIGINT NULL,
        code INTEGER NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        "entityType" TEXT NULL,
        "entityId" TEXT NULL,
        "occurredAt" TIMESTAMPTZ NULL,
        "pushTimestamp" TIMESTAMPTZ NULL,
        "expiresAt" TIMESTAMPTZ NULL,
        payload JSONB NULL,
        "readAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`
      ALTER TABLE "ShopeePushNotice"
      ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMPTZ NULL
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS "ShopeePushNotice_shopId_createdAt_idx"
        ON "ShopeePushNotice"("shopId", "createdAt" DESC)
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS "ShopeePushNotice_shopId_readAt_idx"
        ON "ShopeePushNotice"("shopId", "readAt", "createdAt" DESC)
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS "ShopeePushNotice_expiresAt_idx"
        ON "ShopeePushNotice"("expiresAt")
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS "ShopeePushNotice_category_createdAt_idx"
        ON "ShopeePushNotice"(category, "createdAt" DESC)
    `);
  })().catch((error) => {
    ensurePromise = null;
    throw error;
  });

  return ensurePromise;
}

function mapNoticeRow(row) {
  return {
    id: Number(row.id),
    eventKey: row.event_key || null,
    shopId: row.shop_id == null ? null : Number(row.shop_id),
    shopeeShopId: row.shopee_shop_id == null ? null : String(row.shopee_shop_id),
    code: row.code == null ? null : Number(row.code),
    category: row.category || "unknown",
    severity: row.severity || "info",
    title: row.title || "Aviso Shopee",
    message: row.message || "",
    entityType: row.entity_type || null,
    entityId: row.entity_id || null,
    occurredAt: row.occurred_at || null,
    pushTimestamp: row.push_timestamp || null,
    expiresAt: row.expires_at || null,
    payload: row.payload || null,
    readAt: row.read_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function buildNoticeEventKey({
  shopId = null,
  shopeeShopId = null,
  code = null,
  category = "unknown",
  payload = {},
  title = "",
  message = "",
}) {
  const data = getPayloadData(payload);
  const action = getPayloadAction(data);
  const normalizedCode = toSafeInt(code || payload?.code, null);
  const shopPart = firstNonEmpty(
    shopeeShopId,
    shopId,
    payload?.shop_id,
    data.shop_id,
    payload?.supplier_id,
    "no-shop",
  );
  const codePart = firstNonEmpty(normalizedCode, category, "unknown");

  if (normalizedCode === 9 || category === "promotion_update") {
    const promotionAction = typeof data.action === "string" ? data.action : "";
    const parts = [
      shopPart,
      codePart,
      "promotion",
      firstNonEmpty(data.promotion_id, "no-promotion"),
      firstNonEmpty(data.item_id, "no-item"),
      firstNonEmpty(data.model_id, data.variation_id),
      firstNonEmpty(promotionAction, data.action_type, data.action_index),
      firstNonEmpty(data.promotion_type),
      firstNonEmpty(data.start_time),
      firstNonEmpty(data.end_time),
    ];
    return parts.map((part) => String(part ?? "").trim()).join("|").slice(0, 900);
  }

  if (normalizedCode === 5 || category === "shopee_updates") {
    const parts = [
      shopPart,
      codePart,
      "shopee-update",
      firstNonEmpty(action.url, data.url),
      firstNonEmpty(action.title, data.title, title),
      firstNonEmpty(action.update_time, data.update_time),
    ];
    return parts.map((part) => String(part ?? "").trim()).join("|").slice(0, 900);
  }

  const parts = [
    shopPart,
    codePart,
    firstNonEmpty(data.action_update_time, action.update_time, data.update_time, data.create_time, payload?.timestamp),
    firstNonEmpty(data.item_id, data.order_sn, data.return_sn, data.promotion_id, data.purchase_order_id, data.action_url, action.url),
    firstNonEmpty(data.model_id, data.variation_id),
    firstNonEmpty(typeof data.action === "string" ? data.action : "", data.action_type, data.action_index),
    firstNonEmpty(data.action_title, action.title),
    title,
    message,
  ];
  return parts.map((part) => String(part ?? "").trim()).join("|").slice(0, 900);
}

async function upsertShopeePushNotice({
  eventKey,
  shopId = null,
  shopeeShopId = null,
  code = null,
  category = "unknown",
  severity = "info",
  title,
  message,
  entityType = null,
  entityId = null,
  occurredAt = null,
  pushTimestamp = null,
  expiresAt = null,
  payload = null,
}) {
  await ensureShopeePushNoticeTable();
  const safeEventKey = String(eventKey || "").trim() || buildNoticeEventKey({
    shopId,
    shopeeShopId,
    code,
    category,
    payload,
    title,
    message,
  });

  const row = await queryOne(
    `
      INSERT INTO "ShopeePushNotice" (
        "eventKey",
        "shopId",
        "shopeeShopId",
        code,
        category,
        severity,
        title,
        message,
        "entityType",
        "entityId",
        "occurredAt",
        "pushTimestamp",
        "expiresAt",
        payload
      )
      VALUES (
        $1,
        $2,
        $3::bigint,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13::timestamptz,
        $14::jsonb
      )
      ON CONFLICT ("eventKey")
      DO UPDATE SET
        "updatedAt" = NOW(),
        "expiresAt" = COALESCE(EXCLUDED."expiresAt", "ShopeePushNotice"."expiresAt"),
        payload = COALESCE(EXCLUDED.payload, "ShopeePushNotice".payload)
      RETURNING
        id,
        "eventKey" AS event_key,
        "shopId" AS shop_id,
        "shopeeShopId" AS shopee_shop_id,
        code,
        category,
        severity,
        title,
        message,
        "entityType" AS entity_type,
        "entityId" AS entity_id,
        "occurredAt" AS occurred_at,
        "pushTimestamp" AS push_timestamp,
        "expiresAt" AS expires_at,
        payload,
        "readAt" AS read_at,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
    `,
    [
      safeEventKey,
      shopId == null ? null : Number(shopId),
      shopeeShopId == null ? null : String(shopeeShopId),
      code == null ? null : toSafeInt(code, null),
      String(category || "unknown"),
      String(severity || "info"),
      String(title || "Aviso Shopee").slice(0, 300),
      String(message || "").slice(0, 1200),
      entityType == null ? null : String(entityType || "").slice(0, 80),
      entityId == null ? null : String(entityId || "").slice(0, 160),
      occurredAt || null,
      pushTimestamp || null,
      expiresAt || null,
      payload == null ? null : JSON.stringify(payload),
    ],
  );

  return mapNoticeRow(row);
}

function buildNoticeFilters({
  shopId,
  category = "",
  unreadOnly = false,
  search = "",
} = {}) {
  const params = [Number(shopId)];
  const filters = [
    `"shopId" = $1`,
    `("expiresAt" IS NULL OR "expiresAt" > NOW())`,
  ];

  const normalizedCategory = String(category || "").trim();
  if (normalizedCategory) {
    params.push(normalizedCategory);
    filters.push(`category = $${params.length}`);
  }

  if (unreadOnly) {
    filters.push(`"readAt" IS NULL`);
  }

  const normalizedSearch = String(search || "").trim();
  if (normalizedSearch) {
    params.push(`%${normalizedSearch}%`);
    filters.push(`(
      title ILIKE $${params.length}
      OR message ILIKE $${params.length}
      OR COALESCE("entityId", '') ILIKE $${params.length}
      OR COALESCE(category, '') ILIKE $${params.length}
    )`);
  }

  return {
    params,
    whereSql: `WHERE ${filters.join(" AND ")}`,
  };
}

function buildPromotionEndedEventKey(row) {
  const payload = row.payload || {};
  const data = getPayloadData(payload);
  return [
    firstNonEmpty(row.shopee_shop_id, row.shop_id, payload.shop_id, data.shop_id, "no-shop"),
    firstNonEmpty(row.code, payload.code, "9"),
    "promotion-ended",
    firstNonEmpty(data.promotion_id, row.entity_id, "no-promotion"),
    firstNonEmpty(data.item_id, "no-item"),
    firstNonEmpty(data.model_id, data.variation_id),
    firstNonEmpty(data.action, data.action_type),
    firstNonEmpty(data.promotion_type),
    firstNonEmpty(data.end_time, row.expires_at),
  ].map((part) => String(part ?? "").trim()).join("|").slice(0, 900);
}

function buildPromotionEndedNotice(row) {
  const payload = row.payload || {};
  const data = getPayloadData(payload);
  const promotionId = firstNonEmpty(data.promotion_id, row.entity_id);
  const itemId = firstNonEmpty(data.item_id);
  const endedAt = row.expires_at || toDateFromTimestamp(data.end_time) || new Date();
  const endedAtText = formatNoticeDateTime(endedAt);
  const itemText = itemId ? ` do item ${itemId}` : "";
  const promotionText = promotionId ? ` ${promotionId}` : "";

  return {
    eventKey: buildPromotionEndedEventKey(row),
    shopId: row.shop_id == null ? null : Number(row.shop_id),
    shopeeShopId: row.shopee_shop_id == null ? null : String(row.shopee_shop_id),
    code: row.code == null ? 9 : Number(row.code),
    category: "promotion_update",
    severity: "warning",
    title: "Promoção encerrada",
    message: `A promoção${promotionText}${itemText} encerrou${endedAtText ? ` em ${endedAtText}` : ""}.`,
    entityType: "promotion",
    entityId: promotionId || row.entity_id || null,
    occurredAt: endedAt,
    pushTimestamp: row.push_timestamp || null,
    expiresAt: null,
    payload: {
      ...payload,
      ended_notice: true,
      original_notice_id: row.id,
      data: {
        ...data,
        promotion_ended_at: data.end_time || row.expires_at || null,
      },
    },
  };
}

async function createPromotionEndedNoticesForExpiredRows(rows = []) {
  for (const row of rows) {
    if (Number(row.code) !== 9 && row.category !== "promotion_update") continue;
    const payload = row.payload || {};
    if (payload.ended_notice) continue;
    await upsertShopeePushNotice(buildPromotionEndedNotice(row));
  }
}

async function deleteExpiredShopeePushNotices({ shopId = null } = {}) {
  await ensureShopeePushNoticeTable();
  const params = [];
  const filters = [`"expiresAt" IS NOT NULL`, `"expiresAt" <= NOW()`];
  if (shopId != null) {
    params.push(Number(shopId));
    filters.push(`"shopId" = $${params.length}`);
  }
  const expiredRows = await query(
    `
      SELECT
        id,
        "eventKey" AS event_key,
        "shopId" AS shop_id,
        "shopeeShopId" AS shopee_shop_id,
        code,
        category,
        severity,
        title,
        message,
        "entityType" AS entity_type,
        "entityId" AS entity_id,
        "occurredAt" AS occurred_at,
        "pushTimestamp" AS push_timestamp,
        "expiresAt" AS expires_at,
        payload,
        "readAt" AS read_at,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
      FROM "ShopeePushNotice"
      WHERE ${filters.join(" AND ")}
    `,
    params,
  );
  const rows = expiredRows.rows || [];
  if (!rows.length) return 0;

  await createPromotionEndedNoticesForExpiredRows(rows);

  const ids = rows.map((row) => Number(row.id)).filter(Boolean);
  if (!ids.length) return 0;
  const row = await queryOne(
    `
      WITH deleted AS (
        DELETE FROM "ShopeePushNotice"
        WHERE id = ANY($1::bigint[])
        RETURNING id
      )
      SELECT COUNT(*)::int AS affected FROM deleted
    `,
    [ids],
  );
  return Number(row?.affected || 0);
}

async function dedupeShopeePushNotices({ shopId = null } = {}) {
  await ensureShopeePushNoticeTable();
  const params = [];
  const filters = [`(code = 9 OR category = 'promotion_update')`];
  if (shopId != null) {
    params.push(Number(shopId));
    filters.push(`"shopId" = $${params.length}`);
  }
  const row = await queryOne(
    `
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY
              "shopId",
              COALESCE("shopeeShopId"::text, ''),
              COALESCE(code::text, ''),
              category,
              COALESCE(payload->'data'->>'promotion_id', "entityId", ''),
              COALESCE(payload->'data'->>'item_id', ''),
              COALESCE(payload->'data'->>'model_id', payload->'data'->>'variation_id', ''),
              COALESCE(payload->'data'->>'action', payload->'data'->>'action_type', ''),
              COALESCE(payload->'data'->>'promotion_type', ''),
              COALESCE(payload->'data'->>'end_time', "expiresAt"::text, '')
            ORDER BY
              CASE WHEN "readAt" IS NULL THEN 0 ELSE 1 END,
              COALESCE("occurredAt", "createdAt") DESC,
              id DESC
          ) AS rn
        FROM "ShopeePushNotice"
        WHERE ${filters.join(" AND ")}
      ),
      deleted AS (
        DELETE FROM "ShopeePushNotice" notice
        USING ranked
        WHERE notice.id = ranked.id
          AND ranked.rn > 1
        RETURNING notice.id
      )
      SELECT COUNT(*)::int AS affected FROM deleted
    `,
    params,
  );
  return Number(row?.affected || 0);
}

async function listShopeePushNotices({
  shopId,
  page = 1,
  pageSize = 50,
  category = "",
  unreadOnly = false,
  search = "",
} = {}) {
  await ensureShopeePushNoticeTable();
  await deleteExpiredShopeePushNotices({ shopId });
  await dedupeShopeePushNotices({ shopId });
  const safePage = Math.max(1, toSafeInt(page, 1));
  const safePageSize = Math.max(1, Math.min(200, toSafeInt(pageSize, 50)));
  const offset = (safePage - 1) * safePageSize;
  const { params, whereSql } = buildNoticeFilters({
    shopId,
    category,
    unreadOnly,
    search,
  });
  const listParams = params.slice();
  listParams.push(safePageSize);
  const limitParam = listParams.length;
  listParams.push(offset);
  const offsetParam = listParams.length;

  const [rows, totalRow, unreadRow, categoryRows] = await Promise.all([
    query(
      `
        SELECT
          id,
          "eventKey" AS event_key,
          "shopId" AS shop_id,
          "shopeeShopId" AS shopee_shop_id,
          code,
          category,
          severity,
          title,
          message,
          "entityType" AS entity_type,
          "entityId" AS entity_id,
          "occurredAt" AS occurred_at,
          "pushTimestamp" AS push_timestamp,
          "expiresAt" AS expires_at,
          payload,
          "readAt" AS read_at,
          "createdAt" AS created_at,
          "updatedAt" AS updated_at
        FROM "ShopeePushNotice"
        ${whereSql}
        ORDER BY COALESCE("occurredAt", "createdAt") DESC, id DESC
        LIMIT $${limitParam}
        OFFSET $${offsetParam}
      `,
      listParams,
    ),
    queryOne(
      `SELECT COUNT(*)::int AS total FROM "ShopeePushNotice" ${whereSql}`,
      params,
    ),
    queryOne(
      `
        SELECT COUNT(*)::int AS total
        FROM "ShopeePushNotice"
        WHERE "shopId" = $1
          AND "readAt" IS NULL
          AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
      `,
      [Number(shopId)],
    ),
    query(
      `
        SELECT category, COUNT(*)::int AS total
        FROM "ShopeePushNotice"
        WHERE "shopId" = $1
          AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
        GROUP BY category
        ORDER BY total DESC, category ASC
      `,
      [Number(shopId)],
    ),
  ]);

  const total = Number(totalRow?.total || 0);
  return {
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / safePageSize)),
    unreadTotal: Number(unreadRow?.total || 0),
    categories: categoryRows.rows.map((row) => ({
      category: row.category || "unknown",
      total: Number(row.total || 0),
    })),
    notices: rows.rows.map(mapNoticeRow),
  };
}

function normalizeNoticeIds(ids = []) {
  return [...new Set(
    (Array.isArray(ids) ? ids : [ids])
      .map((id) => toSafeInt(id, null))
      .filter(Boolean),
  )];
}

async function markShopeePushNoticeRead({ shopId, noticeId = null, noticeIds = [], all = false } = {}) {
  await ensureShopeePushNoticeTable();
  await deleteExpiredShopeePushNotices({ shopId });
  await dedupeShopeePushNotices({ shopId });
  if (all) {
    const row = await queryOne(
      `
        WITH updated AS (
          UPDATE "ShopeePushNotice"
          SET "readAt" = COALESCE("readAt", NOW()), "updatedAt" = NOW()
          WHERE "shopId" = $1
            AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
          RETURNING id
        )
        SELECT COUNT(*)::int AS affected FROM updated
      `,
      [Number(shopId)],
    );
    return Number(row?.affected || 0);
  }

  const ids = normalizeNoticeIds(noticeIds.length ? noticeIds : noticeId);
  if (!ids.length) return 0;
  const row = await queryOne(
    `
      WITH updated AS (
        UPDATE "ShopeePushNotice"
        SET "readAt" = COALESCE("readAt", NOW()), "updatedAt" = NOW()
        WHERE "shopId" = $1
          AND id = ANY($2::bigint[])
          AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
        RETURNING id
      )
      SELECT COUNT(*)::int AS affected FROM updated
    `,
    [Number(shopId), ids],
  );
  return Number(row?.affected || 0);
}

async function deleteShopeePushNotices({ shopId, noticeId = null, noticeIds = [], all = false } = {}) {
  await ensureShopeePushNoticeTable();
  await deleteExpiredShopeePushNotices({ shopId });
  await dedupeShopeePushNotices({ shopId });
  if (all) {
    const row = await queryOne(
      `
        WITH deleted AS (
          DELETE FROM "ShopeePushNotice"
          WHERE "shopId" = $1
          RETURNING id
        )
        SELECT COUNT(*)::int AS affected FROM deleted
      `,
      [Number(shopId)],
    );
    return Number(row?.affected || 0);
  }

  const ids = normalizeNoticeIds(noticeIds.length ? noticeIds : noticeId);
  if (!ids.length) return 0;
  const row = await queryOne(
    `
      WITH deleted AS (
        DELETE FROM "ShopeePushNotice"
        WHERE "shopId" = $1 AND id = ANY($2::bigint[])
        RETURNING id
      )
      SELECT COUNT(*)::int AS affected FROM deleted
    `,
    [Number(shopId), ids],
  );
  return Number(row?.affected || 0);
}

async function listShopeePushNoticeReport({
  shopId,
  category = "",
  unreadOnly = false,
  search = "",
  limit = 10000,
} = {}) {
  await ensureShopeePushNoticeTable();
  await deleteExpiredShopeePushNotices({ shopId });
  await dedupeShopeePushNotices({ shopId });
  const { params, whereSql } = buildNoticeFilters({ shopId, category, unreadOnly, search });
  const safeLimit = Math.max(1, Math.min(50000, toSafeInt(limit, 10000)));
  const reportParams = params.slice();
  reportParams.push(safeLimit);
  const limitParam = reportParams.length;
  const rows = await query(
    `
      SELECT
        id,
        "eventKey" AS event_key,
        "shopId" AS shop_id,
        "shopeeShopId" AS shopee_shop_id,
        code,
        category,
        severity,
        title,
        message,
        "entityType" AS entity_type,
        "entityId" AS entity_id,
        "occurredAt" AS occurred_at,
        "pushTimestamp" AS push_timestamp,
        "expiresAt" AS expires_at,
        payload,
        "readAt" AS read_at,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
      FROM "ShopeePushNotice"
      ${whereSql}
      ORDER BY COALESCE("occurredAt", "createdAt") DESC, id DESC
      LIMIT $${limitParam}
    `,
    reportParams,
  );
  return rows.rows.map(mapNoticeRow);
}

module.exports = {
  buildNoticeEventKey,
  dedupeShopeePushNotices,
  deleteExpiredShopeePushNotices,
  deleteShopeePushNotices,
  ensureShopeePushNoticeTable,
  listShopeePushNoticeReport,
  listShopeePushNotices,
  markShopeePushNoticeRead,
  toDateFromTimestamp,
  upsertShopeePushNotice,
};
