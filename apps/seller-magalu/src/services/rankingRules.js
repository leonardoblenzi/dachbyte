"use strict";

// Regras do ranking de anuncios do Magalu (as mesmas do ranking do Mercado Livre).
// Usadas pela API (ao vivo) e pelas fotos mensais do worker.

const LIMITS = [10, 15, 30, 50, 100];
const MAX_RANGE_DAYS = 366;
const RANKING_TYPES = ["faturamento", "quantidade"];

function badRequest(message, code = "MAGALU_RANKING_INVALID") { return Object.assign(new Error(message), { status: 400, code }); }

// ---------- Datas (fuso de Sao Paulo) ----------
function todaySp(now = new Date()) {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Date(`${ymd}T00:00:00.000Z`);
}
function ymd(date) { return date.toISOString().slice(0, 10); }
function addDays(date, days) { const d = new Date(date); d.setUTCDate(d.getUTCDate() + days); return d; }
function addMonths(date, months) { const d = new Date(date); d.setUTCMonth(d.getUTCMonth() + months); return d; }
function startOfMonth(date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)); }
function endOfMonth(date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)); }
function startOfQuarter(date) { return new Date(Date.UTC(date.getUTCFullYear(), Math.floor(date.getUTCMonth() / 3) * 3, 1)); }
function endOfQuarter(date) { const s = startOfQuarter(date); return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 3, 0)); }
function parseDate(value) {
  const s = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function clampRange(fromValue, toValue) {
  let from = parseDate(fromValue), to = parseDate(toValue);
  if (!from || !to) throw badRequest("Informe datas válidas (início e fim).");
  if (from > to) [from, to] = [to, from];
  if ((to - from) / 86400000 + 1 > MAX_RANGE_DAYS) from = addDays(to, -(MAX_RANGE_DAYS - 1));
  return { from: ymd(from), to: ymd(to) };
}
function rangeDays(range) { return Math.max(1, Math.round((parseDate(range.to) - parseDate(range.from)) / 86400000) + 1); }

function resolveMainRange(query = {}, now = new Date()) {
  const today = todaySp(now);
  const period = String(query.periodo || "mes_atual").toLowerCase();
  if (period === "personalizado") return clampRange(query.dataInicio, query.dataFim);
  if (period === "ultimos_7_dias") return { from: ymd(addDays(today, -6)), to: ymd(today) };
  if (period === "ultimos_30_dias") return { from: ymd(addDays(today, -29)), to: ymd(today) };
  if (period === "trimestre") return { from: ymd(startOfQuarter(today)), to: ymd(today) };
  if (period === "semestre") return { from: ymd(addMonths(today, -6)), to: ymd(today) };
  return { from: ymd(startOfMonth(today)), to: ymd(today) };
}

function resolveCompareRange(query = {}, mainRange, now = new Date()) {
  const mode = String(query.compararCom || "periodo_anterior").toLowerCase();
  const mainFrom = parseDate(mainRange.from);
  if (mode === "personalizado") return clampRange(query.dataComparacaoInicio, query.dataComparacaoFim);
  if (mode === "ultimos_7_dias") { const today = todaySp(now); return { from: ymd(addDays(today, -6)), to: ymd(today) }; }
  if (mode === "mes_anterior") { const prev = addMonths(startOfMonth(mainFrom), -1); return { from: ymd(startOfMonth(prev)), to: ymd(endOfMonth(prev)) }; }
  if (mode === "trimestre_anterior") { const prev = addMonths(startOfQuarter(mainFrom), -3); return { from: ymd(prev), to: ymd(endOfQuarter(prev)) }; }
  if (mode === "semestre_anterior") { const to = addDays(mainFrom, -1); return { from: ymd(addMonths(to, -6)), to: ymd(to) }; }
  const days = rangeDays(mainRange);
  return { from: ymd(addDays(mainFrom, -days)), to: ymd(addDays(mainFrom, -1)) };
}

// ---------- Regras do ranking (mesmas do ML) ----------
function deltaPercent(current, previous) {
  if (!previous) return current ? null : 0;
  return ((current - previous) / previous) * 100;
}

function performanceStatus(row) {
  if (!row.previous_position) return "Novo no ranking";
  const movement = row.previous_position - row.position;
  const revenueDelta = row.revenue_delta_percent;
  if (movement >= 2 && revenueDelta > 10) return "Crescendo";
  if (movement <= -3 && revenueDelta < -10) return "Perdendo força";
  if (revenueDelta < -5 || movement <= -2) return "Atenção";
  if (Math.abs(movement) <= 1 && Math.abs(revenueDelta || 0) < 10) return "Estável";
  return "Crescendo";
}

function normalizeRow(row) {
  const units = Number(row.units || 0), revenue = Number(row.revenue || 0);
  return {
    sku: String(row.sku), title: row.title || String(row.sku), brand: row.brand || "",
    image_url: row.image_url || null, marketplace_url: row.marketplace_url || null,
    fulfillment: row.fulfillment === true,
    units, revenue: Math.round(revenue * 100) / 100, orders: Number(row.orders || 0),
    average_ticket: units > 0 ? revenue / units : 0,
    stock: row.stock_known ? Number(row.stock_quantity || 0) : null,
  };
}

function applyFilters(rows, filters = {}) {
  return rows.filter((row) => {
    if (filters.q && !`${row.sku} ${row.title} ${row.brand}`.toLowerCase().includes(filters.q)) return false;
    if (filters.fulfillment !== null && filters.fulfillment !== undefined && row.fulfillment !== filters.fulfillment) return false;
    return true;
  });
}

function applyPositions(rows, orderBy) {
  const metric = orderBy === "quantidade" ? "units" : "revenue";
  const other = metric === "units" ? "revenue" : "units";
  return rows.slice().sort((a, b) => (b[metric] - a[metric]) || (b[other] - a[other]) || a.sku.localeCompare(b.sku))
    .map((row, index) => ({ ...row, position: index + 1 }));
}

function buildInsights({ ranking, exited, totalRevenue, limit }) {
  const insights = [];
  const label = (row) => `${row.sku} (${String(row.title).slice(0, 48)})`;
  const entered = ranking.filter((row) => !row.previous_position);
  const climbed = ranking.filter((row) => row.position_movement > 0).sort((a, b) => b.position_movement - a.position_movement);
  const dropped = ranking.filter((row) => row.position_movement < 0).sort((a, b) => a.position_movement - b.position_movement);
  const withDelta = ranking.filter((row) => Number.isFinite(row.revenue_delta_percent));
  const growing = withDelta.slice().sort((a, b) => b.revenue_delta_percent - a.revenue_delta_percent).filter((row) => row.revenue_delta_percent > 0);
  const falling = withDelta.slice().sort((a, b) => a.revenue_delta_percent - b.revenue_delta_percent).filter((row) => row.revenue_delta_percent < 0);
  const losing = ranking.filter((row) => ["Atenção", "Perdendo força"].includes(row.performance_status));
  const sum = (rows) => rows.reduce((total, row) => total + row.revenue, 0);
  const topShare = totalRevenue > 0 ? sum(ranking) / totalRevenue : 0;
  const top5Share = totalRevenue > 0 ? sum(ranking.slice(0, 5)) / totalRevenue : 0;
  const fmt = (value) => Number(value || 0).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  if (climbed[0]) insights.push({ type: "growth", severity: "success", title: "Maior alta", message: `${label(climbed[0])} subiu ${climbed[0].position_movement} posições e assumiu o #${climbed[0].position}.` });
  if (dropped[0]) insights.push({ type: "drop", severity: "danger", title: "Maior queda", message: `${label(dropped[0])} caiu ${Math.abs(dropped[0].position_movement)} posições e variou ${fmt(dropped[0].revenue_delta_percent)}% em faturamento.` });
  if (entered.length) insights.push({ type: "entered", severity: "info", title: "Entrou no ranking", message: `${entered.length} anúncio${entered.length > 1 ? "s entraram" : " entrou"} no Top ${limit} neste período.` });
  if (exited.length) insights.push({ type: "exited", severity: "danger", title: "Saiu do ranking", message: `${exited.length} anúncio${exited.length > 1 ? "s saíram" : " saiu"} do Top ${limit}. ${label(exited[0])} era #${exited[0].previous_position}.` });
  if (losing[0]) insights.push({ type: "attention", severity: "warning", title: "Perdendo performance", message: `${label(losing[0])} pede atenção: ${losing[0].performance_status.toLowerCase()} e ${fmt(losing[0].revenue_delta_percent)}% em faturamento.` });
  if (growing[0]) insights.push({ type: "revenue_up", severity: "success", title: "Maior crescimento de faturamento", message: `${label(growing[0])} cresceu ${fmt(growing[0].revenue_delta_percent)}% em vendas brutas.` });
  if (falling[0]) insights.push({ type: "revenue_down", severity: "danger", title: "Maior queda de faturamento", message: `${label(falling[0])} reduziu ${fmt(Math.abs(falling[0].revenue_delta_percent))}% em vendas brutas.` });
  insights.push({ type: "concentration", severity: topShare >= 0.65 ? "warning" : "info", title: `Concentração Top ${limit}`, message: `Top ${limit} anúncios representam ${fmt(topShare * 100)}% do faturamento total. Top 5 concentra ${fmt(top5Share * 100)}%.` });
  return insights;
}

// currentTotals/previousTotals: totais do mes guardados na foto mensal (a foto so tem o Top N).
function buildRankingPayload({ currentRows, previousRows, mainRange, compareRange, orderBy, limit, filters, currentTotals = null, previousTotals = null, sources = null }) {
  const current = applyPositions(applyFilters(currentRows.map(normalizeRow), filters), orderBy);
  const previous = applyPositions(applyFilters(previousRows.map(normalizeRow), filters), orderBy);
  const previousBySku = new Map(previous.map((row) => [row.sku, row]));
  const currentTop = current.slice(0, limit);
  const currentTopSkus = new Set(currentTop.map((row) => row.sku));
  const totalRevenue = currentTotals ? Number(currentTotals.revenue) || 0 : current.reduce((sum, row) => sum + row.revenue, 0);
  const totalUnits = currentTotals ? Number(currentTotals.units) || 0 : current.reduce((sum, row) => sum + row.units, 0);
  const previousRevenue = previousTotals ? Number(previousTotals.revenue) || 0 : previous.reduce((sum, row) => sum + row.revenue, 0);
  const previousUnits = previousTotals ? Number(previousTotals.units) || 0 : previous.reduce((sum, row) => sum + row.units, 0);

  const ranking = currentTop.map((row) => {
    const prev = previousBySku.get(row.sku) || null;
    const share = totalRevenue > 0 ? row.revenue / totalRevenue : 0;
    const previousShare = previousRevenue > 0 && prev ? prev.revenue / previousRevenue : 0;
    const output = {
      ...row,
      previous_position: prev?.position || null,
      position_movement: prev?.position ? prev.position - row.position : null,
      previous_revenue: prev?.revenue || 0,
      previous_units: prev?.units || 0,
      previous_average_ticket: prev?.average_ticket || 0,
      revenue_delta_percent: deltaPercent(row.revenue, prev?.revenue || 0),
      units_delta: row.units - (prev?.units || 0),
      revenue_share: share,
      previous_revenue_share: previousShare,
      revenue_share_delta_pp: (share - previousShare) * 100,
    };
    output.performance_status = performanceStatus(output);
    return output;
  });

  const exited = previous.slice(0, limit).filter((row) => !currentTopSkus.has(row.sku))
    .map((row) => ({ ...row, exited: true, previous_position: row.position, position: null, performance_status: "Saiu do ranking" }));
  const bestUp = ranking.filter((row) => row.position_movement > 0).sort((a, b) => b.position_movement - a.position_movement)[0] || null;
  const bestDown = ranking.filter((row) => row.position_movement < 0).sort((a, b) => a.position_movement - b.position_movement)[0] || null;
  const topRevenue = ranking.reduce((sum, row) => sum + row.revenue, 0);

  return {
    ok: true,
    meta: { limit, order_by: orderBy, main_range: mainRange, compare_range: compareRange, products_sold: currentTotals ? Number(currentTotals.products) || current.length : current.length, generated_at: new Date().toISOString(), sources: sources || { main: "live", compare: "live" } },
    summary: {
      revenue_total: Math.round(totalRevenue * 100) / 100,
      revenue_delta_percent: deltaPercent(totalRevenue, previousRevenue),
      previous_revenue_total: Math.round(previousRevenue * 100) / 100,
      units_total: totalUnits,
      units_delta_percent: deltaPercent(totalUnits, previousUnits),
      previous_units_total: previousUnits,
      average_ticket: totalUnits > 0 ? totalRevenue / totalUnits : 0,
      average_ticket_delta_percent: deltaPercent(totalUnits > 0 ? totalRevenue / totalUnits : 0, previousUnits > 0 ? previousRevenue / previousUnits : 0),
      top_share: totalRevenue > 0 ? topRevenue / totalRevenue : 0,
      best_up: bestUp, best_down: bestDown,
    },
    ranking,
    exited_ranking: exited,
    insights: buildInsights({ ranking, exited, totalRevenue, limit }),
  };
}

// Mes fechado inteiro (ex.: 2026-10-01 a 2026-10-31, antes do mes atual): pode usar foto mensal.
function isClosedMonthRange(range, now = new Date()) {
  const from = parseDate(range?.from), to = parseDate(range?.to);
  if (!from || !to) return false;
  if (range.from !== ymd(startOfMonth(from)) || range.to !== ymd(endOfMonth(from))) return false;
  return startOfMonth(from) < startOfMonth(todaySp(now));
}

// Ultimos N meses fechados, do mais recente para o mais antigo.
function closedMonths(count, now = new Date()) {
  const current = startOfMonth(todaySp(now));
  return Array.from({ length: Math.max(0, count) }, (_, index) => {
    const start = addMonths(current, -(index + 1));
    return { from: ymd(start), to: ymd(endOfMonth(start)) };
  });
}

module.exports = {
  LIMITS, MAX_RANGE_DAYS, RANKING_TYPES, badRequest,
  todaySp, ymd, parseDate, clampRange, rangeDays, resolveMainRange, resolveCompareRange,
  deltaPercent, performanceStatus, normalizeRow, applyFilters, applyPositions, buildInsights, buildRankingPayload,
  isClosedMonthRange, closedMonths,
};
