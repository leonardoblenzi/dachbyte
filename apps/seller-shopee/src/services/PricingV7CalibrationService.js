"use strict";

const { listMarginOrdersWithItems } = require("../repositories/analyticsSqlRepository");
const calibrationRepository = require("../repositories/pricingV7SqlRepository");
const pricingRepository = require("../repositories/pricingV6SqlRepository");
const { calculateRealizedOrder } = require("./PricingV7Engine");
const { assessFinancialReview } = require("./PricingV7FinancialReview");
const { getOrderFinancialBreakdownForCalibration } = require("../controllers/MarginController");

const EXCLUDED_STATUSES = ["CANCELLED", "UNPAID", "IN_CANCEL", "TO_RETURN", "REQUESTED_RETURN", "RETRY_SHIP"];

function asCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.abs(number)) : 0;
}

function moneyToCents(value) {
  if (value == null) return 0;
  const raw = typeof value === "string" ? Number(value.replace(",", ".")) : Number(value);
  return Number.isFinite(raw) ? Math.round(Math.abs(raw) * 100) : 0;
}

function orderIncome(order) {
  const raw = order?.incomeDetailRaw;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {});
    return parsed?.order_income || parsed?.response?.order_income || parsed || {};
  } catch (_error) {
    return {};
  }
}

function money(info, fields, fallback = 0) {
  for (const field of fields) {
    if (info?.[field] != null) return moneyToCents(info[field]);
  }
  return asCents(fallback);
}

function itemMoney(info, fields) {
  return (Array.isArray(info?.items) ? info.items : []).reduce(
    (total, item) => total + money(item, fields),
    0,
  );
}

function itemTotalCents(item) {
  if (Number.isFinite(Number(item?.calibrationItemTotalCents))) return asCents(item.calibrationItemTotalCents);
  const quantity = Math.max(1, Number(item?.quantity || 1));
  if (item?.orderPrice != null) return asCents(item.orderPrice);
  if (item?.variationPrice != null) return moneyToCents(item.variationPrice) * quantity;
  return 0;
}

function itemCmvCents(item) {
  if (Number.isFinite(Number(item?.calibrationItemCmvCents))) return asCents(item.calibrationItemCmvCents);
  return asCents(item?.productCostCents || item?.product?.costCents) * Math.max(1, Number(item?.quantity || 1));
}

function normalizeCalibrationItems(orderItems) {
  const grouped = new Map();
  const items = Array.isArray(orderItems) && orderItems.length ? orderItems : [{}];
  items.forEach((item, index) => {
    const localItemId = Number(item?.id);
    const hasRemoteItemId = item?.itemId != null && Number.isFinite(Number(item.itemId));
    const itemId = hasRemoteItemId
      ? Number(item.itemId)
      : -(Number.isFinite(localItemId) && localItemId > 0 ? localItemId : index + 1);
    const modelId = item?.modelId != null && Number.isFinite(Number(item.modelId)) ? Number(item.modelId) : 0;
    const key = `${itemId}:${modelId}`;
    const totalCents = itemTotalCents(item);
    const cmvCents = itemCmvCents(item);
    const current = grouped.get(key);
    if (current) {
      current.calibrationItemTotalCents += totalCents;
      current.calibrationItemCmvCents += cmvCents;
      return;
    }
    grouped.set(key, {
      ...item,
      itemId,
      modelId,
      calibrationItemTotalCents: totalCents,
      calibrationItemCmvCents: cmvCents,
    });
  });
  return [...grouped.values()];
}

function orderDate(order) {
  const date = new Date(order?.shopeeCreateTime || order?.createdAt || Date.now());
  return Number.isNaN(date.valueOf()) ? new Date() : date;
}

function allocation(totalCents, itemCents, orderItemsCents) {
  if (orderItemsCents <= 0) return 0;
  return Math.round(asCents(totalCents) * itemCents / orderItemsCents);
}

function statusIsFinal(status) {
  return ["COMPLETED", "PROCESSED", "RECEIVED"].includes(String(status || "").toUpperCase());
}

function allocateNestedCents(value, itemCents, totalCents) {
  if (Array.isArray(value)) return value.map((entry) => allocateNestedCents(entry, itemCents, totalCents));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, allocateNestedCents(entry, itemCents, totalCents)]));
  return typeof value === "number" ? allocation(value, itemCents, totalCents) : value;
}

