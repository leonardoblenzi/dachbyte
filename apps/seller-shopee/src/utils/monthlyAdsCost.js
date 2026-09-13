const {
  listMonthlyAdsExpenseByItemId,
  listPaidOrderSalesQtyByItemId,
} = require("../repositories/monthlyAdsCostSqlRepository");

function getCurrentMonthRange(anchorDate = new Date()) {
  const year = anchorDate.getUTCFullYear();
  const month = anchorDate.getUTCMonth();

  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));

  return { start, end };
}

async function buildMonthlyAdsCostIndex({
  shopId,
  anchorDate = new Date(),
  start,
  end,
} = {}) {
  const range =
    start instanceof Date && end instanceof Date
      ? { start, end }
      : getCurrentMonthRange(anchorDate);

  const [adsRows, salesRows] = await Promise.all([
    listMonthlyAdsExpenseByItemId(shopId, range.start, range.end),
    listPaidOrderSalesQtyByItemId(shopId, range.start, range.end),
  ]);

  const soldByItemId = new Map();
  for (const row of salesRows) {
    soldByItemId.set(String(row.itemId), Number(row.quantity || 0));
  }

  const index = new Map();
  for (const row of adsRows) {
    const itemId = String(row.itemId);
    const monthlySpendCents = Number(row.expense || 0);
    const monthlySoldQty = Number(soldByItemId.get(itemId) || 0);
    const costPerSaleCents =
      monthlySpendCents > 0 && monthlySoldQty > 0
        ? Math.round(monthlySpendCents / monthlySoldQty)
        : 0;

    index.set(itemId, {
      itemId,
      monthlySpendCents,
      monthlySoldQty,
      costPerSaleCents,
      hasAdsSpend: monthlySpendCents > 0,
    });
  }

  return {
    range,
    byItemId: index,
  };
}

function getAllocatedAdsCostForItems(items, adsCostIndex) {
  let totalAdsCostCents = 0;

  for (const item of items || []) {
    const qty = Number(item?.quantity || 0);
    if (qty <= 0 || item?.itemId == null) continue;

    const monthly = adsCostIndex?.get(String(item.itemId));
    if (!monthly?.hasAdsSpend || !monthly.costPerSaleCents) continue;

    totalAdsCostCents += monthly.costPerSaleCents * qty;
  }

  return totalAdsCostCents;
}

module.exports = {
  getCurrentMonthRange,
  buildMonthlyAdsCostIndex,
  getAllocatedAdsCostForItems,
};
