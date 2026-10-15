"use strict";

const crypto = require("node:crypto");
const { dateWindows, assertFinancialScope } = require("./financialAnalysisSyncService");
const { ORDER_SCOPE, DELIVERY_SCOPE, hasScope } = require("./orderSyncService");

function jobKey(accountId, from, to) {
  return `magalu-margin-fresh-${Number(accountId)}-${crypto.createHash("sha256").update(`${from}:${to}`).digest("hex").slice(0, 24)}`;
}

function validate(account, from, to) {
  if (!account || String(account.status) !== "active") throw Object.assign(new Error("Conta Magalu ativa não encontrada."), { status: 404 });
  dateWindows(from, to);
  for (const scope of [ORDER_SCOPE, DELIVERY_SCOPE]) {
    if (!hasScope(account, scope)) throw Object.assign(new Error(`Scope ausente: ${scope}.`), { status: 409, code: "MAGALU_MARGIN_SCOPE_MISSING" });
  }
  assertFinancialScope(account);
}

async function runMarginFreshSync({ account, from, to, orders, finance, progress = async () => {} }) {
  validate(account, from, to);
  if (typeof orders !== "function" || typeof finance !== "function") throw new Error("Fontes de sincronização indisponíveis.");
  await progress({ stage: "orders" });
  const orderResult = await orders(account.id, { from, to, onProgress: progress });
  if (orderResult?.status === "partial" || Number(orderResult?.failed || 0) > 0) throw Object.assign(new Error("Sincronização parcial de pedidos ou entregas."), { code: "MAGALU_MARGIN_ORDERS_PARTIAL" });
  await progress({ stage: "financial" });
  const financialResult = await finance(account, { from, to });
  await progress({ stage: "complete" });
  return { orders: Number(orderResult?.scanned || 0), reports: Number(financialResult?.persisted || 0) };
}

module.exports = { jobKey, validate, runMarginFreshSync };
