"use strict";

const { query } = require("../config/postgres");

let ensureTablePromise = null;

async function ensureProductTrafficDailyTable() {
  if (ensureTablePromise) {
    return ensureTablePromise;
  }

  ensureTablePromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS "ProductTrafficDaily" (
        "id" SERIAL NOT NULL,
        "shopId" INTEGER NOT NULL,
        "itemId" BIGINT NOT NULL,
        "trafficDate" DATE NOT NULL,
        "impressionsCumulative" BIGINT NOT NULL DEFAULT 0,
        "visitsCumulative" BIGINT NOT NULL DEFAULT 0,
        "impressionsDelta" BIGINT NOT NULL DEFAULT 0,
        "visitsDelta" BIGINT NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'item_extra_info',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ProductTrafficDaily_pkey" PRIMARY KEY ("id")
      )
    `);

    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ProductTrafficDaily_shopId_itemId_trafficDate_key"
      ON "ProductTrafficDaily"("shopId", "itemId", "trafficDate")
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS "ProductTrafficDaily_shopId_trafficDate_idx"
      ON "ProductTrafficDaily"("shopId", "trafficDate")
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS "ProductTrafficDaily_shopId_itemId_trafficDate_idx"
      ON "ProductTrafficDaily"("shopId", "itemId", "trafficDate" DESC)
    `);

    await query(`
      DO $$
      BEGIN
        IF to_regclass('public."Shop"') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'ProductTrafficDaily_shopId_fkey'
          ) THEN
          ALTER TABLE "ProductTrafficDaily"
            ADD CONSTRAINT "ProductTrafficDaily_shopId_fkey"
            FOREIGN KEY ("shopId") REFERENCES "Shop"("id")
            ON DELETE CASCADE
            ON UPDATE CASCADE;
        END IF;
      END $$;
    `);
  })().catch((error) => {
    ensureTablePromise = null;
    throw error;
  });

  return ensureTablePromise;
}

