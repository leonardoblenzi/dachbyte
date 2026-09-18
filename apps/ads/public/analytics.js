"use strict";

(() => {
  const state = { range: 30, accountId: null, data: null, chartMetric: "spend" };
  const accountSelect = document.querySelector("[data-analytics-account]");
  const status = document.querySelector("[data-analytics-status]");
  const campaignsHost = document.querySelector("[data-analytics-campaigns]");
  const keywordsHost = document.querySelector("[data-analytics-keywords]");
  const searchTermsHost = document.querySelector("[data-analytics-search-terms]");
  const conversionHost = document.querySelector("[data-analytics-conversions]");
  const chartHost = document.querySelector("[data-analytics-chart]");
  const chartMetric = document.querySelector("[data-analytics-chart-metric]");
  const periodLabel = document.querySelector("[data-analytics-period-label]");
  const attribution = document.querySelector("[data-analytics-attribution]");

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  async function request(url) {
    const response = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    return payload;
  }
  function money(value, currency) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    try { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: currency || "BRL", maximumFractionDigits: 2 }).format(Number(value)); }
    catch { return Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 }); }
  }
  function number(value, digits = 0) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    return Number(value).toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  function percent(value, digits = 2) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    return `${number(Number(value) * 100, digits)}%`;
  }
  function ratio(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    return `${number(value, 2)}x`;
  }
  function date(value) {
    if (!value) return "—";
    const [y,m,d] = String(value).slice(0,10).split("-");
    return y && m && d ? `${d}/${m}/${y}` : String(value);
  }
  function dateTime(value) {
    if (!value) return "Nunca";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString("pt-BR");
  }
  function deltaText(value, inverse = false) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "Sem base comparável";
    const n = Number(value);
    const direction = n > 0 ? "↑" : n < 0 ? "↓" : "→";
    const quality = inverse ? (n < 0 ? "is-good" : n > 0 ? "is-bad" : "") : (n > 0 ? "is-good" : n < 0 ? "is-bad" : "");
    return { text: `${direction} ${number(Math.abs(n) * 100, 1)}% vs. período anterior`, quality };
  }
  function formatKpi(key, value, currency) {
    if (["spend","cpc","cpa","conversionValue"].includes(key)) return money(value, currency);
    if (["ctr","conversionRate"].includes(key)) return percent(value);
    if (key === "roas") return ratio(value);
    if (key === "conversions") return number(value, 2);
    return number(value, 0);
  }
  function setStatus(text, tone = "info") {
    if (!status) return;
    status.textContent = text;
    status.className = `ads-alert ads-alert--${tone}`;
  }
  function tableEmpty(host, colspan, text) {
    if (!host) return;
    host.replaceChildren();
    const row = document.createElement("tr"); const cell = el("td", "ads-table-empty", text); cell.colSpan = colspan; row.append(cell); host.append(row);
  }
  function cellText(text, sub) {
    const cell = document.createElement("td");
    cell.append(el("strong", "ads-table-title", text || "—"));
    if (sub) cell.append(el("small", "ads-table-subtitle", sub));
    return cell;
  }

  function renderAccounts(data) {
    if (!accountSelect) return;
    const selected = data.account?.id || state.accountId;
    accountSelect.replaceChildren();
    (data.accounts || []).forEach((account) => {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = `${account.name || account.external_account_id} · ${account.currency_code || "—"}`;
      option.selected = account.id === selected;
      accountSelect.append(option);
    });
    state.accountId = selected || accountSelect.value || null;
  }

  function renderKpis(data) {
    const current = data.summary?.current || {}; const deltas = data.summary?.delta || {}; const currency = data.account?.currency_code;
    ["spend","conversions","cpa","roas","ctr","cpc"].forEach((key) => {
      const valueNode = document.querySelector(`[data-analytics-kpi="${key}"]`);
      const deltaNode = document.querySelector(`[data-analytics-delta="${key}"]`);
      if (valueNode) valueNode.textContent = formatKpi(key, current[key], currency);
      if (deltaNode) {
        const d = deltaText(deltas[key], key === "cpa" || key === "cpc");
        deltaNode.textContent = typeof d === "string" ? d : d.text;
        deltaNode.classList.remove("is-good","is-bad");
        if (typeof d !== "string" && d.quality) deltaNode.classList.add(d.quality);
      }
    });
    ["spend","conversions","cpa","roas"].forEach((key) => {
      const node = document.querySelector(`[data-dashboard-kpi="${key}"]`);
      const deltaNode = document.querySelector(`[data-dashboard-delta="${key}"]`);
      if (node) node.textContent = formatKpi(key, current[key], currency);
      if (deltaNode) {
        const d = deltaText(deltas[key], key === "cpa");
        deltaNode.textContent = typeof d === "string" ? d : d.text;
      }
    });
  }

  function renderCampaigns(rows, currency) {
    if (!campaignsHost) return;
    campaignsHost.replaceChildren();
    if (!rows?.length) return tableEmpty(campaignsHost, 7, "Nenhuma campanha com dados no período.");
    rows.forEach((item) => {
      const row = document.createElement("tr");
      row.append(
        cellText(item.name, item.channel_type || item.bidding_strategy_type || null),
        cellText(item.status || "—"),
        cellText(money(item.spend, currency)),
        cellText(number(item.clicks)),
        cellText(number(item.conversions, 2)),
        cellText(money(item.cpa, currency)),
        cellText(ratio(item.roas)),
      );
      campaignsHost.append(row);
    });
  }

  function renderKeywords(rows, currency) {
    if (!keywordsHost) return;
    keywordsHost.replaceChildren();
    if (!rows?.length) return tableEmpty(keywordsHost, 7, "Nenhuma palavra-chave com dados no período.");
    rows.forEach((item) => {
      const row = document.createElement("tr");
      row.append(
        cellText(item.keyword_text, item.ad_group_name),
        cellText(item.campaign_name),
        cellText(item.match_type || "—", item.negative ? "Negativa" : null),
        cellText(money(item.spend, currency)),
        cellText(number(item.clicks)),
        cellText(number(item.conversions, 2)),
        cellText(money(item.cpa, currency)),
      );
      keywordsHost.append(row);
    });
  }

  function renderSearchTerms(rows, currency) {
    if (!searchTermsHost) return;
    searchTermsHost.replaceChildren();
    if (!rows?.length) return tableEmpty(searchTermsHost, 7, "Nenhum termo de pesquisa disponível no período.");
    rows.forEach((item) => {
      const row = document.createElement("tr");
      row.append(
        cellText(item.search_term, item.search_term_status || null),
        cellText(item.campaign_name, item.ad_group_name),
        cellText(money(item.spend, currency)),
        cellText(number(item.clicks)),
        cellText(number(item.conversions, 2)),
        cellText(money(item.cpa, currency)),
        cellText(ratio(item.roas)),
      );
      searchTermsHost.append(row);
    });
  }

  function renderConversions(rows) {
    if (!conversionHost) return;
    conversionHost.replaceChildren();
    if (!rows?.length) {
      conversionHost.append(el("div", "ads-loading-row", "Nenhuma ação de conversão sincronizada.")); return;
    }
    rows.forEach((item) => {
      const card = el("div", "ads-conversion-action");
      const badge = el("span", `ads-mini-badge ${item.primary_for_goal ? "" : "ads-mini-badge--neutral"}`, item.primary_for_goal ? "Principal" : "Secundária");
      const copy = el("div"); copy.append(el("strong", "", item.name || `Conversão ${item.id}`), el("small", "", `${item.category || item.action_type || "Tipo não informado"} · ${item.status || "—"}`));
      card.append(copy, badge); conversionHost.append(card);
    });
  }

  function chartValue(item) { return Number(item?.[state.chartMetric] || 0); }
  function renderChart(data) {
    if (!chartHost) return;
    chartHost.replaceChildren();
    const rows = data.daily || [];
    if (!rows.length) { chartHost.append(el("div", "ads-loading-row", "Nenhuma série diária disponível.")); return; }
    const width = 900, height = 250, padX = 34, padY = 24;
    const values = rows.map(chartValue); const max = Math.max(...values, 0);
    const usableW = width - padX * 2, usableH = height - padY * 2;
    const points = rows.map((item, index) => {
      const x = padX + (rows.length === 1 ? usableW / 2 : (index / (rows.length - 1)) * usableW);
      const y = padY + usableH - (max > 0 ? (chartValue(item) / max) * usableH : 0);
      return { x, y, item };
    });
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg"); svg.setAttribute("viewBox", `0 0 ${width} ${height}`); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Evolução diária da métrica selecionada");
    for (let i = 0; i < 4; i += 1) {
      const line = document.createElementNS(ns, "line"); const y = padY + (usableH / 3) * i; line.setAttribute("x1", padX); line.setAttribute("x2", width - padX); line.setAttribute("y1", y); line.setAttribute("y2", y); line.setAttribute("class", "ads-chart-gridline"); svg.append(line);
    }
    const poly = document.createElementNS(ns, "polyline"); poly.setAttribute("points", points.map((p) => `${p.x},${p.y}`).join(" ")); poly.setAttribute("class", "ads-chart-line"); svg.append(poly);
    points.forEach((point) => { const c = document.createElementNS(ns, "circle"); c.setAttribute("cx", point.x); c.setAttribute("cy", point.y); c.setAttribute("r", "3.5"); c.setAttribute("class", "ads-chart-point"); const title = document.createElementNS(ns, "title"); title.textContent = `${date(point.item.metricDate)} · ${chartValue(point.item).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}`; c.append(title); svg.append(c); });
    chartHost.append(svg);
    if (periodLabel) periodLabel.textContent = `${date(data.period?.startDate)} a ${date(data.period?.endDate)} · dados até ${date(data.freshness?.latestMetricDate)}`;
  }

  function render(data) {
    state.data = data; renderAccounts(data);
    if (!data.available) {
      const msg = data.reason === "no_synced_metrics" ? "A conta está selecionada, mas ainda não existem métricas sincronizadas. O worker precisa concluir a primeira coleta." : "Nenhuma conta Google Ads foi selecionada para sincronização.";
      setStatus(msg, "warning");
      return;
    }
    const accountName = data.account?.name || data.account?.external_account_id || "Google Ads";
    setStatus(`${accountName} · ${data.rangeDays} dias · última coleta ${dateTime(data.freshness?.lastSyncedAt)} · dados até ${date(data.freshness?.latestMetricDate)}`, data.freshness?.lastSyncStatus === "failed" ? "warning" : "info");
    renderKpis(data); renderCampaigns(data.campaigns, data.account?.currency_code); renderKeywords(data.keywords, data.account?.currency_code); renderSearchTerms(data.searchTerms, data.account?.currency_code); renderConversions(data.conversionActions); renderChart(data);
    if (attribution) attribution.textContent = data.attributionNotice || "";
  }

  async function load() {
    setStatus("Carregando analytics do Google Ads…", "info");
    try {
      const query = new URLSearchParams({ range: String(state.range) });
      if (state.accountId) query.set("accountId", state.accountId);
      const data = await request(`/ads/api/analytics/google?${query}`);
      render(data);
    } catch (error) { setStatus(error.message, "danger"); }
  }

  document.querySelectorAll("[data-analytics-range]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-analytics-range]").forEach((node) => node.classList.remove("is-active")); button.classList.add("is-active"); state.range = Number(button.dataset.analyticsRange || 30); void load();
  }));
  accountSelect?.addEventListener("change", () => { state.accountId = accountSelect.value || null; void load(); });
  chartMetric?.addEventListener("change", () => { state.chartMetric = chartMetric.value; if (state.data?.available) renderChart(state.data); });

  void load();
})();
