"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    rows: [],
    summary: {},
    insights: [],
    periodDays: 30,
    pendingPurchaseMlb: null,
    watcher: null,
    renderedJobs: new Set(),
    busy: false,
    watchlistSearch: "",
    inventoryView: "overview",
  };

  function api(path) {
    if (window.ML?.url) return window.ML.url(path);
    if (typeof window.withBase === "function") return window.withBase(path);
    return path;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    }[ch]));
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function setFeedback(text, tone = "") {
    const el = $("inventoryFeedback");
    if (!el) return;
    el.textContent = text || "";
    if (tone) el.dataset.tone = tone;
    else el.removeAttribute("data-tone");
  }

  function fmtNum(value) {
    return new Intl.NumberFormat("pt-BR").format(Number(value || 0));
  }

  function fmtDecimal(value, digits = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function fmtMoney(value) {
    return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function fmtDate(value) {
    const text = String(value || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "-";
    const [y, m, d] = text.split("-");
    return `${d}/${m}/${y}`;
  }

  function plural(value, singular, pluralText) {
    return Number(value || 0) === 1 ? singular : (pluralText || `${singular}s`);
  }

  function relativeTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
    if (minutes < 1) return "agora";
    if (minutes === 1) return "ha 1 minuto";
    if (minutes < 60) return `ha ${minutes} minutos`;
    const hours = Math.round(minutes / 60);
    if (hours === 1) return "ha 1 hora";
    return `ha ${hours} horas`;
  }

  async function fetchJson(path, options = {}) {
    const response = await fetch(api(path), {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.success === false) {
      throw new Error(data?.error || `Falha HTTP ${response.status}`);
    }
    return data;
  }

  function finiteRows(rows = state.rows) {
    return Array.isArray(rows) ? rows : [];
  }

  function riskLabel(row = {}) {
    const map = {
      out: "Ruptura",
      critical: "Critico",
      high: "Alto risco",
      medium: "Atencao",
      low: "Baixo",
      waiting_stock: "Aguardando estoque",
      no_sales: "Sem giro",
    };
    return row.risk_label || map[row.risk_level] || row.risk_level || "-";
  }

  function trendLabel(row = {}) {
    const map = { growth: "Crescimento", down: "Queda", stable: "Estavel" };
    return row.trend_label || map[row.trend_key] || "Sem base";
  }

  function trendDelta(row = {}) {
    const direct = Number(row.trend_delta_pct ?? row.trend_pct ?? row.sales_delta_pct);
    if (Number.isFinite(direct)) return direct;
    const recent = Number(row.sales_30d || 0);
    const previous = Math.max(0, Number(row.sales_60d || 0) - recent);
    if (!previous && !recent) return null;
    if (!previous) return 100;
    return ((recent - previous) / previous) * 100;
  }

  function suggestedInvestment(rows = state.rows) {
    return finiteRows(rows).reduce((sum, row) => {
      const direct = Number(row.suggested_purchase_value || row.metrics?.suggested_purchase_value || 0);
      if (Number.isFinite(direct) && direct > 0) return sum + direct;
      const price = Number(row.price || row.metrics?.price || 0);
      return sum + Math.max(0, Number(row.suggested_restock || 0)) * (Number.isFinite(price) ? price : 0);
    }, 0);
  }

  function latestAnalyzedAt(rows = state.rows) {
    const timestamps = finiteRows(rows)
      .map((row) => new Date(row.last_analyzed_at || row.updated_at || row.metrics?.last_analyzed_at || ""))
      .filter((date) => Number.isFinite(date.getTime()))
      .sort((a, b) => b.getTime() - a.getTime());
    return timestamps[0] || null;
  }

  function summarizeRows(rows = state.rows) {
    const list = finiteRows(rows);
    const coverages = list.map((row) => Number(row.coverage_days)).filter(Number.isFinite);
    const avgCoverage = coverages.length
      ? coverages.reduce((sum, value) => sum + value, 0) / coverages.length
      : null;
    return {
      total: list.length,
      critical: list.filter((row) => ["out", "critical"].includes(String(row.risk_level || ""))).length,
      high: list.filter((row) => String(row.risk_level || "") === "high").length,
      medium: list.filter((row) => String(row.risk_level || "") === "medium").length,
      waiting: list.filter((row) => String(row.purchase_status || "") === "waiting_stock").length,
      avg_coverage_days: avgCoverage == null ? null : Number(avgCoverage.toFixed(1)),
      suggested_restock_total: list.reduce((sum, row) => sum + Number(row.suggested_restock || 0), 0),
    };
  }

  function priorityRows() {
    const order = { out: 6, critical: 5, high: 4, medium: 3, waiting_stock: 2, low: 1, no_sales: 0 };
    return finiteRows()
      .filter((row) => Number(row.suggested_restock || 0) > 0)
      .sort((a, b) => {
        const suggested = Number(b.suggested_restock || 0) - Number(a.suggested_restock || 0);
        if (suggested) return suggested;
        const risk = (order[b.risk_level] || 0) - (order[a.risk_level] || 0);
        if (risk) return risk;
        return Number(a.coverage_days ?? 99999) - Number(b.coverage_days ?? 99999);
      });
  }

  function topDetailRow() {
    return priorityRows()[0] || finiteRows()[0] || null;
  }

  function rowIdentifier(row = {}) {
    return String(row.mlb || row.sku || "").trim();
  }

  function findRow(identifier) {
    const id = String(identifier || "").trim().toUpperCase();
    if (!id) return null;
    return finiteRows().find((item) => String(item.mlb || "").toUpperCase() === id || String(item.sku || "").toUpperCase() === id) || null;
  }

  function rowMatchesSearch(row = {}, query = "") {
    const needle = String(query || "").trim().toUpperCase();
    if (!needle) return true;
    return [row.mlb, row.sku, row.title].some((value) => String(value || "").toUpperCase().includes(needle));
  }

  function mergeRows(rows = []) {
    const map = new Map(finiteRows().map((row) => [row.mlb || row.sku, row]).filter(([key]) => key));
    rows.forEach((row) => {
      const key = row.mlb || row.sku;
      if (key) map.set(key, row);
    });
    state.rows = Array.from(map.values());
    state.summary = summarizeRows(state.rows);
  }

  function restockInvestment(row = {}) {
    const direct = Number(row.suggested_purchase_value || row.metrics?.suggested_purchase_value || 0);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const price = Number(row.price || row.metrics?.price || 0);
    return Number(row.suggested_restock || 0) * (Number.isFinite(price) ? price : 0);
  }

  function restockUrgencyLabel(row = {}) {
    const coverage = Number(row.coverage_days);
    if (!Number.isFinite(coverage)) return "Sem cobertura";
    if (coverage <= 7) return "Urgente";
    if (coverage <= 15) return "Curto prazo";
    if (coverage <= 30) return "Planejar";
    return "Reposicao leve";
  }

  function salesTrendBars(row = {}) {
    const points = [
      ["90d", Number(row.sales_90d || 0)],
      ["60d", Number(row.sales_60d || 0)],
      ["30d", Number(row.sales_30d || 0)],
    ];
    const max = Math.max(1, ...points.map(([, value]) => value));
    return points.map(([label, value]) => `
      <div class="inventory-detail-chart__bar">
        <span style="height:${Math.max(8, Math.round((value / max) * 100))}%"></span>
        <small>${escapeHtml(label)}</small>
        <strong>${fmtNum(value)}</strong>
      </div>`).join("");
  }

  function detailInsights(row = {}) {
    const coverage = Number(row.coverage_days);
    const suggested = Number(row.suggested_restock || 0);
    const delta = trendDelta(row);
    const avgDaily = Number(row.avg_daily || 0);
    const risk = riskLabel(row);
    const rows = [
      {
        tone: Number.isFinite(coverage) && coverage <= 7 ? "danger" : Number.isFinite(coverage) && coverage <= 30 ? "warning" : "success",
        label: "Cobertura",
        value: Number.isFinite(coverage) ? `${fmtDecimal(coverage, 1)} dias` : "Sem base",
        text: Number.isFinite(coverage) && coverage <= 7 ? "Janela critica para reposicao." : Number.isFinite(coverage) && coverage <= 30 ? "Acompanhe antes de virar ruptura." : "Estoque confortavel no ritmo atual.",
      },
      {
        tone: delta == null ? "info" : delta < 0 ? "warning" : "success",
        label: "Demanda",
        value: delta == null ? trendLabel(row) : `${delta >= 0 ? "+" : ""}${fmtDecimal(delta, 0)}%`,
        text: delta == null ? "Ainda sem comparativo confiavel." : delta < 0 ? "Compra deve considerar queda recente." : "Alta recente pode pedir estoque extra.",
      },
      {
        tone: suggested > 0 ? "info" : "success",
        label: "Acao",
        value: suggested > 0 ? `${fmtNum(suggested)} un` : "Sem compra",
        text: suggested > 0 ? `Reposicao sugerida com venda media de ${fmtDecimal(avgDaily, 1)}/dia.` : `Risco ${risk.toLowerCase()} sem compra imediata.`,
      },
    ];

    return rows.map((item) => `
      <article class="inventory-detail-insight" data-tone="${escapeHtml(item.tone)}">
        <small>${escapeHtml(item.label)}</small>
        <strong>${escapeHtml(item.value)}</strong>
        <p>${escapeHtml(item.text)}</p>
      </article>`).join("");
  }

  function renderMetrics() {
    const rows = finiteRows();
    const summary = { ...summarizeRows(rows), ...(state.summary || {}) };
    const critical = Number(summary.critical || 0);
    const high = Number(summary.high || 0);
    const medium = Number(summary.medium || 0);
    const attention = high + medium;
    const restock = Number(summary.suggested_restock_total || 0);
    const investment = suggestedInvestment(rows);
    const avgCoverage = Number(summary.avg_coverage_days);

    setText("metricCritical", fmtNum(critical));
    setText("metricCriticalMeta", critical ? `${fmtNum(critical)} ${plural(critical, "produto")} em ruptura ou ate 7 dias` : "sem ruptura imediata");
    setText("metricAttention", fmtNum(attention));
    setText("metricAttentionMeta", attention ? `${fmtNum(high)} alto risco | ${fmtNum(medium)} em atencao` : "nenhum item em zona curta");
    setText("metricCoverage", Number.isFinite(avgCoverage) ? `${fmtDecimal(avgCoverage, 1)} dias` : "-");
    setText("metricCoverageMeta", Number.isFinite(avgCoverage) ? (avgCoverage <= 15 ? "cobertura baixa" : avgCoverage <= 35 ? "cobertura moderada" : "cobertura confortavel") : "rode uma analise");
    setText("metricInvestment", fmtMoney(investment));
    setText("metricInvestmentMeta", `${fmtNum(restock)} ${plural(restock, "unidade recomendada", "unidades recomendadas")}`);
    setText("inventoryScope", `${fmtNum(summary.total || rows.length)} ${plural(summary.total || rows.length, "produto")}`);
  }

  function renderUrgentPanel() {
    const rows = finiteRows();
    const summary = { ...summarizeRows(rows), ...(state.summary || {}) };
    const critical = Number(summary.critical || 0);
    const high = Number(summary.high || 0);
    const restock = Number(summary.suggested_restock_total || 0);
    const investment = suggestedInvestment(rows);
    const panel = $("urgentPanel");
    const top = topDetailRow();

    if (!rows.length) {
      if (panel) panel.dataset.tone = "neutral";
      setText("urgentEyebrow", "Status da operacao");
      setText("urgentTitle", "Carregue a watchlist para ver prioridades");
      setText("urgentText", "A tela vai destacar produtos criticos, alto risco e reposicao sugerida com base na cobertura atual.");
      return;
    }

    if (critical) {
      if (panel) panel.dataset.tone = "danger";
      setText("urgentEyebrow", "Acao urgente");
      setText("urgentTitle", `${fmtNum(critical)} ${plural(critical, "produto pode", "produtos podem")} romper em ate 7 dias`);
      setText("urgentText", `Reposicao sugerida: ${fmtNum(restock)} unidades${investment > 0 ? `, investimento estimado de ${fmtMoney(investment)}` : ""}. Comece por ${top?.sku || top?.mlb || "itens criticos"}.`);
      return;
    }

    if (high) {
      if (panel) panel.dataset.tone = "warning";
      setText("urgentEyebrow", "Janela curta");
      setText("urgentTitle", `${fmtNum(high)} ${plural(high, "produto esta", "produtos estao")} em alto risco`);
      setText("urgentText", "Ainda ha cobertura, mas a janela de compra esta curta. Revise reposicao antes que vire ruptura.");
      return;
    }

    if (panel) panel.dataset.tone = "success";
    setText("urgentEyebrow", "Operacao controlada");
    setText("urgentTitle", "Nenhum produto em ruptura imediata");
    setText("urgentText", "Mantenha a rotina de monitoramento e acompanhe itens com queda ou sem giro antes de recomprar.");
  }

  function actionItemHtml({ tone, label, value, text, target }) {
    return `
      <article class="inventory-action" data-tone="${escapeHtml(tone)}">
        <small>${escapeHtml(label)}</small>
        <strong>${escapeHtml(value)}</strong>
        <p>${escapeHtml(text)}</p>
        ${target ? `<button class="inventory-mini-btn" type="button" data-scroll-target="${escapeHtml(target)}">Ver detalhes</button>` : ""}
      </article>`;
  }

  function renderActions() {
    const rows = finiteRows();
    const critical = rows.filter((row) => ["out", "critical"].includes(String(row.risk_level || ""))).length;
    const high = rows.filter((row) => String(row.risk_level || "") === "high").length;
    const down = rows.filter((row) => String(row.trend_key || "") === "down").length;
    const growth = rows.filter((row) => String(row.trend_key || "") === "growth").length;
    const waiting = rows.filter((row) => String(row.purchase_status || "") === "waiting_stock").length;
    const slot = $("recommendedActions");
    if (!slot) return;

    if (!rows.length) {
      slot.innerHTML = actionItemHtml({
        tone: "info",
        label: "Sem dados",
        value: "Aguardando leitura",
        text: "Clique em Atualizar dados ou rode uma analise dos vendidos no periodo.",
        target: null,
      });
      return;
    }

    slot.innerHTML = [
      actionItemHtml({
        tone: critical ? "danger" : "success",
        label: "Criticos",
        value: `${fmtNum(critical)} ${plural(critical, "produto")}`,
        text: critical ? "Priorize compra ou redistribuicao de estoque." : "Nenhuma ruptura imediata no recorte.",
        target: "criticalSection",
      }),
      actionItemHtml({
        tone: high ? "warning" : "info",
        label: "Alto risco",
        value: `${fmtNum(high)} ${plural(high, "produto")}`,
        text: high ? "Cobertura curta, entre 8 e 15 dias." : "Sem alto risco no momento.",
        target: "criticalSection",
      }),
      actionItemHtml({
        tone: down ? "warning" : "info",
        label: "Queda",
        value: `${fmtNum(down)} ${plural(down, "produto")}`,
        text: down ? "Investigue demanda antes de recomprar." : "Sem queda relevante nos itens carregados.",
        target: "watchlistSection",
      }),
      actionItemHtml({
        tone: waiting ? "info" : growth ? "success" : "info",
        label: waiting ? "Aguardando" : "Crescimento",
        value: waiting ? `${fmtNum(waiting)} compras` : `${fmtNum(growth)} ${plural(growth, "produto")}`,
        text: waiting ? "Itens com chegada prevista saem da urgencia." : "Itens em alta podem pedir estoque de seguranca.",
        target: "watchlistSection",
      }),
    ].join("");
  }

  function productThumb(row = {}) {
    if (row.thumbnail) return `<img src="${escapeHtml(row.thumbnail)}" alt="" loading="lazy">`;
    return `<span>ML</span>`;
  }

  function productRowHtml(row = {}, { watchlist = false } = {}) {
    const waiting = String(row.purchase_status || "") === "waiting_stock";
    const coverage = row.coverage_days == null ? "-" : `${fmtDecimal(row.coverage_days, 1)}d`;
    const delta = trendDelta(row);
    const deltaText = delta == null ? trendLabel(row) : `${delta >= 0 ? "+" : ""}${fmtDecimal(delta, 0)}%`;
    const stockout = row.stockout_date ? fmtDate(row.stockout_date) : "-";

    return `
      <article class="inventory-product" data-risk="${escapeHtml(row.risk_level || "")}" data-mlb="${escapeHtml(rowIdentifier(row))}">
        <div class="inventory-product__main">
          <div class="inventory-thumb">${productThumb(row)}</div>
          <div>
            <div class="inventory-product__title" title="${escapeHtml(row.title || row.sku || row.mlb || "")}">${escapeHtml(row.title || row.sku || row.mlb || "-")}</div>
            <div class="inventory-product__meta">${escapeHtml(row.mlb || "-")}${row.sku ? ` | ${escapeHtml(row.sku)}` : ""}</div>
          </div>
        </div>
        <div class="inventory-cell"><small>Risco</small><strong><span class="inventory-risk" data-risk="${escapeHtml(row.risk_level || "")}">${escapeHtml(riskLabel(row))}</span></strong></div>
        <div class="inventory-cell"><small>Estoque</small><strong>${fmtNum(row.current_stock || 0)} un</strong></div>
        <div class="inventory-cell"><small>Cobertura</small><strong>${coverage}</strong></div>
        <div class="inventory-cell"><small>Comprar</small><strong>${fmtNum(row.suggested_restock || 0)} un</strong></div>
        <div class="inventory-cell"><small>${waiting ? "Chegada" : "Ruptura"}</small><strong>${waiting ? fmtDate(row.expected_arrival_date) : stockout}</strong></div>
        <div class="inventory-cell"><small>Tendencia</small><strong>${escapeHtml(deltaText)}</strong></div>
        <div class="inventory-product__actions">
          <button class="inventory-mini-btn" type="button" data-detail="${escapeHtml(rowIdentifier(row))}">Detalhar</button>
          ${waiting
            ? `<button class="inventory-mini-btn" type="button" data-clear-purchase="${escapeHtml(row.mlb || "")}">Voltar</button>`
            : `<button class="inventory-mini-btn" type="button" data-purchase="${escapeHtml(row.mlb || "")}">Compra</button>`}
          ${watchlist ? `<button class="inventory-mini-btn inventory-mini-btn--danger" type="button" data-remove-watch="${escapeHtml(row.mlb || "")}">Remover</button>` : ""}
        </div>
      </article>`;
  }

  function renderPriorityRows() {
    const list = priorityRows();
    const slot = $("priorityRows");
    const restockUnits = list.reduce((sum, row) => sum + Number(row.suggested_restock || 0), 0);
    setText("criticalCount", `${fmtNum(list.length)} ${plural(list.length, "item", "itens")} | ${fmtNum(restockUnits)} un`);
    renderRestockOverview(list);
    if (!slot) return;
    if (!list.length) {
      slot.innerHTML = `<article class="inventory-empty">Nenhum produto com compra sugerida no momento.</article>`;
      return;
    }
    slot.innerHTML = list.slice(0, 12).map((row) => productRowHtml(row)).join("");
  }

  function renderRestockOverview(list = priorityRows()) {
    const slot = $("restockOverview");
    if (!slot) return;
    if (!list.length) {
      slot.innerHTML = "";
      return;
    }

    const units = list.reduce((sum, row) => sum + Number(row.suggested_restock || 0), 0);
    const investment = list.reduce((sum, row) => sum + restockInvestment(row), 0);
    const urgent = list.filter((row) => Number(row.coverage_days) <= 15).length;
    const top = list.slice(0, 5);
    const max = Math.max(1, ...top.map((row) => Number(row.suggested_restock || 0)));

    slot.innerHTML = `
      <div class="inventory-restock-cards">
        <article><small>Comprar agora</small><strong>${fmtNum(units)} un</strong><span>${fmtNum(list.length)} ${plural(list.length, "produto")}</span></article>
        <article><small>Investimento</small><strong>${fmtMoney(investment)}</strong><span>estimativa pela fila</span></article>
        <article><small>Mais urgentes</small><strong>${fmtNum(urgent)}</strong><span>ate 15 dias de cobertura</span></article>
      </div>
      <div class="inventory-restock-chart" aria-label="Produtos com maior compra sugerida">
        ${top.map((row) => {
          const value = Number(row.suggested_restock || 0);
          return `
            <button type="button" data-detail="${escapeHtml(rowIdentifier(row))}">
              <span>${escapeHtml(row.sku || row.mlb || "Produto")}</span>
              <strong>${fmtNum(value)} un</strong>
              <i style="width:${Math.max(8, Math.round((value / max) * 100))}%"></i>
              <em>${escapeHtml(restockUrgencyLabel(row))}</em>
            </button>`;
        }).join("")}
      </div>`;
  }

  function renderWatchlist() {
    const rows = finiteRows();
    const filteredRows = rows.filter((row) => rowMatchesSearch(row, state.watchlistSearch));
    const slot = $("watchlistRows");
    setText(
      "watchlistCount",
      state.watchlistSearch
        ? `${fmtNum(filteredRows.length)} de ${fmtNum(rows.length)}`
        : `${fmtNum(rows.length)} ${plural(rows.length, "monitorado", "monitorados")}`,
    );
    if (!slot) return;
    if (!rows.length) {
      slot.innerHTML = `<article class="inventory-empty">Nenhum produto monitorado carregado ainda.</article>`;
      return;
    }
    if (!filteredRows.length) {
      slot.innerHTML = `<article class="inventory-empty">Nenhum produto encontrado para a busca informada.</article>`;
      return;
    }
    slot.innerHTML = filteredRows.slice(0, 50).map((row) => productRowHtml(row, { watchlist: true })).join("");
  }

  function detailMetric(label, value, options = {}) {
    const tone = options.tone ? ` data-tone="${escapeHtml(options.tone)}"` : "";
    const helper = options.helper ? `<span>${escapeHtml(options.helper)}</span>` : "";
    const dot = options.dot ? `<i aria-hidden="true"></i>` : "";
    return `<div class="inventory-detail-metric"${tone}><small>${escapeHtml(label)}</small><strong>${dot}${escapeHtml(value)}</strong>${helper}</div>`;
  }

  function renderDetail(row = topDetailRow()) {
    const slot = $("detailModalContent");
    if (!slot) return;
    if (!row) {
      slot.innerHTML = `<article class="inventory-empty">Selecione um produto na tabela para detalhar.</article>`;
      return;
    }

    const stock = Number(row.current_stock || 0);
    const avgDaily = Number(row.avg_daily || 0);
    const coverage = Number(row.coverage_days);
    const suggested = Number(row.suggested_restock || 0);
    const target = Number(row.ideal_stock || row.metrics?.ideal_stock || 0);
    const safety = Number(row.safety_stock || row.metrics?.safety_stock || 0);
    const calcCoverage = Number.isFinite(coverage) ? `${fmtDecimal(coverage, 1)} dias` : "-";
    const delta = trendDelta(row);
    const deltaText = delta == null ? trendLabel(row) : `${delta >= 0 ? "+" : ""}${fmtDecimal(delta, 0)}%`;
    const deltaTone = delta == null ? "" : (delta < 0 ? "danger" : "success");
    const deltaHelper = delta == null ? "Sem comparativo" : (delta < 0 ? "Queda recente" : "Acima media");
    const purchaseValue = Number(row.suggested_purchase_value || row.metrics?.suggested_purchase_value || 0);
    const analyzedAt = relativeTime(new Date(row.last_analyzed_at || row.updated_at || Date.now()));
    const coverageFormula = Number.isFinite(coverage)
      ? `Cobertura = estoque (${fmtNum(stock)} un) dividido pela venda media diaria (${fmtDecimal(avgDaily, 1)}) = ${fmtDecimal(coverage, 1)} dias.`
      : `Cobertura indisponivel: ainda falta venda media diaria confiavel para este MLB.`;
    const purchaseText = suggested
      ? `Compra sugerida: ${fmtNum(suggested)} unidades para atingir a cobertura planejada${delta != null ? ` considerando tendencia de ${deltaText}` : ""}${purchaseValue > 0 ? `, com investimento estimado de ${fmtMoney(purchaseValue)}` : ""}.`
      : "Compra sugerida: nenhuma reposicao agora; acompanhe a demanda antes de abrir compra.";
    const canPurchase = row.mlb && suggested > 0;
    const coverageTone = Number.isFinite(coverage) ? (coverage <= 7 ? "danger" : "warning") : "";

    slot.innerHTML = `
      <article class="inventory-detail-card">
        <header class="inventory-detail-card__head">
          <div>
            <h3>${escapeHtml(row.title || row.sku || row.mlb || "Produto")}</h3>
            <p>${escapeHtml(row.mlb || "-")}${row.sku ? ` | ${escapeHtml(row.sku)}` : ""} | analisado ${escapeHtml(analyzedAt)}</p>
          </div>
          <button class="inventory-icon-btn" type="button" data-refresh-detail="${escapeHtml(rowIdentifier(row))}" aria-label="Atualizar analise">&#8635;</button>
        </header>
        <div class="inventory-detail-grid">
          ${detailMetric("Risco", riskLabel(row), { tone: row.risk_level || "low", dot: true })}
          ${detailMetric("Estoque", `${fmtNum(stock)} un`)}
          ${detailMetric("Cobertura", calcCoverage, { tone: coverageTone })}
          ${detailMetric("Vendas/dia", fmtDecimal(avgDaily, 1), { helper: "media 30d" })}
          ${detailMetric("Giro", `${fmtDecimal(row.turnover || 0, 2)}x`, { helper: Number(row.turnover || 0) > 0 ? "Base 30d" : "Sem giro" })}
          ${detailMetric("Tendencia", deltaText, { tone: deltaTone, helper: deltaHelper })}
        </div>
        <div class="inventory-detail-body">
          <section class="inventory-detail-chart" aria-label="Vendas por periodo">
            <div>
              <small>Vendas por janela</small>
              <strong>30 / 60 / 90 dias</strong>
            </div>
            <div class="inventory-detail-chart__plot">${salesTrendBars(row)}</div>
          </section>
          <section class="inventory-detail-insights" aria-label="Insights do produto">
            ${detailInsights(row)}
          </section>
        </div>
        <section class="inventory-calc">
          <strong>Como calculamos</strong>
          <p>${escapeHtml(coverageFormula)}</p>
          <p>${escapeHtml(purchaseText)}${target ? ` Estoque ideal: ${fmtNum(target)} un.` : ""}${safety ? ` Seguranca: ${fmtNum(safety)} un.` : ""}</p>
        </section>
        <footer class="inventory-detail-actions">
          <button class="inventory-btn inventory-btn--primary" type="button" data-purchase="${escapeHtml(row.mlb || "")}" ${canPurchase ? "" : "disabled"}>Comprar ${fmtNum(suggested)} unidades</button>
          <button class="inventory-btn inventory-btn--ghost" type="button" data-simulate-detail="${escapeHtml(rowIdentifier(row))}">Simular cenarios</button>
          <button class="inventory-btn inventory-btn--ghost" type="button" data-scroll-target="watchlistSection">Watchlist</button>
        </footer>
      </article>`;
  }

  function renderPayload(payload = {}) {
    state.rows = Array.isArray(payload.rows) ? payload.rows : [];
    state.summary = payload.summary || summarizeRows(state.rows);
    state.insights = Array.isArray(payload.insights) ? payload.insights : [];

    renderMetrics();
    renderUrgentPanel();
    renderActions();
    renderPriorityRows();
    renderWatchlist();

    const total = state.summary.total || state.rows.length || 0;
    const last = latestAnalyzedAt();
    setText("inventoryUpdatedAt", total ? `Atualizado ${relativeTime(last || new Date())} | ${fmtNum(total)} ${plural(total, "produto")}` : "Sem produtos no recorte");
    $("btnExportCsv")?.toggleAttribute("disabled", !state.rows.length);
  }

  function setBusy(active) {
    state.busy = Boolean(active);
    ["btnAnalyzeSold", "btnRefreshStored", "btnLoadWatchlist", "btnOpenAddWatchlist", "btnConfirmAddWatchlist"].forEach((id) => {
      const button = $(id);
      if (button) button.disabled = state.busy;
    });
  }

  function showJob(title, text) {
    const strip = $("inventoryJobStrip");
    if (strip) strip.hidden = false;
    setText("inventoryJobTitle", title || "Analise em andamento");
    setText("inventoryJobText", text || "Preparando leitura de estoque.");
  }

  function hideJob() {
    const strip = $("inventoryJobStrip");
    if (strip) strip.hidden = true;
  }

  async function loadStored({ scrollToWatchlist = false } = {}) {
    setBusy(true);
    setFeedback("Carregando produtos monitorados...");
    try {
      const data = await fetchJson("/api/estoque/alerta?limit=1000");
      renderPayload(data);
      setFeedback("Monitoramento atualizado.", "ok");
      if (scrollToWatchlist) scrollTo("watchlistSection");
    } catch (error) {
      setFeedback(error.message || "Falha ao carregar monitoramento.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function refreshDetail(identifier) {
    const id = String(identifier || "").trim();
    if (!id) return;
    setBusy(true);
    setFeedback("Atualizando analise do produto...");
    try {
      const data = await fetchJson("/api/estoque/alerta/analisar", {
        method: "POST",
        body: JSON.stringify({ source: "manual", query: id, period_days: state.periodDays }),
      });
      mergeRows(Array.isArray(data.rows) ? data.rows : []);
      renderPayload({ rows: state.rows, summary: state.summary, insights: state.insights });
      openDetailModal(rowIdentifier(findRow(id) || {}) || id);
      setFeedback("Analise do produto atualizada.", "ok");
    } catch (error) {
      setFeedback(error.message || "Falha ao atualizar produto.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function addWatchItems() {
    const query = String($("addWatchlistInput")?.value || "").trim();
    if (!query) {
      setFeedback("Informe ao menos um MLB ou SKU para adicionar ao monitoramento.", "error");
      $("addWatchlistInput")?.focus();
      return;
    }

    setBusy(true);
    setFeedback("Analisando e adicionando produtos ao monitoramento...");
    try {
      await fetchJson("/api/estoque/alerta/analisar", {
        method: "POST",
        body: JSON.stringify({ source: "manual", query, period_days: state.periodDays }),
      });
      closeAddWatchlistModal();
      const input = $("addWatchlistInput");
      if (input) input.value = "";
      await loadStored({ scrollToWatchlist: true });
      setFeedback("Produtos adicionados ao monitoramento.", "ok");
    } catch (error) {
      setFeedback(error.message || "Falha ao adicionar produtos ao monitoramento.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function analyzeSoldPeriod() {
    if (state.busy) return;
    setBusy(true);
    showJob("Analise em andamento", `Enviando vendidos dos ultimos ${state.periodDays} dias para processamento.`);
    setFeedback("");
    try {
      const data = await fetchJson("/api/estoque/alerta/analisar-job", {
        method: "POST",
        body: JSON.stringify({ source: "sold_period", period_days: state.periodDays }),
      });
      showJob("Analise em andamento", `Job ${data.process_id || data.job_id || ""} iniciado. A tela atualizara quando terminar.`);
      startJobsWatcher(true);
    } catch (error) {
      hideJob();
      setFeedback(error.message || "Falha ao iniciar analise.", "error");
    } finally {
      setBusy(false);
    }
  }

  function looksLikeStockJob(job = {}) {
    const title = String(job.title || job.label || job.name || "").toLowerCase();
    const source = String(job.source || "").toLowerCase();
    const url = String(job.download_csv_url || job.review_action?.url || "").toLowerCase();
    return title.includes("estoque") || source.includes("stock") || url.includes("/api/estoque/");
  }

  function jobState(job = {}) {
    const raw = String(job.state || job.status || "").toLowerCase();
    if (job.completed && Number(job.errors || 0) > 0) return "failed";
    if (job.completed) return "completed";
    if (raw.includes("erro") || raw.includes("fail")) return "failed";
    return "running";
  }

  async function pollJobs(renderCompleted = false) {
    const data = await fetchJson("/api/estoque/alerta/jobs");
    const jobs = (Array.isArray(data.jobs) ? data.jobs : []).filter(looksLikeStockJob);
    const running = jobs.find((job) => jobState(job) === "running");
    if (running) {
      const processed = Number(running.processed ?? running.done ?? 0);
      const total = Number(running.total ?? running.expected_total ?? 0);
      const progress = total ? `${fmtNum(processed)}/${fmtNum(total)}` : String(running.state || running.status || "processando");
      showJob("Analise em andamento", progress);
      return;
    }

    if (renderCompleted) {
      const completed = jobs.find((job) => (
        job.completed &&
        !state.renderedJobs.has(String(job.id)) &&
        (Number(job.total || 0) > 0 || Number(job.errors || 0) > 0)
      ));
      if (completed) {
        state.renderedJobs.add(String(completed.id));
        const detail = await fetchJson(`/api/estoque/alerta/jobs/${encodeURIComponent(completed.id)}`);
        if (detail?.job?.rows?.length) {
          renderPayload(detail.job);
          setFeedback("Job concluido e estoque atualizado.", "ok");
        } else if (Number(detail?.job?.errors || 0) > 0) {
          setFeedback(detail?.job?.error || detail?.job?.failedReason || "A analise de estoque falhou.", "error");
        }
      }
    }

    hideJob();
    if (state.watcher) {
      clearInterval(state.watcher);
      state.watcher = null;
    }
  }

  function startJobsWatcher(forceRender = false) {
    pollJobs(forceRender).catch(() => {});
    if (state.watcher) return;
    state.watcher = setInterval(() => pollJobs(true).catch(() => {}), 3500);
  }

  function downloadCsv() {
    if (!state.rows.length) return;
    const header = [
      "MLB", "SKU", "Nome", "Estoque", "Vendas 30d", "Vendas 60d", "Vendas 90d",
      "Media diaria", "Cobertura", "Ruptura", "Tendencia", "Risco", "Giro",
      "Reposicao", "Valor sugerido", "Alerta",
    ];
    const rows = state.rows.map((row) => [
      row.mlb,
      row.sku || "",
      row.title || "",
      row.current_stock || 0,
      row.sales_30d || 0,
      row.sales_60d || 0,
      row.sales_90d || 0,
      row.avg_daily || 0,
      row.coverage_days ?? "",
      fmtDate(row.stockout_date),
      trendLabel(row),
      riskLabel(row),
      row.turnover || 0,
      row.suggested_restock || 0,
      row.suggested_purchase_value || row.metrics?.suggested_purchase_value || 0,
      row.alert || row.arrival_alert || "",
    ]);
    const csv = [header, ...rows].map((cols) => cols.map((value) => {
      const text = String(value ?? "");
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `alerta_estoque_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function openPurchaseModal(mlb) {
    const id = String(mlb || "").trim();
    if (!id) return;
    state.pendingPurchaseMlb = id;
    const row = finiteRows().find((item) => item.mlb === id);
    const input = $("purchaseArrivalDate");
    if (input) input.value = row?.expected_arrival_date || "";
    setText("purchaseModalTitle", row?.expected_arrival_date ? "Editar chegada" : "Compra realizada");
    setText("purchaseModalSubtitle", row?.title ? `Informe a data prevista para ${row.title}.` : "Informe a data prevista de chegada do novo estoque.");
    const modal = $("purchaseModal");
    if (modal) {
      modal.hidden = false;
      modal.setAttribute("aria-hidden", "false");
    }
  }

  function closePurchaseModal() {
    state.pendingPurchaseMlb = null;
    const modal = $("purchaseModal");
    if (modal) {
      modal.hidden = true;
      modal.setAttribute("aria-hidden", "true");
    }
  }

  function openDetailModal(identifier) {
    const row = findRow(identifier);
    if (!row) {
      setFeedback("Produto nao encontrado na watchlist carregada.", "error");
      $("watchlistSearchInput")?.focus();
      return;
    }
    renderDetail(row);
    const modal = $("detailModal");
    if (modal) {
      modal.hidden = false;
      modal.setAttribute("aria-hidden", "false");
    }
  }

  function openAddWatchlistModal() {
    const modal = $("addWatchlistModal");
    if (modal) {
      modal.hidden = false;
      modal.setAttribute("aria-hidden", "false");
      setTimeout(() => $("addWatchlistInput")?.focus(), 0);
    }
  }

  function closeAddWatchlistModal() {
    const modal = $("addWatchlistModal");
    if (modal) {
      modal.hidden = true;
      modal.setAttribute("aria-hidden", "true");
    }
  }

  function closeDetailModal() {
    const modal = $("detailModal");
    if (modal) {
      modal.hidden = true;
      modal.setAttribute("aria-hidden", "true");
    }
  }

  async function confirmPurchase() {
    const mlb = state.pendingPurchaseMlb;
    const date = $("purchaseArrivalDate")?.value || "";
    if (!mlb || !date) {
      setFeedback("Informe a data prevista de chegada.", "error");
      return;
    }
    try {
      await fetchJson(`/api/estoque/alerta/${encodeURIComponent(mlb)}/compra-realizada`, {
        method: "POST",
        body: JSON.stringify({ expected_arrival_date: date }),
      });
      closePurchaseModal();
      await loadStored();
      setFeedback("Compra marcada como aguardando chegada.", "ok");
    } catch (error) {
      setFeedback(error.message || "Falha ao salvar compra.", "error");
    }
  }

  async function clearPurchase(mlb) {
    if (!mlb) return;
    try {
      await fetchJson(`/api/estoque/alerta/${encodeURIComponent(mlb)}/limpar-compra`, { method: "POST", body: "{}" });
      await loadStored();
      setFeedback("Produto voltou ao monitoramento normal.", "ok");
    } catch (error) {
      setFeedback(error.message || "Falha ao limpar status.", "error");
    }
  }

  async function removeWatchItem(mlb) {
    if (!mlb) return;
    const row = finiteRows().find((item) => item.mlb === mlb);
    const confirmed = window.confirm(`Remover ${row?.title || row?.sku || mlb} do monitoramento de estoque?`);
    if (!confirmed) return;
    try {
      await fetchJson(`/api/estoque/alerta/${encodeURIComponent(mlb)}`, { method: "DELETE" });
      state.rows = state.rows.filter((item) => item.mlb !== mlb);
      state.summary = summarizeRows(state.rows);
      renderPayload({ rows: state.rows, summary: state.summary, insights: state.insights });
      setFeedback("Produto removido do monitoramento.", "ok");
    } catch (error) {
      setFeedback(error.message || "Falha ao remover produto.", "error");
    }
  }

  function showDetailFor(identifier) {
    openDetailModal(identifier);
  }

  function setInventoryView(view, { scroll = false } = {}) {
    const normalized = ["overview", "restock", "watchlist"].includes(String(view || ""))
      ? String(view)
      : "overview";
    state.inventoryView = normalized;

    document.querySelectorAll("[data-inventory-tab]").forEach((button) => {
      const active = button.dataset.inventoryTab === normalized;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });

    document.querySelectorAll("[data-inventory-view]").forEach((panel) => {
      panel.hidden = panel.dataset.inventoryView !== normalized;
    });

    if (scroll) {
      const activePanel = document.querySelector(`[data-inventory-view="${normalized}"]`);
      activePanel?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function scrollTo(id) {
    if (id === "criticalSection") setInventoryView("restock");
    if (id === "watchlistSection") setInventoryView("watchlist");
    const el = $(id);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function simulateDetail(identifier) {
    const row = findRow(identifier);
    if (!row) return;
    const stock = Number(row.current_stock || 0);
    const suggested = Number(row.suggested_restock || 0);
    const avgDaily = Number(row.avg_daily || 0);
    if (!Number.isFinite(avgDaily) || avgDaily <= 0) {
      setFeedback("Sem venda media suficiente para simular cenarios deste MLB.", "error");
      return;
    }
    const currentCoverage = stock / avgDaily;
    const afterPurchase = (stock + suggested) / avgDaily;
    const highDemandCoverage = (stock + suggested) / (avgDaily * 1.15);
    setFeedback(`Cenario ${row.mlb}: hoje ${fmtDecimal(currentCoverage, 1)} dias; comprando ${fmtNum(suggested)} un vai para ${fmtDecimal(afterPurchase, 1)} dias; com demanda +15% fica em ${fmtDecimal(highDemandCoverage, 1)} dias.`, "ok");
  }

  function bindEvents() {
    document.querySelectorAll("[data-inventory-tab]").forEach((button) => {
      button.addEventListener("click", () => setInventoryView(button.dataset.inventoryTab));
    });

    document.querySelectorAll("[data-period-days]").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll("[data-period-days]").forEach((item) => item.classList.remove("is-active"));
        button.classList.add("is-active");
        state.periodDays = Number(button.dataset.periodDays || 30);
      });
    });

    $("btnRefreshStored")?.addEventListener("click", () => loadStored());
    $("btnLoadWatchlist")?.addEventListener("click", () => loadStored({ scrollToWatchlist: true }));
    $("btnAnalyzeSold")?.addEventListener("click", analyzeSoldPeriod);
    $("btnOpenAddWatchlist")?.addEventListener("click", openAddWatchlistModal);
    $("addWatchlistForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      addWatchItems();
    });
    $("watchlistSearchInput")?.addEventListener("input", (event) => {
      state.watchlistSearch = event.target.value || "";
      renderWatchlist();
    });
    $("btnExportCsv")?.addEventListener("click", downloadCsv);
    $("btnRefreshJobs")?.addEventListener("click", () => pollJobs(true).catch((error) => setFeedback(error.message, "error")));
    $("btnConfirmPurchase")?.addEventListener("click", confirmPurchase);
    $("btnScrollCritical")?.addEventListener("click", () => scrollTo("criticalSection"));

    document.addEventListener("click", (event) => {
      const purchase = event.target.closest("[data-purchase]");
      if (purchase) {
        closeDetailModal();
        openPurchaseModal(purchase.dataset.purchase);
      }

      const clear = event.target.closest("[data-clear-purchase]");
      if (clear) clearPurchase(clear.dataset.clearPurchase);

      const remove = event.target.closest("[data-remove-watch]");
      if (remove) removeWatchItem(remove.dataset.removeWatch);

      const detail = event.target.closest("[data-detail]");
      if (detail) showDetailFor(detail.dataset.detail);

      const refreshButton = event.target.closest("[data-refresh-detail]");
      if (refreshButton) refreshDetail(refreshButton.dataset.refreshDetail);

      const simulate = event.target.closest("[data-simulate-detail]");
      if (simulate) simulateDetail(simulate.dataset.simulateDetail);

      const target = event.target.closest("[data-scroll-target]");
      if (target) {
        closeDetailModal();
        scrollTo(target.dataset.scrollTarget);
      }

      if (event.target.closest("[data-close-purchase]")) closePurchaseModal();
      if (event.target.closest("[data-close-detail]")) closeDetailModal();
      if (event.target.closest("[data-close-add-watchlist]")) closeAddWatchlistModal();

      if (event.target.id === "btnExportDetail") downloadCsv();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeDetailModal();
        closePurchaseModal();
        closeAddWatchlistModal();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    setInventoryView("overview");
    renderPayload({ rows: [], summary: {} });
    startJobsWatcher(false);
    loadStored().catch(() => {});
  });
})();