function mapOrderRows(order, taxRate) {
  const status = String(order?.orderStatus || "").toUpperCase();
  const items = normalizeCalibrationItems(order?.items);
  const itemTotals = items.map(itemTotalCents);
  const itemsTotal = itemTotals.reduce((sum, value) => sum + value, 0);
  const promoTotal = itemsTotal || asCents(order?.itemsSubtotalCents);
  const margin = getOrderFinancialBreakdownForCalibration(order, taxRate);
  const financialDetails = margin.financialDetailsCents || {};
  const gmvTotal = asCents(margin.revenueCents);
  const payoutTotal = asCents(margin.netReceivedCents);
  const sellerCouponTotal = asCents(margin.costsCents?.voucher);
  const platformCouponTotal = asCents(financialDetails.discounts?.shopeeVoucher) + asCents(financialDetails.discounts?.shopeeDiscount);
  const coinsTotal = asCents(financialDetails.discounts?.coins);
  const buyerShippingTotal = asCents(financialDetails.shipping?.buyerPaid);
  const commissionTotal = asCents(financialDetails.fees?.commissionNet);
  const serviceFeeTotal = Math.max(0, asCents(margin.costsCents?.commissions) - commissionTotal);
  const marketplaceRebateTotal = asCents(margin.creditsCents?.shopeeRebates);
  const adjustmentTotal = Math.abs(Number(margin.otherShopeeAdjustmentsCents || 0));
  const actualShippingTotal = asCents(financialDetails.shipping?.actual);
  const configuredTaxTotal = asCents(margin.costsCents?.configuredTaxes);
  const financialReview = margin.financialReview || assessFinancialReview({ gmvCents: gmvTotal, payoutCents: payoutTotal, itemsRevenueCents: asCents(margin.itemsRevenueCents), buyerShippingCents: buyerShippingTotal, actualShippingCents: actualShippingTotal, payoutReconciliationDeltaCents: adjustmentTotal });
  const finalized = statusIsFinal(status) && Boolean(order?.incomeSyncedAt) && payoutTotal > 0;
  const excludedByStatus = EXCLUDED_STATUSES.includes(status);

  return items.map((item, index) => {
    const itemValue = itemTotals[index] || Math.round(promoTotal / items.length);
    const gmvPaidCents = allocation(gmvTotal, itemValue, promoTotal);
    const row = calculateRealizedOrder({
      promotionalPriceCents: itemValue,
      sellerCouponCents: allocation(sellerCouponTotal, itemValue, promoTotal),
      platformCouponCents: allocation(platformCouponTotal, itemValue, promoTotal),
      coinsCents: allocation(coinsTotal, itemValue, promoTotal),
      buyerShippingCents: allocation(buyerShippingTotal, itemValue, promoTotal),
      gmvPaidCents,
      payoutCents: allocation(payoutTotal, itemValue, promoTotal),
      cmvCents: itemCmvCents(item),
      taxCents: allocation(configuredTaxTotal, itemValue, promoTotal),
      // Returns are already reflected in the final Shopee payout; keep them in the audit breakdown only.
      returnCostCents: 0,
      externalCostCents: allocation(margin.costsCents?.shipping, itemValue, promoTotal),
    });
    const reconciliationTolerance = Math.max(100, Math.round(row.gmvPaidCents * 0.03));
    const baseQuality = Math.min(1, (row.gmvPaidCents > 0 ? 0.15 : 0) + (row.payoutCents > 0 ? 0.35 : 0) + (finalized ? 0.25 : 0) + (Math.abs(row.checkoutDeltaCents) <= reconciliationTolerance ? 0.15 : 0) + (!excludedByStatus ? 0.1 : 0));
    const quality = financialReview.requiresReview ? Math.min(baseQuality, 0.5) : baseQuality;
    const isOutlier = row.gmvFactor <= 0 || row.gmvFactor > 3 || row.payoutGmvFactor <= 0 || row.payoutGmvFactor > 1.2 || row.marginRate < -2 || row.marginRate > 1;
    const isFinalized = finalized && !financialReview.requiresReview;
    const excluded = excludedByStatus || isOutlier || !isFinalized || quality < 0.75;
    return {
      ...row, orderId: order?.id, orderSn: String(order?.orderSn || order?.id || "sem-pedido"),
      itemId: item?.itemId == null ? 0 : Number(item.itemId), modelId: item?.modelId == null ? 0 : Number(item.modelId), sku: item?.modelSku || item?.itemSku || null,
      financialState: isFinalized ? "FINALIZED" : "PROVISIONAL", financialQualityScore: quality,
      commissionCents: allocation(commissionTotal, itemValue, promoTotal), serviceFeeCents: allocation(serviceFeeTotal, itemValue, promoTotal),
      rebateCents: allocation(marketplaceRebateTotal, itemValue, promoTotal), adjustmentCents: allocation(adjustmentTotal, itemValue, promoTotal),
      financialSource: "ORDER_MARGIN_REAL", isProvisional: !isFinalized, isFinalized, isOutlier, excludedFromCalibration: excluded,
      exclusionReason: excludedByStatus ? "status_excluido" : isOutlier ? "outlier" : financialReview.requiresReview ? financialReview.reasons.join(",") : !finalized ? "financeiro_provisorio" : quality < 0.75 ? "qualidade_insuficiente" : null,
      reconciliation: {
        checkoutDeltaCents: row.checkoutDeltaCents, taxBaseCents: row.taxBaseCents,
        financialDetailsCents: allocateNestedCents(financialDetails, itemValue, promoTotal),
        rawFinancialFieldsCents: allocateNestedCents(margin.rawFinancialFieldsCents || [], itemValue, promoTotal),
        realCostsCents: allocateNestedCents({ commissions: margin.costsCents?.commissions, shipping: margin.costsCents?.shipping, ownLogisticsShipping: margin.costsCents?.ownLogisticsShipping, vouchers: margin.costsCents?.voucher, returns: margin.costsCents?.returns, shopeeTaxes: margin.costsCents?.orderTaxes, configuredTaxes: margin.costsCents?.configuredTaxes, ads: margin.costsCents?.ads }, itemValue, promoTotal),
        payoutReconciliationCents: allocateNestedCents(margin.reconciliationCents || {}, itemValue, promoTotal),
        ...financialReview,
      },
      sourceUpdatedAt: order?.incomeSyncedAt || order?.updatedAt || orderDate(order), sourceDate: orderDate(order),
    };
  });
}
function weightedAverage(rows, property) {
  const totalWeight = rows.reduce((total, row) => total + row.weight, 0);
  return totalWeight ? rows.reduce((total, row) => total + Number(row[property] || 0) * row.weight, 0) / totalWeight : 0;
}

