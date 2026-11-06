(() => {
  "use strict";
  // Ranking de anúncios do Magalu: mesmas opções do ranking do Mercado Livre
  // (período, comparação, ordenação, Top N, filtros e datas, movimentos, sinais e exportação).
  const $ = (id) => document.getElementById(id);
  const shell = () => window.MagaluSellerShell;
  const account = () => Number(shell()?.getSelectedAccountId?.()) || null;
  const route = () => shell()?.route?.() || "";
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
  const integer = (value) => new Intl.NumberFormat("pt-BR").format(Number(value) || 0);
  const decimal = (value, digits = 1) => new Intl.NumberFormat("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(value) || 0);
  const pct = (value) => `${decimal(value)}%`;
  const shortDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "")); return m ? `${m[3]}/${m[2]}/${m[1]}` : "—"; };
  const deltaTone = (value) => value === null || value === undefined ? "neutral" : Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "neutral";
  const STATUS_TONE = { "Crescendo": "success", "Novo no ranking": "info", "Estável": "neutral", "Atenção": "warning", "Perdendo força": "danger", "Saiu do ranking": "danger" };
  const state = { order: "faturamento", data: null, requestId: 0, loadedFor: null };

  function signedDelta(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "Sem base";
    const n = Number(value);
    return `${n >= 0 ? "+" : "-"}${decimal(Math.abs(n))}%`;
  }

  function movementBadge(row) {
    if (!row.previous_position) return '<span class="mg-ranking-move" data-tone="info">Novo</span>';
    const m = Number(row.position_movement || 0);
    if (m > 0) return `<span class="mg-ranking-move" data-tone="positive">↑ ${m}</span>`;
    if (m < 0) return `<span class="mg-ranking-move" data-tone="negative">↓ ${Math.abs(m)}</span>`;
    return '<span class="mg-ranking-move" data-tone="neutral">=</span>';
  }

  function tooltip(row) {
    const summary = row.previous_position ? `${row.sku} foi de #${row.previous_position} para #${row.position}.` : `${row.sku} entrou no ranking neste período.`;
    const line = (label, value) => `<span class="mg-cmp__row"><span>${esc(label)}</span><b>${esc(value)}</b></span>`;
    return `<span class="mg-cmp__box" role="tooltip"><span class="mg-cmp__title">Comparativo do período</span>${line("Vendas atuais", money(row.revenue))}${line("Vendas anteriores", money(row.previous_revenue))}${line("Qtd. atual", integer(row.units))}${line("Qtd. anterior", integer(row.previous_units))}${line("Ticket atual", money(row.average_ticket))}${line("Ticket anterior", money(row.previous_average_ticket))}${line("Part. atual", pct((row.revenue_share || 0) * 100))}${line("Part. anterior", pct((row.previous_revenue_share || 0) * 100))}${line("Posição", `#${row.position} / ${row.previous_position ? `#${row.previous_position}` : "—"}`)}${line("Resumo", summary)}</span>`;
  }

  // ---------- Filtros ----------
  function updateCustomVisibility() {
    const mainCustom = $("mg-ranking-period")?.value === "personalizado";
    const compareCustom = $("mg-ranking-compare")?.value === "personalizado";
    document.querySelectorAll('[data-ranking-custom="main"]').forEach((el) => { el.hidden = !mainCustom; });
    document.querySelectorAll('[data-ranking-custom="compare"]').forEach((el) => { el.hidden = !compareCustom; });
    if ((mainCustom || compareCustom) && $("mg-ranking-form")) $("mg-ranking-form").querySelector(".mg-ranking-advanced").open = true;
  }

  function params() {
    const query = new URLSearchParams({
      account_id: String(account()),
      periodo: $("mg-ranking-period")?.value || "mes_atual",
      compararCom: $("mg-ranking-compare")?.value || "periodo_anterior",
      ordenarPor: state.order,
      limite: $("mg-ranking-limit")?.value || "10",
    });
    const q = String($("mg-ranking-q")?.value || "").trim();
    if (q) query.set("q", q);
    const fulfillment = $("mg-ranking-fulfillment")?.value || "";
    if (fulfillment) query.set("fulfillment", fulfillment);
    if (query.get("periodo") === "personalizado") { query.set("dataInicio", $("mg-ranking-from")?.value || ""); query.set("dataFim", $("mg-ranking-to")?.value || ""); }
    if (query.get("compararCom") === "personalizado") { query.set("dataComparacaoInicio", $("mg-ranking-compare-from")?.value || ""); query.set("dataComparacaoFim", $("mg-ranking-compare-to")?.value || ""); }
    return query;
  }

  // ---------- Render ----------
  function renderKpis(data) {
    const s = data.summary || {}, limit = data.meta?.limit || 10;
    const up = s.best_up, down = s.best_down;
    const items = [
      { label: "Faturamento total", value: money(s.revenue_total), sub: `${signedDelta(s.revenue_delta_percent)} vs anterior`, tone: deltaTone(s.revenue_delta_percent), hint: `Anterior: ${money(s.previous_revenue_total)}` },
      { label: "Qtd. de vendas", value: `${integer(s.units_total)} un.`, sub: `${signedDelta(s.units_delta_percent)} vs anterior`, tone: deltaTone(s.units_delta_percent), hint: `Anterior: ${integer(s.previous_units_total)} un.` },
      { label: "Ticket médio geral", value: money(s.average_ticket), sub: `${signedDelta(s.average_ticket_delta_percent)} vs anterior`, tone: deltaTone(s.average_ticket_delta_percent) },
      { label: `Top ${limit} representam`, value: pct((s.top_share || 0) * 100), sub: "do faturamento total", tone: "neutral" },
      { label: "Maior crescimento", value: up ? up.sku : "—", sub: up ? `↑ ${up.position_movement} posições` : "Sem alta no período", tone: up ? "positive" : "neutral", hint: up?.title },
      { label: "Maior queda", value: down ? down.sku : "—", sub: down ? `↓ ${Math.abs(down.position_movement)} posições` : "Sem queda no período", tone: down ? "negative" : "neutral", hint: down?.title },
    ];
    $("mg-ranking-kpis").innerHTML = items.map((item) => `<article class="mg-ranking-kpi"${item.hint ? ` title="${esc(item.hint)}"` : ""}><span>${esc(item.label)}</span><strong>${esc(item.value)}</strong><small data-tone="${item.tone}">${esc(item.sub)}</small></article>`).join("");
  }

  function renderTable(data) {
    const rows = Array.isArray(data.ranking) ? data.ranking : [];
    const body = $("mg-ranking-body");
    if (!rows.length) { body.innerHTML = '<tr><td colspan="8" class="mg-ranking-empty">Nenhum anúncio vendido para os filtros selecionados.</td></tr>'; return; }
    body.innerHTML = rows.map((row) => {
      const thumb = row.image_url ? `<img src="${esc(row.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span aria-hidden="true">▢</span>';
      const title = row.marketplace_url ? `<a href="${esc(row.marketplace_url)}" target="_blank" rel="noopener noreferrer">${esc(row.title)}</a>` : esc(row.title);
      const unitDelta = Number(row.units_delta || 0);
      const badges = [row.fulfillment ? '<span class="mg-ranking-badge" data-tone="info">Full</span>' : "", row.stock === 0 ? '<span class="mg-ranking-badge" data-tone="danger">Sem estoque</span>' : ""].join("");
      return `<tr>
        <td><div class="mg-ranking-pos">#${row.position}</div>${movementBadge(row)}</td>
        <td><div class="mg-ranking-product"><div class="mg-ranking-thumb">${thumb}</div><div class="mg-ranking-product__copy"><code>${esc(row.sku)}</code><strong title="${esc(row.title)}">${title}</strong><small>${money(row.average_ticket)} médio no período${row.stock != null ? ` · estoque ${integer(row.stock)}` : ""}</small>${badges ? `<div class="mg-ranking-badges">${badges}</div>` : ""}</div></div></td>
        <td><span class="mg-cmp" tabindex="0"><span class="mg-ranking-value">${money(row.revenue)}</span><small class="mg-ranking-delta" data-tone="${deltaTone(row.revenue_delta_percent)}">${row.previous_revenue ? signedDelta(row.revenue_delta_percent) : "Novo"}</small>${tooltip(row)}</span></td>
        <td><span class="mg-ranking-value">${integer(row.units)} un.</span><small class="mg-ranking-delta" data-tone="${unitDelta > 0 ? "positive" : unitDelta < 0 ? "negative" : "neutral"}">${unitDelta >= 0 ? "↑ +" : "↓ "}${integer(Math.abs(unitDelta))} vs ant.</small></td>
        <td><span class="mg-ranking-value">${pct((row.revenue_share || 0) * 100)}</span><small class="mg-ranking-sub">${row.revenue_share_delta_pp >= 0 ? "+" : "-"}${decimal(Math.abs(row.revenue_share_delta_pp || 0))} p.p.</small></td>
        <td><span class="mg-ranking-value">${money(row.average_ticket)}</span><small class="mg-ranking-sub">ant: ${row.previous_average_ticket ? money(row.previous_average_ticket) : "—"}</small></td>
        <td><span class="mg-ranking-value">${row.previous_position ? `#${row.previous_position}` : "—"}</span></td>
        <td><span class="mg-dashboard-status" data-tone="${STATUS_TONE[row.performance_status] || "neutral"}">${esc(row.performance_status)}</span></td>
      </tr>`;
    }).join("");
  }

  function renderMovement(data) {
    const rows = (data.ranking || []).concat(data.exited_ranking || []).slice(0, Number(data.meta?.limit || 10) + 5);
    $("mg-ranking-movement-label").textContent = `${integer(rows.length)} movimento${rows.length === 1 ? "" : "s"}`;
    $("mg-ranking-movement").innerHTML = rows.length ? rows.map((row) => {
      const exited = row.exited || !row.position;
      return `<div class="mg-ranking-movement__row"><code>${esc(row.sku)}</code><span class="mg-ranking-movement__box">${row.previous_position ? `#${row.previous_position}` : "Não estava"}</span><span aria-hidden="true">→</span><span class="mg-ranking-movement__box">${exited ? "Saiu" : `#${row.position}`}</span><span class="mg-ranking-movement__title" title="${esc(row.title)}">${esc(row.title)}</span>${exited ? '<span class="mg-ranking-move" data-tone="negative">Saiu</span>' : movementBadge(row)}</div>`;
    }).join("") : '<div class="mg-ranking-empty">Sem movimentos neste recorte.</div>';
  }

  function renderInsights(data) {
    const insights = Array.isArray(data.insights) ? data.insights : [];
    $("mg-ranking-insights").innerHTML = insights.length ? insights.map((item) => `<article class="mg-ranking-insight" data-tone="${esc(item.severity || "info")}"><strong>${esc(item.title)}</strong><span>${esc(item.message)}</span></article>`).join("") : '<div class="mg-ranking-empty">Sem sinais para este recorte.</div>';
  }

  function render(data) {
    state.data = data;
    const meta = data.meta || {};
    $("mg-ranking-label").textContent = `Top ${meta.limit || 10} · ordenado por ${meta.order_by === "quantidade" ? "quantidade" : "faturamento"}`;
    const fromHistory = [meta.sources?.main === "snapshot" ? "período" : "", meta.sources?.compare === "snapshot" ? "comparação" : ""].filter(Boolean);
    $("mg-ranking-range").textContent = `${shortDate(meta.main_range?.from)} a ${shortDate(meta.main_range?.to)} comparado com ${shortDate(meta.compare_range?.from)} a ${shortDate(meta.compare_range?.to)} · ${integer(meta.products_sold)} anúncio(s) com venda${fromHistory.length ? ` · ${fromHistory.join(" e ")} do histórico mensal` : ""}`;
    renderKpis(data); renderTable(data); renderMovement(data); renderInsights(data);
  }

  async function load() {
    if (route() !== "/ranking") return;
    if (!account()) { $("mg-ranking-body").innerHTML = '<tr><td colspan="8" class="mg-ranking-empty">Escolha uma conta Magalu para ver o ranking.</td></tr>'; return; }
    const query = params();
    if (query.get("periodo") === "personalizado" && (!query.get("dataInicio") || !query.get("dataFim"))) { shell()?.showAlert?.("Informe início e fim do período personalizado.", "warning"); return; }
    if (query.get("compararCom") === "personalizado" && (!query.get("dataComparacaoInicio") || !query.get("dataComparacaoFim"))) { shell()?.showAlert?.("Informe as datas de comparação.", "warning"); return; }
    const requestId = ++state.requestId;
    $("mg-ranking-body").innerHTML = '<tr><td colspan="8" class="mg-ranking-empty">Carregando ranking…</td></tr>';
    try {
      const data = await shell().fetchJson(`/magalu/api/ranking?${query}`, { loading: "none" });
      if (requestId !== state.requestId || route() !== "/ranking") return;
      state.loadedFor = account();
      render(data);
    } catch (error) {
      if (requestId !== state.requestId) return;
      $("mg-ranking-body").innerHTML = `<tr><td colspan="8" class="mg-ranking-empty">${esc(error.message || "Não foi possível montar o ranking.")}</td></tr>`;
    }
  }

  function exportCsv() {
    const rows = state.data?.ranking || [];
    if (!rows.length) { shell()?.showAlert?.("Nada para exportar neste recorte.", "warning"); return; }
    const head = ["Posição", "Posição anterior", "SKU", "Anúncio", "Vendas brutas", "Vendas anteriores", "Qtd. vendas", "Qtd. anterior", "% participação", "Ticket médio", "Ticket anterior", "Status"];
    const cell = (value) => `"${String(value == null ? "" : value).replace(/"/g, '""')}"`;
    const num = (value, digits = 2) => Number(value || 0).toFixed(digits).replace(".", ",");
    const lines = rows.map((r) => [r.position, r.previous_position || "", r.sku, r.title, num(r.revenue), num(r.previous_revenue), r.units, r.previous_units, num((r.revenue_share || 0) * 100, 1), num(r.average_ticket), num(r.previous_average_ticket), r.performance_status].map(cell).join(";"));
    const blob = new Blob([`﻿${head.map(cell).join(";")}\n${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    const range = state.data?.meta?.main_range || {};
    link.href = URL.createObjectURL(blob);
    link.download = `ranking-magalu-${range.from || ""}-a-${range.to || ""}.csv`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }

  // ---------- Engrenagem: modo performance e histórico mensal (como no ML) ----------
  const MODE_LABELS = { 30: "Leve (30)", 50: "Balanceado (50)", 100: "Detalhado (100)" };
  const config = { data: null, canManage: false, preset: 30 };

  function renderConfig() {
    const data = config.data || { persist_enabled: false, snapshot_limit: 30 };
    const status = $("mg-ranking-persist-status");
    if (status) {
      status.textContent = data.persist_enabled ? `Histórico mensal ativo · ${MODE_LABELS[data.snapshot_limit] || MODE_LABELS[30]}` : "Histórico mensal inativo";
      status.dataset.state = data.persist_enabled ? "on" : "off";
    }
    document.querySelectorAll("[data-ranking-preset]").forEach((button) => {
      button.classList.toggle("is-active", Number(button.dataset.rankingPreset) === config.preset);
      button.disabled = !config.canManage;
    });
    const persist = $("mg-ranking-persist");
    if (persist) { persist.checked = data.persist_enabled === true; persist.disabled = !config.canManage; }
    const save = $("mg-ranking-config-save"); if (save) save.hidden = !config.canManage;
    const readonly = $("mg-ranking-config-readonly"); if (readonly) readonly.hidden = config.canManage;
    const months = $("mg-ranking-config-months");
    if (months) {
      const list = Array.isArray(config.months) ? config.months : [];
      months.textContent = list.length ? `Meses guardados: ${list.map((row) => { const [y, m] = String(row.month).split("-"); return `${m}/${y}`; }).join(", ")}.` : "Nenhum mês guardado ainda.";
    }
  }

  async function loadConfig() {
    if (!account()) return;
    try {
      const data = await shell().fetchJson(`/magalu/api/ranking/config?account_id=${account()}`, { loading: "none" });
      config.data = data.config;
      config.canManage = data.permissions?.can_manage === true;
      config.preset = Number(data.config?.snapshot_limit) || 30;
      config.months = data.snapshots || [];
      renderConfig();
    } catch (error) {
      console.warn("[magalu] ranking config", error);
    }
  }

  function openConfig() { config.preset = Number(config.data?.snapshot_limit) || 30; renderConfig(); $("mg-ranking-config-modal").hidden = false; }
  function closeConfig() { $("mg-ranking-config-modal").hidden = true; }

  async function saveConfig() {
    if (!config.canManage) return;
    const button = $("mg-ranking-config-save");
    button.disabled = true;
    try {
      const data = await shell().fetchJson("/magalu/api/ranking/config", { method: "PUT", body: JSON.stringify({ account_id: account(), persist_enabled: $("mg-ranking-persist")?.checked === true, snapshot_limit: config.preset }) });
      config.data = data.config;
      renderConfig();
      closeConfig();
      shell()?.showAlert?.(data.config?.persist_enabled ? "Histórico mensal ativo. Os meses fechados que faltam estão sendo guardados em segundo plano." : "Configuração do ranking salva.", "success");
      setTimeout(() => void loadConfig(), 8000);
    } catch (error) {
      shell()?.showAlert?.(error.message || "Não foi possível salvar a configuração.", "danger");
    } finally {
      button.disabled = false;
    }
  }

  function bind() {
    $("mg-ranking-config-btn")?.addEventListener("click", openConfig);
    document.querySelectorAll("[data-ranking-config-close]").forEach((button) => button.addEventListener("click", closeConfig));
    document.querySelectorAll("[data-ranking-preset]").forEach((button) => button.addEventListener("click", () => { config.preset = Number(button.dataset.rankingPreset) || 30; renderConfig(); }));
    $("mg-ranking-config-save")?.addEventListener("click", () => void saveConfig());
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("mg-ranking-config-modal")?.hidden) closeConfig(); });
    $("mg-ranking-form")?.addEventListener("submit", (event) => { event.preventDefault(); void load(); });
    document.querySelectorAll("#mg-ranking-order [data-order]").forEach((button) => button.addEventListener("click", () => {
      state.order = button.dataset.order === "quantidade" ? "quantidade" : "faturamento";
      document.querySelectorAll("#mg-ranking-order [data-order]").forEach((item) => item.classList.toggle("is-active", item === button));
      void load();
    }));
    ["mg-ranking-period", "mg-ranking-compare"].forEach((id) => $(id)?.addEventListener("change", () => { updateCustomVisibility(); if ($(id).value !== "personalizado") void load(); }));
    ["mg-ranking-limit", "mg-ranking-fulfillment"].forEach((id) => $(id)?.addEventListener("change", () => void load()));
    $("mg-ranking-export")?.addEventListener("click", exportCsv);
    updateCustomVisibility();
    window.addEventListener("magalu:routechange", (event) => { if (event.detail?.path === "/ranking") { void load(); void loadConfig(); } });
    window.addEventListener("magalu:accountchange", () => { if (route() === "/ranking") { void load(); void loadConfig(); } });
    window.addEventListener("magalu:shellready", () => { if (route() === "/ranking") { void load(); void loadConfig(); } });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind); else bind();
  window.MagaluRanking = { _test: { signedDelta, movementBadge } };
})();
