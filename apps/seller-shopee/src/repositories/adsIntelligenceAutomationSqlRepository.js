"use strict";

const { query, queryOne } = require("../config/postgres");

let ensureTablePromise = null;

function parseCampaignIds(value) {
  if (!value) return [];
  try {
    const arr = JSON.parse(String(value));
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => String(x || "").trim()).filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function mapConfigRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    shopId: Number(row.shop_id),
    isEnabled: Boolean(row.is_enabled),
    mode: row.mode || "reduce_percent",
    reducePercent:
      row.reduce_percent == null ? null : Number(row.reduce_percent),
    fixedBudget: row.fixed_budget == null ? null : Number(row.fixed_budget),
    restoreMode: row.restore_mode || "original",
    restoreBudget:
      row.restore_budget == null ? null : Number(row.restore_budget),
    noReturnRatioThreshold:
      row.no_return_ratio_threshold == null
        ? null
        : Number(row.no_return_ratio_threshold),
    minClicksPerHour:
      row.min_clicks_per_hour == null ? null : Number(row.min_clicks_per_hour),
    campaignIds: parseCampaignIds(row.campaign_ids_json),
    lastRunAt: row.last_run_at || null,
    lastRunStatus: row.last_run_status || null,
    lastRunSummary: row.last_run_summary || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function ensureAdsIntelligenceAutomationTable() {
  if (ensureTablePromise) return ensureTablePromise;

  ensureTablePromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS "AdsIntelligenceAutomation" (
        "id" SERIAL NOT NULL,
        "shopId" INTEGER NOT NULL,
        "isEnabled" BOOLEAN NOT NULL DEFAULT false,
        mode TEXT NOT NULL DEFAULT 'reduce_percent',
        "reducePercent" NUMERIC(6,2) NULL,
        "fixedBudget" NUMERIC(14,2) NULL,
        "restoreMode" TEXT NOT NULL DEFAULT 'original',
        "restoreBudget" NUMERIC(14,2) NULL,
        "noReturnRatioThreshold" NUMERIC(6,4) NULL,
        "minClicksPerHour" INTEGER NOT NULL DEFAULT 0,
        "campaignIdsJson" TEXT NULL,
        "lastRunAt" TIMESTAMP(3) NULL,
        "lastRunStatus" TEXT NULL,
        "lastRunSummary" JSONB NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "AdsIntelligenceAutomation_pkey" PRIMARY KEY ("id")
      )
    `);

    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "AdsIntelligenceAutomation_shopId_key"
      ON "AdsIntelligenceAutomation"("shopId")
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS "AdsIntelligenceAutomation_isEnabled_idx"
      ON "AdsIntelligenceAutomation"("isEnabled")
    `);

    await query(`
      DO $$
      BEGIN
        IF to_regclass('public."Shop"') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'AdsIntelligenceAutomation_shopId_fkey'
          ) THEN
          ALTER TABLE "AdsIntelligenceAutomation"
            ADD CONSTRAINT "AdsIntelligenceAutomation_shopId_fkey"
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

async function getAutomationConfigByShopId(shopId) {
  await ensureAdsIntelligenceAutomationTable();
  const row = await queryOne(
    `
      SELECT
        id,
        "shopId" AS shop_id,
        "isEnabled" AS is_enabled,
        mode,
        "reducePercent" AS reduce_percent,
        "fixedBudget" AS fixed_budget,
        "restoreMode" AS restore_mode,
        "restoreBudget" AS restore_budget,
        "noReturnRatioThreshold" AS no_return_ratio_threshold,
        "minClicksPerHour" AS min_clicks_per_hour,
        "campaignIdsJson" AS campaign_ids_json,
        "lastRunAt" AS last_run_at,
        "lastRunStatus" AS last_run_status,
        "lastRunSummary" AS last_run_summary,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
      FROM "AdsIntelligenceAutomation"
      WHERE "shopId" = $1
      LIMIT 1
    `,
    [Number(shopId)],
  );

  return mapConfigRow(row);
}

async function upsertAutomationConfig({
  shopId,
  isEnabled,
  mode,
  reducePercent,
  fixedBudget,
  restoreMode,
  restoreBudget,
  noReturnRatioThreshold,
  minClicksPerHour,
  campaignIds,
}) {
  await ensureAdsIntelligenceAutomationTable();

  const campaignIdsJson = JSON.stringify(
    (Array.isArray(campaignIds) ? campaignIds : [])
      .map((x) => String(x || "").trim())
      .filter(Boolean),
  );

  const row = await queryOne(
    `
      INSERT INTO "AdsIntelligenceAutomation" (
        "shopId",
        "isEnabled",
        mode,
        "reducePercent",
        "fixedBudget",
        "restoreMode",
        "restoreBudget",
        "noReturnRatioThreshold",
        "minClicksPerHour",
        "campaignIdsJson",
        "updatedAt"
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW()
      )
      ON CONFLICT ("shopId")
      DO UPDATE SET
        "isEnabled" = EXCLUDED."isEnabled",
        mode = EXCLUDED.mode,
        "reducePercent" = EXCLUDED."reducePercent",
        "fixedBudget" = EXCLUDED."fixedBudget",
        "restoreMode" = EXCLUDED."restoreMode",
        "restoreBudget" = EXCLUDED."restoreBudget",
        "noReturnRatioThreshold" = EXCLUDED."noReturnRatioThreshold",
        "minClicksPerHour" = EXCLUDED."minClicksPerHour",
        "campaignIdsJson" = EXCLUDED."campaignIdsJson",
        "updatedAt" = NOW()
      RETURNING
        id,
        "shopId" AS shop_id,
        "isEnabled" AS is_enabled,
        mode,
        "reducePercent" AS reduce_percent,
        "fixedBudget" AS fixed_budget,
        "restoreMode" AS restore_mode,
        "restoreBudget" AS restore_budget,
        "noReturnRatioThreshold" AS no_return_ratio_threshold,
        "minClicksPerHour" AS min_clicks_per_hour,
        "campaignIdsJson" AS campaign_ids_json,
        "lastRunAt" AS last_run_at,
        "lastRunStatus" AS last_run_status,
        "lastRunSummary" AS last_run_summary,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
    `,
    [
      Number(shopId),
      Boolean(isEnabled),
      String(mode || "reduce_percent"),
      reducePercent == null ? null : Number(reducePercent),
      fixedBudget == null ? null : Number(fixedBudget),
      String(restoreMode || "original"),
      restoreBudget == null ? null : Number(restoreBudget),
      noReturnRatioThreshold == null ? null : Number(noReturnRatioThreshold),
      Number(minClicksPerHour || 0),
      campaignIdsJson,
    ],
  );

  return mapConfigRow(row);
}

async function updateAutomationRunResult(shopId, { status, summary }) {
  await ensureAdsIntelligenceAutomationTable();
  const row = await queryOne(
    `
      UPDATE "AdsIntelligenceAutomation"
      SET
        "lastRunAt" = NOW(),
        "lastRunStatus" = $2,
        "lastRunSummary" = $3::jsonb,
        "updatedAt" = NOW()
      WHERE "shopId" = $1
      RETURNING
        id,
        "shopId" AS shop_id,
        "isEnabled" AS is_enabled,
        mode,
        "reducePercent" AS reduce_percent,
        "fixedBudget" AS fixed_budget,
        "restoreMode" AS restore_mode,
        "restoreBudget" AS restore_budget,
        "noReturnRatioThreshold" AS no_return_ratio_threshold,
        "minClicksPerHour" AS min_clicks_per_hour,
        "campaignIdsJson" AS campaign_ids_json,
        "lastRunAt" AS last_run_at,
        "lastRunStatus" AS last_run_status,
        "lastRunSummary" AS last_run_summary,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
    `,
    [Number(shopId), String(status || "unknown"), JSON.stringify(summary || {})],
  );

  return mapConfigRow(row);
}

async function listEnabledAutomationConfigsWithShops() {
  await ensureAdsIntelligenceAutomationTable();

  const result = await query(
    `
      SELECT
        cfg.id,
        cfg."shopId" AS shop_id,
        cfg."isEnabled" AS is_enabled,
        cfg.mode,
        cfg."reducePercent" AS reduce_percent,
        cfg."fixedBudget" AS fixed_budget,
        cfg."restoreMode" AS restore_mode,
        cfg."restoreBudget" AS restore_budget,
        cfg."noReturnRatioThreshold" AS no_return_ratio_threshold,
        cfg."minClicksPerHour" AS min_clicks_per_hour,
        cfg."campaignIdsJson" AS campaign_ids_json,
        cfg."lastRunAt" AS last_run_at,
        cfg."lastRunStatus" AS last_run_status,
        cfg."lastRunSummary" AS last_run_summary,
        cfg."createdAt" AS created_at,
        cfg."updatedAt" AS updated_at,
        s."shopId" AS shopee_shop_id,
        s.region,
        s.status AS shop_status
      FROM "AdsIntelligenceAutomation" cfg
      INNER JOIN "Shop" s ON s.id = cfg."shopId"
      WHERE cfg."isEnabled" = true
      ORDER BY cfg."updatedAt" DESC, cfg.id DESC
    `,
  );

  return result.rows.map((row) => ({
    config: mapConfigRow(row),
    shop: {
      id: Number(row.shop_id),
      shopId: row.shopee_shop_id == null ? null : BigInt(row.shopee_shop_id),
      region: row.region || null,
      status: row.shop_status || null,
    },
  }));
}

module.exports = {
  ensureAdsIntelligenceAutomationTable,
  getAutomationConfigByShopId,
  upsertAutomationConfig,
  updateAutomationRunResult,
  listEnabledAutomationConfigsWithShops,
};