function percentile(rows, property) {
  const values = rows.map((row) => Number(row[property] || 0)).filter((value) => value > 0).sort((a, b) => a - b);
  return values.length ? values[Math.floor((values.length - 1) * 0.5)] : 0;
}

function buildCohort(scope, scopeKey, rows, start, end) {
  const eligible = rows.filter((row) => !row.excludedFromCalibration).map((row) => ({
    ...row,
    weight: Math.exp(-Math.max(0, (end.valueOf() - row.sourceDate.valueOf()) / 86400000) / 45) * row.financialQualityScore,
  }));
  const payoutValues = eligible.map((row) => row.payoutGmvFactor).filter(Boolean);
  const averagePayout = payoutValues.length ? payoutValues.reduce((sum, value) => sum + value, 0) / payoutValues.length : 0;
  const variance = payoutValues.length ? payoutValues.reduce((sum, value) => sum + (value - averagePayout) ** 2, 0) / payoutValues.length : 1;
  const averageQuality = weightedAverage(eligible, "financialQualityScore");
  const stabilityScore = Math.max(0, Math.min(1, 1 - Math.sqrt(variance) / Math.max(averagePayout, 0.01)));
  return {
    scope, scopeKey, windowStart: start, windowEnd: end, sampleSize: eligible.length,
    effectiveSampleSize: eligible.reduce((sum, row) => sum + row.weight, 0), averageQuality, stabilityScore,
    gmvFactor: percentile(eligible, "gmvFactor"), payoutGmvFactor: weightedAverage(eligible, "payoutGmvFactor"),
    suggestedAlpha: Math.max(0, Math.min(1, averageQuality * stabilityScore)),
  };
}

async function rebuild({ shopId, taxRate = 0, windowDays = 180 }) {
  const end = new Date();
  const start = new Date(end.valueOf() - Math.max(30, Math.min(365, Number(windowDays) || 180)) * 86400000);
  const orders = await listMarginOrdersWithItems(Number(shopId), start, end, EXCLUDED_STATUSES);
  const rows = orders.flatMap((order) => mapOrderRows(order, taxRate));
  const cohorts = [buildCohort("SHOP", "*", rows, start, end)];
  const byItem = new Map();
  for (const row of rows) {
    const key = `${row.itemId}:${row.modelId}`;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(row);
  }
  for (const [key, values] of byItem) {
    if (values.filter((row) => !row.excludedFromCalibration).length >= 3) cohorts.push(buildCohort("ITEM", key, values, start, end));
  }
  await calibrationRepository.replaceCalibration({ shopId, rows, cohorts });
  await pricingRepository.invalidateAllReusableSnapshots({ shopId });
  return calibrationRepository.getSummary(shopId);
}

async function summary(shopId) { return calibrationRepository.getSummary(shopId); }
async function orders({ shopId, page, pageSize }) { return calibrationRepository.listCalibrationOrders({ shopId, page, pageSize }); }

module.exports = { rebuild, summary, orders, _test: { mapOrderRows, buildCohort, allocateNestedCents } };