function toDateYyyyMmDd(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeItemIds(itemIds = []) {
  const values = [];
  for (const itemId of Array.isArray(itemIds) ? itemIds : []) {
    if (itemId == null || itemId === "") continue;
    try {
      values.push(BigInt(String(itemId)).toString());
    } catch (_error) {
      continue;
    }
  }
  return Array.from(new Set(values));
}

function toNumberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function listAggregatedProductTrafficDailyByRange(
  shopId,
  startDate,
  endDate,
  itemIds = [],
) {
  await ensureProductTrafficDailyTable();

  const start = toDateYyyyMmDd(startDate);
  const end = toDateYyyyMmDd(endDate);
  if (!start || !end) return [];

  const normalizedItemIds = normalizeItemIds(itemIds);
  const params = [Number(shopId), start, end];
  let itemFilterSql = "";
  if (normalizedItemIds.length) {
    params.push(normalizedItemIds);
    itemFilterSql = `AND "itemId" = ANY($4::bigint[])`;
  }

  const result = await query(
    `
      SELECT
        "itemId",
        COALESCE(SUM("impressionsDelta"), 0)::bigint AS impressions,
        COALESCE(SUM("visitsDelta"), 0)::bigint AS visits
      FROM "ProductTrafficDaily"
      WHERE "shopId" = $1
        AND "trafficDate" >= $2::date
        AND "trafficDate" <= $3::date
        ${itemFilterSql}
      GROUP BY "itemId"
    `,
    params,
  );

  return result.rows.map((row) => ({
    itemId: row.itemId == null ? null : BigInt(row.itemId),
    impressions: toNumberOrZero(row.impressions),
    visits: toNumberOrZero(row.visits),
  }));
}

async function listTrackedItemIdsForDate(shopId, trafficDate, itemIds = []) {
  await ensureProductTrafficDailyTable();

  const dateKey = toDateYyyyMmDd(trafficDate);
  if (!dateKey) return [];

  const normalizedItemIds = normalizeItemIds(itemIds);
  if (!normalizedItemIds.length) return [];

  const result = await query(
    `
      SELECT DISTINCT "itemId"
      FROM "ProductTrafficDaily"
      WHERE "shopId" = $1
        AND "trafficDate" = $2::date
        AND "itemId" = ANY($3::bigint[])
    `,
    [Number(shopId), dateKey, normalizedItemIds],
  );

  return result.rows
    .map((row) => {
      try {
        return BigInt(row.itemId).toString();
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

async function upsertProductTrafficDailySnapshots(
  shopId,
  trafficDate,
  rows = [],
) {
  await ensureProductTrafficDailyTable();

  const dateKey = toDateYyyyMmDd(trafficDate);
  if (!dateKey) return [];

  const payload = (Array.isArray(rows) ? rows : [])
    .map((row) => {
      try {
        const itemId = BigInt(String(row?.itemId || "")).toString();
        return {
          itemId,
          impressionsCumulative: Math.max(
            0,
            Math.round(Number(row?.impressionsCumulative || 0) || 0),
          ),
          visitsCumulative: Math.max(
            0,
            Math.round(Number(row?.visitsCumulative || 0) || 0),
          ),
          source: String(row?.source || "item_extra_info").trim() || "item_extra_info",
        };
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);

  if (!payload.length) return [];

  const result = await query(
    `
      WITH incoming AS (
        SELECT *
        FROM jsonb_to_recordset($3::jsonb) AS x(
          "itemId" bigint,
          "impressionsCumulative" bigint,
          "visitsCumulative" bigint,
          source text
        )
      ),
      prepared AS (
        SELECT
          $1::integer AS "shopId",
          i."itemId",
          $2::date AS "trafficDate",
          GREATEST(0, COALESCE(i."impressionsCumulative", 0))::bigint AS "impressionsCumulative",
          GREATEST(0, COALESCE(i."visitsCumulative", 0))::bigint AS "visitsCumulative",
          COALESCE(NULLIF(i.source, ''), 'item_extra_info') AS source,
          COALESCE(
            (
              SELECT d."impressionsCumulative"
              FROM "ProductTrafficDaily" d
              WHERE d."shopId" = $1
                AND d."itemId" = i."itemId"
                AND d."trafficDate" < $2::date
              ORDER BY d."trafficDate" DESC
              LIMIT 1
            ),
            0
          )::bigint AS prev_impressions,
          COALESCE(
            (
              SELECT d."visitsCumulative"
              FROM "ProductTrafficDaily" d
              WHERE d."shopId" = $1
                AND d."itemId" = i."itemId"
                AND d."trafficDate" < $2::date
              ORDER BY d."trafficDate" DESC
              LIMIT 1
            ),
            0
          )::bigint AS prev_visits
        FROM incoming i
      )
      INSERT INTO "ProductTrafficDaily" (
        "shopId",
        "itemId",
        "trafficDate",
        "impressionsCumulative",
        "visitsCumulative",
        "impressionsDelta",
        "visitsDelta",
        source,
        "createdAt",
        "updatedAt"
      )
      SELECT
        p."shopId",
        p."itemId",
        p."trafficDate",
        p."impressionsCumulative",
        p."visitsCumulative",
        GREATEST(0, p."impressionsCumulative" - p.prev_impressions)::bigint AS "impressionsDelta",
        GREATEST(0, p."visitsCumulative" - p.prev_visits)::bigint AS "visitsDelta",
        p.source,
        NOW(),
        NOW()
      FROM prepared p
      ON CONFLICT ("shopId", "itemId", "trafficDate")
      DO UPDATE SET
        "impressionsCumulative" = EXCLUDED."impressionsCumulative",
        "visitsCumulative" = EXCLUDED."visitsCumulative",
        "impressionsDelta" = EXCLUDED."impressionsDelta",
        "visitsDelta" = EXCLUDED."visitsDelta",
        source = EXCLUDED.source,
        "updatedAt" = NOW()
      RETURNING
        "itemId",
        "impressionsCumulative",
        "visitsCumulative",
        "impressionsDelta",
        "visitsDelta"
    `,
    [Number(shopId), dateKey, JSON.stringify(payload)],
  );

  return result.rows.map((row) => ({
    itemId: row.itemId == null ? null : BigInt(row.itemId),
    impressionsCumulative: toNumberOrZero(row.impressionsCumulative),
    visitsCumulative: toNumberOrZero(row.visitsCumulative),
    impressionsDelta: toNumberOrZero(row.impressionsDelta),
    visitsDelta: toNumberOrZero(row.visitsDelta),
  }));
}

module.exports = {
  listAggregatedProductTrafficDailyByRange,
  listTrackedItemIdsForDate,
  upsertProductTrafficDailySnapshots,
};
