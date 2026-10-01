(() => {
  "use strict";

  const moneyFmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const numFmt = new Intl.NumberFormat("pt-BR");
  const pctFmt = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let drawer;
  let backdrop;
  let skuLabel;
  let content;
  let lastFocused;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }

  function fmtMoney(value) { return moneyFmt.format(Number(value || 0)); }
  function fmtNum(value) { return numFmt.format(Number(value || 0)); }
  function fmtPct(value) { return `${pctFmt.format(Number(value || 0))}%`; }
  function fmtDate(value) {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString("pt-BR");
  }
  function fmtDeltaPct(value) {
    if (value == null || !Number.isFinite(Number(value))) return "sem historico";
    const n = Number(value);
    return `${n > 0 ? "+" : ""}${pctFmt.format(n)} em 30d`;
  }
  function deltaClass(value, inverse = false) {
    if (value == null || !Number.isFinite(Number(value)) || Number(value) === 0) return "";
    return (Number(value) > 0) === !inverse ? "is-up" : "is-down";
  }

  function trapFocus(event) {
    if (drawer.hidden || event.key !== "Tab") return;
    const focusable = Array.from(drawer.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hidden && element.getClientRects().length);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function ensureShell() {
    if (drawer) return;
    backdrop = document.createElement("div");
    backdrop.className = "fml-history-backdrop";
    backdrop.hidden = true;
    drawer = document.createElement("aside");
    drawer.className = "fml-history-drawer";
    drawer.hidden = true;
    drawer.setAttribute("aria-hidden", "true");
    drawer.setAttribute("aria-label", "Historico do SKU");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.innerHTML = `
      <header class="fml-history-head">
        <div><span>Historico do SKU</span><strong>-</strong></div>
        <button class="fml-history-close" type="button" aria-label="Fechar">x</button>
      </header>
      <div class="fml-history-content"><p class="fml-empty">Selecione um SKU para analisar.</p></div>`;
    skuLabel = drawer.querySelector("strong");
    content = drawer.querySelector(".fml-history-content");
    drawer.querySelector(".fml-history-close").addEventListener("click", close);
    backdrop.addEventListener("click", close);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Tab") trapFocus(event);
      if (event.key === "Escape" && !drawer.hidden) close();
    });
    document.body.append(backdrop, drawer);
  }

  function close() {
    if (!drawer) return;
    drawer.hidden = true;
    backdrop.hidden = true;
    drawer.setAttribute("aria-hidden", "true");
    document.body.classList.remove("fml-history-is-open");
    lastFocused?.focus?.();
  }

  function scalePoints(series = [], key = "price", width = 360, height = 120) {
    const values = series.map((row) => Number(row[key])).filter((value) => Number.isFinite(value) && value > 0);
    if (!values.length) return "";
    const min = Math.min(...values);
    const span = Math.max(1, Math.max(...values) - min);
    return series.map((row, index) => {
      const raw = Number(row[key]);
      const value = Number.isFinite(raw) && raw > 0 ? raw : min;
      const x = series.length <= 1 ? width : (index / (series.length - 1)) * width;
      const y = height - ((value - min) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }

  function renderMiniChart(series = []) {
    const clean = Array.isArray(series) ? series.slice(-24) : [];
    if (!clean.length) return '<div class="fml-history-empty">Sem historico suficiente para montar o grafico.</div>';
    return `<div class="fml-history-chart"><div class="fml-history-chart-head"><span><i class="price"></i>Preco ML</span><span><i class="cost"></i>Custo</span></div><svg viewBox="0 0 360 120" preserveAspectRatio="none" aria-hidden="true"><polyline class="fml-chart-line fml-chart-line--price" points="${escapeHtml(scalePoints(clean, "price"))}"></polyline><polyline class="fml-chart-line fml-chart-line--cost" points="${escapeHtml(scalePoints(clean, "cost"))}"></polyline></svg></div>`;
  }

  function renderMetric(label, value, delta, options = {}) {
    const deltaText = delta == null ? "sem comparativo" : fmtDeltaPct(delta);
    return `<article class="fml-history-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small class="${deltaClass(delta, options.inverseDelta)}">${escapeHtml(deltaText)}</small></article>`;
  }
  function alertClass(tone) {
    if (tone === "danger") return "fml-history-alert--danger";
    return tone === "warn" ? "fml-history-alert--warn" : "fml-history-alert--ok";
  }

  function renderHistory(data) {
    const summary = data.summary || {};
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    const listings = Array.isArray(data.listings) ? data.listings : [];
    const events = Array.isArray(data.events) ? data.events : [];
    skuLabel.textContent = data.sku || "-";
    content.innerHTML = `
      <section class="fml-history-summary">${renderMetric("Custo atual", fmtMoney(summary.current_cost), summary.cost_delta_30d_pct, { inverseDelta: true })}${renderMetric("Preco vigente medio", fmtMoney(summary.current_price), summary.price_delta_30d_pct)}${renderMetric("Margem estimada", summary.estimated_margin_pct == null ? "Nao calculada" : fmtPct(summary.estimated_margin_pct), summary.margin_delta_30d_pp)}</section>
      <section class="fml-history-diagnosis"><strong>Diagnostico</strong><p>${escapeHtml(summary.diagnosis || "Historico carregado para analise.")}</p><small>${escapeHtml(data.meta?.note || "")}</small></section>
      <section class="fml-history-comparisons">${["d7", "d30", "d90"].map((key) => { const item = data.comparisons?.[key] || {}; const label = key === "d7" ? "7 dias" : key === "d30" ? "30 dias" : "90 dias"; return `<article><span>${label}</span><strong class="${deltaClass(item.cost_delta_pct, true)}">Custo ${fmtDeltaPct(item.cost_delta_pct)}</strong><small class="${deltaClass(item.price_delta_pct)}">Preco ${fmtDeltaPct(item.price_delta_pct)}</small></article>`; }).join("")}</section>
      <section class="fml-history-alerts">${alerts.map((alert) => `<article class="fml-history-alert ${alertClass(alert.tone)}"><strong>${escapeHtml(alert.title)}</strong><p>${escapeHtml(alert.description)}</p></article>`).join("")}</section>
      ${renderMiniChart(data.series || [])}
      <section class="fml-history-grid"><article><span>Ultimo custo</span><strong>${fmtDate(summary.last_cost_update)}</strong></article><article><span>Ultimo preco ML</span><strong>${fmtDate(summary.last_price_snapshot)}</strong></article><article><span>Anuncios ligados</span><strong>${fmtNum(summary.listings_count)}</strong></article><article><span>Estoque total</span><strong>${fmtNum(summary.stock_total)}</strong></article></section>
      <section class="fml-history-section"><h3>Anuncios deste SKU</h3><div class="fml-history-listings">${listings.length ? listings.slice(0, 8).map((item) => `<a href="${escapeHtml(item.permalink || "#")}" target="_blank" rel="noopener" class="fml-history-listing"><span>${escapeHtml(item.mlb || "-")}</span><strong>${escapeHtml(item.title || data.sku || "-")}</strong><small>${escapeHtml(item.status || "-")} &middot; ${fmtMoney(item.price)} &middot; estoque ${fmtNum(item.stock)}</small></a>`).join("") : '<p class="fml-history-empty">Nenhum anuncio sincronizado para este SKU ainda.</p>'}</div></section>
      <section class="fml-history-section"><h3>Linha do tempo</h3><div class="fml-history-events">${events.length ? events.map((event) => `<article><span>${fmtDate(event.datetime || event.date)}</span><strong>${escapeHtml(event.label)}</strong><small>${fmtMoney(event.value)}${event.listings_count ? ` em ${fmtNum(event.listings_count)} anuncio(s)` : ""}</small></article>`).join("") : '<p class="fml-history-empty">Sem eventos registrados.</p>'}</div></section>`;
  }

  async function open(sku) {
    if (!sku) return;
    ensureShell();
    if (drawer.hidden) lastFocused = document.activeElement;
    skuLabel.textContent = sku;
    content.innerHTML = '<p class="fml-empty">Carregando historico do SKU...</p>';
    drawer.hidden = false;
    backdrop.hidden = false;
    drawer.setAttribute("aria-hidden", "false");
    document.body.classList.add("fml-history-is-open");
    drawer.querySelector(".fml-history-close").focus();
    try {
      const response = await fetch(`/api/financeiro-ml/costs/${encodeURIComponent(sku)}/timeline?days=180`, {
        credentials: "include", headers: { accept: "application/json" }, cache: "no-store",
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.error || "Falha ao carregar historico.");
      renderHistory(data);
    } catch (error) {
      content.innerHTML = `<p class="fml-empty">${escapeHtml(error.message || "Falha ao carregar historico.")}</p>`;
    }
  }

  window.FinanceiroMlSkuHistory = { open };
})();
