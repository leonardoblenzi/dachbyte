// @ts-check
"use strict";

/** @param {string} message @param {number} status @param {string} code */
function fail(message, status, code) { return Object.assign(new Error(message), { status, code }); }

const DAY = 86400e3;
const MAX_DAYS = 366;

/** Data "YYYY-MM-DD" no fuso de São Paulo. @param {Date} date */
function dayInSaoPaulo(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** @param {string} day @param {number} days */
function addDays(day, days) { return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10); }

/** @param {unknown} value */
function isDay(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }

/**
 * Período da análise (datas inclusivas, fuso de São Paulo) e o período anterior de mesmo tamanho.
 * Sem datas: últimos 30 dias até hoje.
 * @param {{ from?: string, to?: string }} input @param {Date} now
 */
function resolvePeriod(input, now) {
  const today = dayInSaoPaulo(now);
  const to = input.to || today;
  const from = input.from || addDays(to, -29);
  if (!isDay(from) || !isDay(to)) throw fail("Data inválida. Use AAAA-MM-DD.", 400, "invalid_date");
  if (from > to) throw fail("A data inicial é depois da final.", 400, "invalid_period");
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
  if (days > MAX_DAYS) throw fail("Escolha um período de até 1 ano.", 400, "period_too_long");
  return { from, to, days, previous: { from: addDays(from, -days), to: addDays(from, -1) } };
}

/** Variação % (null quando não há base de comparação). @param {number} current @param {number} previous */
function change(current, previous) { return previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null; }

const round2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;

/**
 * Soma as contas e compara com o período anterior: totais, por canal e por conta.
 * @param {any[]} current @param {any[]} previous
 */
function summarize(current, previous) {
  /** @param {any[]} rows */
  const total = (rows) => rows.reduce((acc, r) => ({
    orders: acc.orders + r.orders, gmv: acc.gmv + r.gmv, cancelledOrders: acc.cancelledOrders + r.cancelledOrders, cancelledValue: acc.cancelledValue + r.cancelledValue,
  }), { orders: 0, gmv: 0, cancelledOrders: 0, cancelledValue: 0 });
  /** @param {ReturnType<typeof total>} cur @param {ReturnType<typeof total>} prev */
  const metrics = (cur, prev) => {
    const ticket = cur.orders ? cur.gmv / cur.orders : 0;
    const prevTicket = prev.orders ? prev.gmv / prev.orders : 0;
    const placed = cur.orders + cur.cancelledOrders;
    return {
      orders: cur.orders, gmv: round2(cur.gmv), ticket: round2(ticket), cancelledOrders: cur.cancelledOrders, cancelledValue: round2(cur.cancelledValue),
      cancelRate: placed ? Math.round((cur.cancelledOrders / placed) * 1000) / 10 : 0,
      previous: { orders: prev.orders, gmv: round2(prev.gmv), ticket: round2(prevTicket) },
      change: { orders: change(cur.orders, prev.orders), gmv: change(cur.gmv, prev.gmv), ticket: change(ticket, prevTicket) },
    };
  };
  const totals = metrics(total(current), total(previous));
  const grandGmv = totals.gmv;
  /** @param {(r: any) => string} keyOf @param {(r: any) => object} labelOf */
  const group = (keyOf, labelOf) => {
    const keys = [...new Set([...current, ...previous].map(keyOf))];
    return keys.map((key) => {
      const cur = current.filter((r) => keyOf(r) === key);
      const prev = previous.filter((r) => keyOf(r) === key);
      const m = metrics(total(cur), total(prev));
      return { ...labelOf(cur[0] || prev[0]), ...m, share: grandGmv ? Math.round((m.gmv / grandGmv) * 1000) / 10 : 0 };
    }).sort((a, b) => b.gmv - a.gmv || b.previous.gmv - a.previous.gmv);
  };
  return {
    totals,
    channels: group((r) => r.channel, (r) => ({ channel: r.channel })),
    accounts: group((r) => String(r.accountId), (r) => ({ accountId: Number(r.accountId), channel: r.channel, account: r.account })),
  };
}

/**
 * Ranking multicanal: soma o mesmo produto (SKU da empresa) em todos os canais, com a fatia de cada canal,
 * participação no total e curva ABC (A até 80% acumulado, B até 95%, C o resto).
 * Linhas sem vínculo ficam pelo SKU do canal, marcadas como pendentes.
 * @param {any[]} rows linhas por produto × canal @param {{ sort?: "revenue" | "units" }} [options]
 */
