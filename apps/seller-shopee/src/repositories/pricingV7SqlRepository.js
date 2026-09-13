"use strict";

const { query, queryOne, withClient } = require("../config/postgres");

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function mapCohort(row) {
  if (!row) return null;
  return {
    scope: row.scope_type,
    scopeKey: row.scope_key,
    sampleSize: numberOrZero(row.sample_size),
    effectiveSampleSize: numberOrZero(row.effective_sample_size),
    averageQuality: numberOrZero(row.average_quality),
    stabilityScore: numberOrZero(row.stability_score),
    gmvFactor: numberOrZero(row.gmv_factor),
    payoutGmvFactor: numberOrZero(row.payout_gmv_factor),
    suggestedAlpha: numberOrZero(row.suggested_alpha),
    calculatedAt: row.calculated_at || null,
    windowStart: row.window_start || null,
    windowEnd: row.window_end || null,
  };
}

async function replaceCalibration({ shopId, rows, cohorts }) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query('DELETE FROM "PricingV7CalibrationOrder" WHERE "shopId" = $1', [Number(shopId)]);
      for (const row of rows) {
        await client.query(
          `INSERT INTO "PricingV7CalibrationOrder" (
             "shopId", "orderId", "orderSn", "itemId", "modelId", sku, "financialState", "financialQualityScore",
             "promotionalPriceCents", "sellerCouponCents", "platformCouponCents", "coinsCents", "buyerShippingCents", "gmvPaidCents",
             "commissionCents", "serviceFeeCents", "rebateCents", "adjustmentCents", "payoutCents", "cmvCents", "taxCents",
             "financialSource", "isProvisional", "isFinalized", "isOutlier", "excludedFromCalibration", "exclusionReason", reconciliation, "sourceUpdatedAt"
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29
           )`,
          [
            Number(shopId), row.orderId || null, row.orderSn, row.itemId || 0, row.modelId || 0, row.sku || null,
            row.financialState, row.financialQualityScore, row.promotionalPriceCents, row.sellerCouponCents,
            row.platformCouponCents, row.coinsCents, row.buyerShippingCents, row.gmvPaidCents,
            row.commissionCents, row.serviceFeeCents, row.rebateCents, row.adjustmentCents, row.payoutCents,
            row.cmvCents, row.taxCents, row.financialSource || "ORDER_ESCROW", Boolean(row.isProvisional),
            Boolean(row.isFinalized), Boolean(row.isOutlier), Boolean(row.excludedFromCalibration),
            row.exclusionReason || null, JSON.stringify(row.reconciliation || {}), row.sourceUpdatedAt || null,
          ],
        );
      }
      await client.query('DELETE FROM "PricingV7CalibrationCohort" WHERE "shopId" = $1', [Number(shopId)]);
      for (const cohort of cohorts) {
        await client.query(
          `INSERT INTO "PricingV7CalibrationCohort" (
             "shopId", "scopeType", "scopeKey", "windowStart", "windowEnd", "sampleSize", "effectiveSampleSize",
             "averageQuality", "stabilityScore", "gmvFactorP50", "payoutGmvFactorWeighted", "suggestedAlpha", "calculatedAt"
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())`,
          [
            Number(shopId), cohort.scope, cohort.scopeKey, cohort.windowStart, cohort.windowEnd, cohort.sampleSize,
            cohort.effectiveSampleSize, cohort.averageQuality, cohort.stabilityScore, cohort.gmvFactor,
            cohort.payoutGmvFactor, cohort.suggestedAlpha,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function findBestCohort({ shopId, itemId, modelId }) {
  const keys = [];
  if (itemId != null) keys.push(`${itemId}:${modelId == null ? 0 : modelId}`);
  keys.push("*");
  const row = await queryOne(
    `SELECT "scopeType" AS scope_type, "scopeKey" AS scope_key, "sampleSize" AS sample_size,
            "effectiveSampleSize" AS effective_sample_size, "averageQuality" AS average_quality,
            "stabilityScore" AS stability_score, "gmvFactorP50" AS gmv_factor,
            "payoutGmvFactorWeighted" AS payout_gmv_factor, "suggestedAlpha" AS suggested_alpha,
            "calculatedAt" AS calculated_at, "windowStart" AS window_start, "windowEnd" AS window_end
     FROM "PricingV7CalibrationCohort"
     WHERE "shopId" = $1
       AND (("scopeType" = 'ITEM' AND "scopeKey" = $2) OR ("scopeType" = 'SHOP' AND "scopeKey" = $3))
     ORDER BY CASE WHEN "scopeType" = 'ITEM' THEN 0 ELSE 1 END, "calculatedAt" DESC
     LIMIT 1`,
    [Number(shopId), keys[0] || "", "*"],
  );
  return mapCohort(row);
}

async function getSummary(shopId) {
  const [orders, cohort] = await Promise.all([
    queryOne(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE "isFinalized")::int AS finalized,
              COUNT(*) FILTER (WHERE "isProvisional")::int AS provisional,
              COUNT(*) FILTER (WHERE "excludedFromCalibration" OR "isOutlier")::int AS excluded,
              COALESCE(AVG("financialQualityScore"), 0) AS average_quality
       FROM "PricingV7CalibrationOrder" WHERE "shopId" = $1`,
      [Number(shopId)],
    ),
    findBestCohort({ shopId }),
  ]);
  return {
    totalOrders: numberOrZero(orders?.total),
    finalizedOrders: numberOrZero(orders?.finalized),
    provisionalOrders: numberOrZero(orders?.provisional),
    excludedOrders: numberOrZero(orders?.excluded),
    averageQuality: numberOrZero(orders?.average_quality),
    cohort,
  };
}

async function listCalibrationOrders({ shopId, page = 1, pageSize = 50 }) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(200, Number(pageSize) || 50));
  const [total, result] = await Promise.all([
    queryOne('SELECT COUNT(*)::int AS total FROM "PricingV7CalibrationOrder" WHERE "shopId" = $1', [Number(shopId)]),
    query(
      `SELECT "orderSn" AS order_sn, "itemId" AS item_id, "modelId" AS model_id, sku, "financialState" AS financial_state,
              "financialQualityScore" AS quality, "gmvPaidCents" AS gmv_paid_cents, "payoutCents" AS payout_cents,
              "cmvCents" AS cmv_cents, "taxCents" AS tax_cents, "isProvisional" AS is_provisional,
              "isFinalized" AS is_finalized, "isOutlier" AS is_outlier, "excludedFromCalibration" AS excluded,
              "exclusionReason" AS exclusion_reason, reconciliation, "commissionCents" AS commission_cents, "serviceFeeCents" AS service_fee_cents, "rebateCents" AS rebate_cents, "adjustmentCents" AS adjustment_cents, "sourceUpdatedAt" AS source_updated_at
       FROM "PricingV7CalibrationOrder" WHERE "shopId" = $1
       ORDER BY "sourceUpdatedAt" DESC NULLS LAST, id DESC LIMIT $2 OFFSET $3`,
      [Number(shopId), safePageSize, (safePage - 1) * safePageSize],
    ),
  ]);
  return { total: numberOrZero(total?.total), page: safePage, pageSize: safePageSize, rows: result.rows };
}

module.exports = { replaceCalibration, findBestCohort, getSummary, listCalibrationOrders };
