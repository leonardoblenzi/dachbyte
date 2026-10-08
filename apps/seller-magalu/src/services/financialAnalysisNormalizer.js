"use strict";

function amount(transaction) {
  const value = Number(transaction?.value);
  const normalizer = Number(transaction?.normalizer);
  if (!Number.isFinite(value) || !Number.isFinite(normalizer) || normalizer <= 0) {
    throw new Error("Transação financeira com valor ou normalizer inválido.");
  }
  if (transaction.currency && transaction.currency !== "BRL") {
    throw new Error("Transação financeira em moeda não suportada.");
  }
  return value / normalizer;
}

function normalizeReport(report) {
  const orderCode = String(report?.extras?.order_code || report?.external_id || "").trim();
  if (!orderCode) throw new Error("Relatório financeiro sem código do pedido.");
  if (!Array.isArray(report.transactions)) throw new Error("Relatório financeiro sem lista de transações.");
  const sums = { sale: 0, commission: 0, fees: 0, shippingNet: 0, promotionNet: 0, subsidy: 0, discountNet: 0, refundNet: 0, otherNet: 0, ignoredAbsoluteDiscount: 0, netReceivable: 0 };
  for (const row of report.transactions) {
    const type = String(row?.type || "").toUpperCase();
    if (type === "INFORMATIVE") continue;
    if (type !== "CREDIT" && type !== "DEBIT") throw new Error("Tipo de transação financeira desconhecido.");
    const value = amount(row);
    const category = String(row.category || "").toUpperCase();
    const subcategory = String(row.subcategory || "").toUpperCase();
    if (category === "PROMOTION" && subcategory === "ABSOLUTE_DISCOUNT" && type === "DEBIT") {
      sums.ignoredAbsoluteDiscount += value;
      continue;
    }
    const signed = type === "CREDIT" ? value : -value;
    sums.netReceivable += signed;
    if (category === "SALE") sums.sale += signed;
    else if (category === "COMMISSION") sums.commission -= signed;
    else if (category === "FEES") sums.fees -= signed;
    else if (category === "SHIPPING_COST") sums.shippingNet += signed;
    else if (category === "PROMOTION" && type === "CREDIT") sums.subsidy += signed;
    else if (category === "PROMOTION") sums.promotionNet += signed;
    else if (category === "MARKETPLACE") sums.subsidy += signed;
    else if (category === "DISCOUNT") sums.discountNet += signed;
    else if (category === "REFUND") sums.refundNet += signed;
    else sums.otherNet += signed;
  }
  for (const key of Object.keys(sums)) sums[key] = Math.round(sums[key] * 100) / 100;
  return { orderCode, reportId: String(report.id || ""), remoteUpdatedAt: report.updated_at || null, transactionCount: report.transactions.length, ...sums };
}

module.exports = { normalizeReport };