function rankProducts(rows, { sort = "revenue" } = {}) {
  /** @type {Map<string, any>} */
  const byKey = new Map();
  for (const r of rows) {
    const p = byKey.get(r.key) || { key: r.key, itemId: r.itemId == null ? null : Number(r.itemId), sku: r.sku, name: r.name, pending: r.itemId == null, units: 0, revenue: 0, orders: 0, channels: [] };
    p.units += Number(r.units) || 0;
    p.revenue += Number(r.revenue) || 0;
    p.orders += Number(r.orders) || 0;
    p.channels.push({ channel: r.channel, units: Number(r.units) || 0, revenue: round2(Number(r.revenue) || 0) });
    byKey.set(r.key, p);
  }
  const metric = sort === "units" ? "units" : "revenue";
  const list = [...byKey.values()].sort((a, b) => b[metric] - a[metric] || b.revenue - a.revenue || String(a.sku).localeCompare(String(b.sku)));
  const grand = list.reduce((s, p) => s + p[metric], 0);
  let cumulative = 0;
  return list.map((p, index) => {
    const share = grand ? (p[metric] / grand) * 100 : 0;
    const before = cumulative;
    cumulative += share;
    for (const c of p.channels) c.share = p[metric] ? Math.round(((metric === "units" ? c.units : c.revenue) / p[metric]) * 1000) / 10 : 0;
    p.channels.sort((/** @type {any} */ a, /** @type {any} */ b) => b.revenue - a.revenue);
    return {
      ...p, rank: index + 1, revenue: round2(p.revenue), units: Math.round(p.units * 100) / 100,
      share: Math.round(share * 10) / 10, cumulative: Math.round(cumulative * 10) / 10,
      // A classe vem do acumulado antes do item: o item que cruza 80% ainda é A.
      abc: before < 80 ? "A" : before < 95 ? "B" : "C",
    };
  });
}

/** @param {unknown} value */
function csvCell(value) {
  const s = String(value == null ? "" : value);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Análise do DACH Hub (etapa A1): vendas por canal e conta e mais vendidos multicanal,
 * só com os pedidos que o Hub já guarda.
 * @param {{ repository: ReturnType<typeof import("./repository").createAnalyticsRepository>, now?: () => Date }} deps
 */
function createAnalyticsService({ repository, now = () => new Date() }) {
  /** @param {any} query */
  const filters = (query = {}) => {
    const accountId = query.accountId ? Number(query.accountId) : null;
    if (accountId !== null && !Number.isSafeInteger(accountId)) throw fail("Conta inválida.", 400, "invalid_account");
    return { channel: query.channel ? String(query.channel) : null, accountId };
  };

  return {
    /** Vendas por canal e conta, comparadas ao período anterior. @param {string} tenantId @param {any} [query] */
    async sales(tenantId, query = {}) {
      const period = resolvePeriod(query, now());
      const f = filters(query);
      const [current, previous] = await Promise.all([
        repository.salesByAccount(tenantId, { from: period.from, to: period.to, ...f }),
        repository.salesByAccount(tenantId, { ...period.previous, ...f }),
      ]);
      return { period, ...summarize(current, previous) };
    },

    /** Mais vendidos multicanal com curva ABC. @param {string} tenantId @param {any} [query] */
    async products(tenantId, query = {}) {
      const period = resolvePeriod(query, now());
      const sort = query.sort === "units" ? "units" : "revenue";
      const ranked = rankProducts(await repository.productSales(tenantId, { from: period.from, to: period.to, ...filters(query) }), { sort });
      const limit = Math.min(500, Math.max(1, Number.parseInt(String(query.limit || 50), 10) || 50));
      const pending = ranked.filter((p) => p.pending);
      return {
        period, sort, total: ranked.length,
        abc: ["A", "B", "C"].map((cls) => ({ cls, products: ranked.filter((p) => p.abc === cls).length, revenue: round2(ranked.filter((p) => p.abc === cls).reduce((s, p) => s + p.revenue, 0)) })),
        pending: { products: pending.length, revenue: round2(pending.reduce((s, p) => s + p.revenue, 0)) },
        products: ranked.slice(0, limit),
      };
    },

    /** Ranking completo em CSV (separador ";", padrão do Excel em português). @param {string} tenantId @param {any} [query] */
    async productsCsv(tenantId, query = {}) {
      const { products } = await this.products(tenantId, { ...query, limit: 500 });
      const head = ["Posição", "SKU", "Produto", "Curva", "Unidades", "Pedidos", "Faturamento", "Participação %", "Canais", "Sem vínculo"];
      const lines = products.map((p) => [p.rank, p.sku, p.name, p.abc, p.units, p.orders, p.revenue.toFixed(2).replace(".", ","), String(p.share).replace(".", ","),
        p.channels.map((/** @type {any} */ c) => `${c.channel} ${String(c.share).replace(".", ",")}%`).join(" | "), p.pending ? "sim" : ""]);
      return [head, ...lines].map((row) => row.map(csvCell).join(";")).join("\r\n");
    },
  };
}

module.exports = { createAnalyticsService, resolvePeriod, summarize, rankProducts, dayInSaoPaulo };
