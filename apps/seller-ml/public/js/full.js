"use strict";

(() => {
  const state = {
    products: [],
    planner: null,
    plans: [],
    activeTab: "products",
    plannerMode: "replenishment",
    selectionGroup: "all",
    savingPlanId: null,
    editingPlan: null,
    requestSeq: 0,
    pdfExportFields: [],
  };

  const $ = (id) => document.getElementById(id);
  const qsa = (selector) => Array.from(document.querySelectorAll(selector));

  function appUrl(path) {
    return window.ML?.url ? window.ML.url(path) : typeof window.withBase === "function" ? window.withBase(path) : path;
  }

  function hoverLabel(label, title, rows) {
    const safeLabel = escapeHtml(String(label || ""));
    const safeTitle = escapeHtml(String(title || ""));
    const list = Array.isArray(rows) ? rows : [];
    const body = list
      .map((row) => `<div class="full-hover__row"><span>${escapeHtml(String(row.label || ""))}</span><strong>${escapeHtml(String(row.value || ""))}</strong></div>`)
      .join("");
    return `
      <span class="full-hover">
        <span class="full-hover__label">${safeLabel}</span>
        <span class="full-hover__box">
          <span class="full-hover__title">${safeTitle}</span>
          ${body}
        </span>
      </span>
    `;
  }

  async function apiJson(path, options = {}) {
    const response = await fetch(appUrl(path), {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
    return data;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function number(value, digits = 0) {
    return Number(value || 0).toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function money(cents) {
    return (Number(cents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function dateTime(value) {
    if (!value) return "Nunca atualizado";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "Atualizacao indisponivel";
    return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  function dateOnly(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value).slice(0, 10);
    return date.toLocaleDateString("pt-BR");
  }

  function coverageLabel(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "Sem venda";
    return `${number(value, 1)} dias`;
  }

  function coverageAfterSend(row) {
    const velocity = Number(row?.daily_velocity || 0);
    if (!Number.isFinite(velocity) || velocity <= 0) return null;
    return (Number(row.stock_full || 0) + Number(row.suggested_restock || 0)) / velocity;
  }

  function priorityBadge(priority) {
    const key = String(priority || "").toLowerCase();
    if (key === "high") return `<span class="full-badge full-badge--danger">Alta</span>`;
    if (key === "medium") return `<span class="full-badge full-badge--warn">Media</span>`;
    if (key === "ok") return `<span class="full-badge full-badge--ok">Ok</span>`;
    if (key === "idle") return `<span class="full-badge full-badge--info">Sem venda</span>`;
    return `<span class="full-badge full-badge--info">Baixa</span>`;
  }

  function trendBadge(diagnosis) {
    const key = String(diagnosis?.key || "").toLowerCase();
    const label = escapeHtml(diagnosis?.label || "Estavel");
    if (key === "accelerating") return `<span class="full-badge full-badge--ok">${label}</span>`;
    if (key === "strong") return `<span class="full-badge full-badge--ok">${label}</span>`;
    if (key === "stable") return `<span class="full-badge full-badge--info">${label}</span>`;
    if (key === "attention") return `<span class="full-badge full-badge--warn">${label}</span>`;
    if (key === "drop") return `<span class="full-badge full-badge--danger">${label}</span>`;
    return `<span class="full-badge full-badge--info">${label}</span>`;
  }

  const icons = {
    open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6Z"/><circle cx="12" cy="12" r="2.8"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
    export: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>',
  };

  const PDF_EXPORT_STORAGE_KEY = "fullPdfExportFields";
  const PDF_EXPORT_FIELDS = [
    { key: "photo", label: "Foto", render: (row) => row.image_url ? `<img src="${escapeHtml(row.image_url)}" />` : "" },
    { key: "mlb", label: "MLB", render: (row) => escapeHtml(row.mlb || "-") },
    { key: "sku", label: "SKU", render: (row) => escapeHtml(row.sku || "-") },
    { key: "product", label: "Produto", render: (row) => escapeHtml(row.title || "-") },
    { key: "sold", label: "Vendidos", render: (row) => number(row.units_sold || 0) },
    { key: "stock", label: "Estoque", render: (row) => number(row.stock_full || 0) },
    { key: "suggested", label: "Sugerido", render: (row) => number(row.system_suggested_restock ?? row.suggested_restock ?? 0) },
    { key: "send", label: "Enviar", render: (row) => number(row.suggested_restock || 0) },
    { key: "coverage", label: "Cobertura", render: (row) => coverageLabel(coverageAfterSend(row)) },
    { key: "value", label: "Valor", render: (row) => money(row.suggested_value_cents || 0) },
    { key: "m3", label: "M3", render: (row) => number(row.volume_m3_total || 0, 3) },
  ];

  function parseMoneyToCents(value) {
    const raw = String(value || "").trim().replace(/[^\d,.-]/g, "");
    if (!raw) return 0;
    const normalized = raw.includes(",")
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw;
    const n = Number(normalized);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }

  function currentPlannerItems() {
    return Array.isArray(state.planner?.items) ? state.planner.items : [];
  }

  function selectedPdfFields() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PDF_EXPORT_STORAGE_KEY) || "[]");
      if (Array.isArray(parsed) && parsed.length) {
        const stored = parsed.filter((key) => PDF_EXPORT_FIELDS.some((field) => field.key === key));
        if (stored.length) return stored;
      }
    } catch {}
    const selected = state.pdfExportFields.filter((key) => PDF_EXPORT_FIELDS.some((field) => field.key === key));
    return selected.length ? selected : PDF_EXPORT_FIELDS.map((field) => field.key);
  }

  function loadPdfExportFields() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PDF_EXPORT_STORAGE_KEY) || "[]");
      state.pdfExportFields = Array.isArray(parsed) && parsed.length
        ? parsed.filter((key) => PDF_EXPORT_FIELDS.some((field) => field.key === key))
        : PDF_EXPORT_FIELDS.map((field) => field.key);
    } catch {
      state.pdfExportFields = PDF_EXPORT_FIELDS.map((field) => field.key);
    }
  }

  function computePlannerTotals(payload = state.planner) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const freightCents = parseMoneyToCents($("plannerFreightValue")?.value || "");
    const totalSuggested = items.reduce((sum, row) => sum + Number(row.suggested_restock || 0), 0);
    const totalValueCents = items.reduce((sum, row) => sum + Number(row.suggested_value_cents || 0), 0);
    const totalVolumeM3 = items.reduce((sum, row) => sum + Number(row.volume_m3_total || 0), 0);
    const smallItems = items.filter((row) => row.size_group === "small_medium");
    const largeItems = items.filter((row) => row.size_group === "large_xlarge");
    const smallUnits = smallItems.reduce((sum, row) => sum + Number(row.suggested_restock || 0), 0);
    const largeUnits = largeItems.reduce((sum, row) => sum + Number(row.suggested_restock || 0), 0);
    const freightPct = totalValueCents > 0 ? (freightCents / totalValueCents) * 100 : 0;
    return {
      item_count: items.length,
      total_suggested: totalSuggested,
      total_value_cents: totalValueCents,
      total_volume_m3: totalVolumeM3,
      small_item_count: smallItems.length,
      small_units: smallUnits,
      large_item_count: largeItems.length,
      large_units: largeUnits,
      freight_cents: freightCents,
      freight_pct: freightPct,
    };
  }

  function parseMlbs(value) {
    return Array.from(new Set(String(value || "").split(/[\s,;]+/).map((mlb) => mlb.trim().toUpperCase()).filter(Boolean)));
  }

  function manualMlbsForRequest() {
    const typed = parseMlbs($("plannerManualMlbs")?.value || "");
    if (state.plannerMode !== "manual") return typed;
    const existing = currentPlannerItems().map((row) => String(row.mlb || "").trim().toUpperCase()).filter(Boolean);
    return Array.from(new Set([...existing, ...typed]));
  }

  function productBadges(row) {
    const badges = [`<span class="full-badge full-badge--info">Full</span>`];
    if (Number(row.stock_full || 0) <= 0) badges.push(`<span class="full-badge full-badge--danger">Ruptura</span>`);
    else if (row.coverage_days !== null && Number(row.coverage_days) <= 15) badges.push(`<span class="full-badge full-badge--warn">Baixa cobertura</span>`);
    else badges.push(`<span class="full-badge full-badge--ok">Estavel</span>`);
    if (Number(row.suggested_restock_30d || row.suggested_restock || 0) > 0) badges.push(`<span class="full-badge full-badge--warn">Repor</span>`);
    if (Number(row.sold_30d || row.units_sold || 0) <= 0) badges.push(`<span class="full-badge full-badge--info">Sem venda</span>`);
    return `<div class="full-badge-row">${badges.join("")}</div>`;
  }

  function productCell(row) {
    const img = row.image_url ? `<img src="${escapeHtml(row.image_url)}" alt="" loading="lazy" />` : `<span class="full-product__fallback">F</span>`;
    return `<div class="full-product">${img}<div><strong>${escapeHtml(row.title || row.mlb || "-")}</strong><small>${escapeHtml(row.sku || "Sem SKU")}  -  ${escapeHtml(row.mlb || "-")}</small></div></div>`;
  }

  function renderKpis(kpis = {}) {
    const el = $("fullKpis");
    if (!el) return;
    el.innerHTML = [
      [hoverLabel("Produtos Full", "Produtos Full", [{ label: "Base", value: "Itens sincronizados" }]), number(kpis.products || 0), "Itens ativos carregados"],
      [hoverLabel("Reposicao 30d", "Reposicao 30d", [{ label: "Base", value: "Cobertura 30d" }]), number(kpis.total_suggested_30d || 0), "Unidades sugeridas como base"],
      [hoverLabel("Baixa cobertura", "Baixa cobertura", [{ label: "Regra", value: "Ate 15 dias" }]), number(kpis.low_coverage || 0), "Ate 15 dias de estoque"],
      [hoverLabel("Faturamento 30d", "Faturamento 30d", [{ label: "Escopo", value: "Itens Full" }]), money(kpis.revenue_30d_cents || 0), "Somente produtos Full"],
    ].map(([label, value, hint]) => `<article class="full-kpi"><span>${label}</span><strong>${value}</strong><small>${hint}</small></article>`).join("");
  }

  function renderProducts(payload = {}) {
    state.products = Array.isArray(payload.items) ? payload.items : [];
    renderKpis(payload.kpis || {});
    const syncLabel = $("fullSyncLabel");
    if (syncLabel) syncLabel.textContent = payload.last_synced_at ? `Atualizado em ${dateTime(payload.last_synced_at)}` : "Aguardando atualizacao";
    const meta = $("fullProductsMeta");
    if (meta) meta.textContent = `${number(state.products.length)} produtos exibidos  -  ${number(payload.total_cached || state.products.length)} no cache`;
    const body = $("fullProductsBody");
    if (!body) return;
    if (!state.products.length) {
      body.innerHTML = `<tr><td colspan="6" class="full-empty">Nenhum produto Full carregado. Clique em Atualizar Full.</td></tr>`;
      return;
    }
    body.innerHTML = state.products.map((row) => `
      <tr>
        <td>${productCell(row)}</td>
        <td><div class="full-metric"><strong>${number(row.stock_full)}</strong><small>unidades disponiveis</small></div></td>
        <td><div class="full-metric"><strong>${number(row.sold_7d)} / ${number(row.sold_15d)} / ${number(row.sold_30d)}</strong><small>${money(row.revenue_30d_cents)} em 30d</small></div></td>
        <td><div class="full-metric"><strong>${coverageLabel(row.coverage_days)}</strong><small>base em 30 dias</small></div></td>
        <td><div class="full-metric"><strong>${number(row.suggested_restock_30d)}</strong><small>para 30 dias</small></div></td>
        <td>${productBadges(row)}</td>
      </tr>
    `).join("");
  }

  function renderPlannerTotals(payload) {
    const el = $("fullPlannerTotals");
    if (!el) return;
    if (!payload) return void (el.innerHTML = "");
    const totals = computePlannerTotals(payload);
    const isSelection = payload.settings?.planner_mode === "selection";
    const isManual = payload.settings?.planner_mode === "manual";
    const capLabel = isManual
      ? `formula 40d para ${payload.settings?.coverage_days || 30}d`
      : isSelection
      ? `P/M ${number(totals.small_units)} - G/XG ${number(totals.large_units)}`
      : Number(payload.settings?.storage_capacity || 0) > 0
        ? `capacidade: ${number(payload.settings.storage_capacity)} un`
        : `${payload.settings?.coverage_days || 30} dias de cobertura`;
    const freightOk = totals.freight_pct > 0 && totals.freight_pct <= 5;
    const freightHint = totals.freight_cents > 0
      ? `${number(totals.freight_pct, 2)}% da venda${freightOk ? " - viavel" : " - nao viavel"}`
      : "Informe o frete para validar";
    const cards = [
      [hoverLabel("Itens planejados", "Itens planejados", [{ label: "Base", value: "Itens na carga" }]), number(totals.item_count), payload.range?.label || "Periodo selecionado"],
      [hoverLabel("Unidades planejadas", "Unidades planejadas", [{ label: "Base", value: "Soma da carga" }]), number(totals.total_suggested), capLabel],
      [hoverLabel("Pequenos/medios", "Pequenos/medios", [{ label: "Grupo", value: "Itens compactos" }]), number(totals.small_units), `${number(totals.small_item_count)} itens`],
      [hoverLabel("Grandes/extragrandes", "Grandes/extragrandes", [{ label: "Grupo", value: "Itens volumosos" }]), number(totals.large_units), `${number(totals.large_item_count)} itens`],
      [hoverLabel("Valor de venda", "Valor de venda", [{ label: "Base", value: "Preco atual" }]), money(totals.total_value_cents), "Valor bruto planejado"],
      [hoverLabel("Frete / venda", "Frete / venda", [{ label: "Regra", value: "Ate 5%" }]), totals.freight_cents > 0 ? `${number(totals.freight_pct, 2)}%` : "-", freightHint],
      [hoverLabel("M3 estimado", "M3 estimado", [{ label: "Base", value: "Dimensoes ML" }]), number(totals.total_volume_m3, 3), "Soma aproximada da carga"],
    ];
    el.innerHTML = cards.map(([label, value, hint]) => `<article class="full-kpi"><span>${label}</span><strong>${value}</strong><small>${hint}</small></article>`).join("");
  }

  function plannerRows(items, emptyMessage, options = {}) {
    const editable = options.editable !== false;
    const manual = options.manual === true;
    const colspan = editable ? 11 : 10;
    if (!items?.length) return `<tr><td colspan="${colspan}" class="full-empty">${escapeHtml(emptyMessage || "Nenhum item encontrado.")}</td></tr>`;
    return items.map((row, index) => `
      <tr>
        <td>${productCell(row)}</td>
        <td><div class="full-metric"><strong>${number(row.units_sold)}</strong><small>${row.formula_basis === "manual_40d" ? "ultimos 40d" : money(row.revenue_cents)}</small></div></td>
        <td><div class="full-trend"><strong>${number(row.sold_7d)} / ${number(row.sold_15d)} / ${number(row.sold_30d)}</strong><small>7d/15d/30d  -  ${row.trend_diagnosis?.detail || (row.trend ? `${number(row.trend.growth_7_vs_30_pct, 1)}% vs 30d` : "sem tendencia")}</small></div></td>
        <td><div class="full-metric"><strong>${number(row.daily_velocity, 2)}</strong><small>un/dia</small></div></td>
        <td><div class="full-metric"><strong>${number(row.stock_full)}</strong><small>no Full</small></div></td>
        <td><div class="full-metric"><strong>${coverageLabel(coverageAfterSend(row))}</strong><small>atual ${coverageLabel(row.coverage_days)}</small></div></td>
        <td><div class="full-metric"><strong>${number(row.volume_m3_total, 3)}</strong><small>${number(row.volume_m3_unit, 3)} un.</small></div></td>
        <td>${manual && editable
          ? `<input class="full-unit-input" type="number" min="0" value="${number(row.suggested_restock).replace(/\./g, "")}" data-planner-units="${index}" aria-label="Unidades planejadas" />`
          : `<div class="full-metric"><strong>${number(row.suggested_restock)}</strong><small>${money(row.suggested_value_cents || row.suggested_restock * row.price_cents)}</small></div>`}
        </td>
        <td><div class="full-metric"><strong>${number(row.system_suggested_restock ?? row.suggested_restock)}</strong><small>calculado</small></div></td>
        <td>${trendBadge(row.trend_diagnosis)}<div class="full-metric"><small>${row.size_group === "large_xlarge" ? "grandes/extragrandes" : "pequenos/medios"}</small></div></td>
        ${editable ? `<td><button class="full-icon-btn full-icon-btn--danger" type="button" data-planner-remove="${index}" title="Remover da carga" aria-label="Remover da carga">${icons.trash}</button></td>` : ""}
      </tr>
    `).join("");
  }

  function renderPlanner(payload) {
    state.planner = payload;
    if (state.planner) state.planner.totals = computePlannerTotals(state.planner);
    renderPlannerTotals(payload);
    const meta = $("fullPlannerMeta");
    if (meta) {
      const modeLabel = payload?.settings?.planner_mode === "manual"
        ? "Manual"
        : payload?.settings?.planner_mode === "selection"
          ? "Selecao para envio"
          : "Reposicao";
      const isSelection = payload?.settings?.planner_mode === "selection";
      const isManual = payload?.settings?.planner_mode === "manual";
      const capInfo = isSelection
        ? ` - P/M ${number(currentPlannerItems().filter((row) => row.size_group === "small_medium").reduce((sum, row) => sum + Number(row.suggested_restock || 0), 0))} un - G/XG ${number(currentPlannerItems().filter((row) => row.size_group === "large_xlarge").reduce((sum, row) => sum + Number(row.suggested_restock || 0), 0))} un`
        : isManual
          ? ` - formula manual com ${number(payload?.range?.days || 40)}d`
        : Number(payload?.settings?.storage_capacity || 0) > 0
          ? ` - limite ${number(payload.settings.storage_capacity)} un`
          : "";
      meta.textContent = payload?.range
        ? `${payload.range.from} ate ${payload.range.to} - modo ${modeLabel} - cobertura ${payload.settings.coverage_days}d - seguranca ${number(Number(payload.settings.safety_factor || 0) * 100)}%${capInfo}`
        : "Ajuste os filtros e calcule a sugestao.";
    }
    const body = $("fullPlannerBody");
    if (body) body.innerHTML = plannerRows(payload?.items || [], "Nenhuma reposicao sugerida para os filtros.", {
      editable: true,
      manual: payload?.settings?.planner_mode === "manual",
    });
    const saveBtn = $("btnSavePlan");
    if (saveBtn) saveBtn.disabled = !payload?.items?.length;
    const recalcBtn = $("btnRecalculateSuggestion");
    if (recalcBtn) recalcBtn.disabled = !payload?.items?.length;
  }

  function refreshPlannerDraft() {
    if (!state.planner) return;
    state.planner.items = currentPlannerItems().map((row) => ({
      ...row,
      suggested_restock: Math.max(0, Number(row.suggested_restock || 0)),
      suggested_value_cents: Math.max(0, Number(row.suggested_restock || 0)) * Number(row.price_cents || 0),
      volume_m3_total: Number((Math.max(0, Number(row.suggested_restock || 0)) * Number(row.volume_m3_unit || 0)).toFixed(5)),
      coverage_after_send_days: coverageAfterSend(row),
    }));
    state.planner.totals = computePlannerTotals(state.planner);
    renderPlannerTotals(state.planner);
    const body = $("fullPlannerBody");
    if (body) body.innerHTML = plannerRows(state.planner.items, "Nenhuma reposicao sugerida para os filtros.", {
      editable: true,
      manual: state.planner?.settings?.planner_mode === "manual",
    });
    const saveBtn = $("btnSavePlan");
    if (saveBtn) saveBtn.disabled = !state.planner.items.length;
    const recalcBtn = $("btnRecalculateSuggestion");
    if (recalcBtn) recalcBtn.disabled = !state.planner.items.length;
  }

  function removePlannerItem(index) {
    const items = currentPlannerItems();
    if (index < 0 || index >= items.length) return;
    items.splice(index, 1);
    refreshPlannerDraft();
  }

  function updatePlannerUnits(index, value) {
    if (state.planner?.settings?.planner_mode !== "manual") return;
    const items = currentPlannerItems();
    if (index < 0 || index >= items.length) return;
    items[index].suggested_restock = Math.max(0, Number.parseInt(String(value || "0"), 10) || 0);
    items[index].suggested_value_cents = items[index].suggested_restock * Number(items[index].price_cents || 0);
    items[index].volume_m3_total = Number((items[index].suggested_restock * Number(items[index].volume_m3_unit || 0)).toFixed(5));
    items[index].coverage_after_send_days = coverageAfterSend(items[index]);
    refreshPlannerDraft();
  }

  function readPlannerInput() {
    return {
      period: $("plannerPeriod")?.value || "30d",
      date_from: $("plannerDateFrom")?.value || null,
      date_to: $("plannerDateTo")?.value || null,
      coverage_days: Number($("plannerCoverage")?.value || 30),
      safety_factor: Number($("plannerSafety")?.value || 0),
      min_suggestion: Number($("plannerMinSuggestion")?.value || 0),
      storage_capacity: Number($("plannerStorageCapacity")?.value || 0),
      selection_group: state.selectionGroup,
      max_items: Number($("plannerMaxItems")?.value || 25),
      planner_mode: state.plannerMode,
      manual_mlbs: manualMlbsForRequest(),
      freight_cents: parseMoneyToCents($("plannerFreightValue")?.value || ""),
      include_idle: $("plannerIncludeIdle")?.checked !== false,
    };
  }

  function setPlannerMode(mode) {
    state.plannerMode = mode === "selection" || mode === "manual" ? mode : "replenishment";
    qsa("[data-planner-mode]").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.plannerMode === state.plannerMode));
    const pools = $("plannerSelectionPools");
    if (pools) pools.classList.toggle("is-hidden", state.plannerMode !== "selection");
    const manual = $("plannerManualPanel");
    if (manual) manual.classList.toggle("is-hidden", state.plannerMode !== "manual");
    const globalCapacity = $("plannerStorageCapacity")?.closest(".full-field");
    if (globalCapacity) globalCapacity.style.display = state.plannerMode === "selection" || state.plannerMode === "manual" ? "none" : "";
    const periodField = $("plannerPeriod")?.closest(".full-field");
    if (periodField) periodField.style.display = state.plannerMode === "manual" ? "none" : "";
    if (state.plannerMode === "selection" || state.plannerMode === "manual") {
      const advanced = document.querySelector(".full-planner-advanced");
      if (advanced) advanced.open = true;
    }
    updateCustomDates();
  }

  function setSelectionGroup(group) {
    state.selectionGroup = group === "small_medium" || group === "large_xlarge" ? group : "all";
    qsa("[data-selection-group]").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.selectionGroup === state.selectionGroup));
    qsa("[data-pool-card]").forEach((card) => card.classList.toggle("is-active", state.selectionGroup !== "all" && card.dataset.poolCard === state.selectionGroup));
  }

  function closeHoverLabels(except = null) {
    qsa(".full-hover.is-open").forEach((el) => {
      if (el !== except) el.classList.remove("is-open");
    });
  }

  function bindHoverLabels() {
    document.addEventListener("pointerover", (event) => {
      const hover = event.target.closest(".full-hover");
      if (!hover) return closeHoverLabels();
      closeHoverLabels(hover);
      hover.classList.add("is-open");
    });

    document.addEventListener("pointerout", (event) => {
      const hover = event.target.closest(".full-hover");
      if (!hover) return;
      if (hover.contains(event.relatedTarget)) return;
      hover.classList.remove("is-open");
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".full-hover")) closeHoverLabels();
    });
  }

  function updateCustomDates() {
    const isCustom = state.plannerMode !== "manual" && $("plannerPeriod")?.value === "custom";
    qsa(".full-custom-date").forEach((el) => el.classList.toggle("is-hidden", !isCustom));
    if (isCustom) {
      const advanced = document.querySelector(".full-planner-advanced");
      if (advanced) advanced.open = true;
    }
  }

  async function loadProducts() {
    const seq = ++state.requestSeq;
    const qs = new URLSearchParams();
    qs.set("q", $("fullSearch")?.value || "");
    qs.set("sort", $("fullSort")?.value || "suggested");
    const payload = await apiJson(`/api/full/products?${qs.toString()}`);
    if (seq !== state.requestSeq) return;
    renderProducts(payload);
  }

  async function syncFull() {
    const btn = $("btnSyncFull");
    if (btn) { btn.disabled = true; btn.textContent = "Atualizando..."; }
    const syncLabel = $("fullSyncLabel");
    if (syncLabel) syncLabel.textContent = "Consultando Mercado Livre...";
    try {
      const payload = await apiJson("/api/full/sync", { method: "POST", body: JSON.stringify({}) });
      renderProducts({ ...payload, last_synced_at: payload.synced_at, total_cached: payload.found_full });
    } catch (error) {
      if (syncLabel) syncLabel.textContent = error.message;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Atualizar Full"; }
    }
  }

  async function calculatePlanner() {
    const btn = document.querySelector("#fullPlannerForm .full-btn--primary");
    if (btn) { btn.disabled = true; btn.textContent = "Calculando..."; }
    try {
      const preserveManualDraft = state.plannerMode === "manual" && currentPlannerItems().length > 0;
      const previousItems = preserveManualDraft ? currentPlannerItems().map((row) => ({ ...row })) : [];
      const previousByMlb = new Map(previousItems.map((row) => [String(row.mlb || "").trim().toUpperCase(), row]));
      const payload = await apiJson("/api/full/planner", { method: "POST", body: JSON.stringify(readPlannerInput()) });
      if (preserveManualDraft) {
        const incomingItems = Array.isArray(payload.items) ? payload.items : [];
        const newItems = incomingItems.filter((row) => !previousByMlb.has(String(row.mlb || "").trim().toUpperCase()));
        payload.items = [...previousItems, ...newItems].slice(0, Number($("plannerMaxItems")?.value || 25));
        payload.totals = null;
      }
      renderPlanner(payload);
      if (state.plannerMode === "manual" && $("plannerManualMlbs")) $("plannerManualMlbs").value = "";
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Calcular carga"; }
    }
  }

  async function recalculateSuggestions() {
    if (!state.planner?.items?.length) return;
    const btn = $("btnRecalculateSuggestion");
    if (btn) { btn.disabled = true; btn.textContent = "Recalculando..."; }
    try {
      const previousItems = currentPlannerItems().map((row) => ({ ...row }));
      const currentMlbs = previousItems.map((row) => String(row.mlb || "").trim().toUpperCase()).filter(Boolean);
      const input = { ...readPlannerInput(), planner_mode: "manual", manual_mlbs: currentMlbs };
      const payload = await apiJson("/api/full/planner", { method: "POST", body: JSON.stringify(input) });
      const freshByMlb = new Map((payload.items || []).map((row) => [String(row.mlb || "").trim().toUpperCase(), row]));
      state.planner = {
        ...state.planner,
        range: payload.range || state.planner.range,
        settings: { ...(state.planner.settings || {}), ...(payload.settings || {}), planner_mode: "manual" },
        items: previousItems.map((old) => {
          const key = String(old.mlb || "").trim().toUpperCase();
          const fresh = freshByMlb.get(key);
          if (!fresh) return old;
          const send = Number(old.suggested_restock || 0);
          return {
            ...fresh,
            suggested_restock: send,
            suggested_value_cents: send * Number(fresh.price_cents || old.price_cents || 0),
            volume_m3_total: Number((send * Number(fresh.volume_m3_unit || old.volume_m3_unit || 0)).toFixed(5)),
            system_suggested_restock: fresh.system_suggested_restock ?? fresh.suggested_restock ?? old.system_suggested_restock ?? send,
          };
        }),
      };
      refreshPlannerDraft();
      if ($("fullPlannerMeta")) $("fullPlannerMeta").textContent = "Sugerido recalculado. As quantidades em ENVIAR foram preservadas.";
    } finally {
      if (btn) { btn.disabled = !state.planner?.items?.length; btn.textContent = "Recalcular sugerido"; }
    }
  }

  function openSaveModal(plan = null) {
    const activePlan = plan || state.editingPlan || null;
    state.savingPlanId = activePlan?.id || null;
    if ($("fullPlanModalTitle")) $("fullPlanModalTitle").textContent = activePlan ? "Editar planejamento" : "Salvar planejamento";
    if ($("fullPlanName")) $("fullPlanName").value = activePlan?.name || `Planejamento Full ${new Date().toLocaleDateString("pt-BR")}`;
    if ($("fullPlanObservation")) $("fullPlanObservation").value = activePlan?.observation || "";
    if ($("fullPlanModal")) $("fullPlanModal").hidden = false;
  }

  function closeSaveModal() {
    if ($("fullPlanModal")) $("fullPlanModal").hidden = true;
  }

  async function confirmSavePlan() {
    const shouldPersistItems = !state.savingPlanId || (state.editingPlan?.id && String(state.editingPlan.id) === String(state.savingPlanId));
    const input = {
      ...readPlannerInput(),
      name: $("fullPlanName")?.value || "",
      observation: $("fullPlanObservation")?.value || "",
    };
    if (shouldPersistItems) input.override_items = currentPlannerItems();
    else delete input.freight_cents;
    const btn = $("btnConfirmSavePlan");
    if (btn) { btn.disabled = true; btn.textContent = "Salvando..."; }
    try {
      if (state.savingPlanId) await apiJson(`/api/full/plans/${state.savingPlanId}`, { method: "PUT", body: JSON.stringify(input) });
      else await apiJson("/api/full/plans", { method: "POST", body: JSON.stringify(input) });
      closeSaveModal();
      state.savingPlanId = null;
      state.editingPlan = null;
      await loadPlans();
      switchTab("plans");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Salvar"; }
    }
  }

  function renderPlans() {
    const list = $("fullPlansList");
    if (!list) return;
    if (!state.plans.length) return void (list.innerHTML = `<div class="full-empty">Nenhum planejamento salvo ainda.</div>`);
    list.innerHTML = state.plans.map((plan) => `
      <article class="full-plan-card" data-plan-id="${plan.id}">
        <div>
          <strong>${escapeHtml(plan.name)}</strong>
          <small>${dateOnly(plan.date_from)} a ${dateOnly(plan.date_to)}  -  ${number(plan.item_count)} itens</small>
          <div class="full-plan-card__metrics">
            <span>${number(plan.total_suggested)} un.</span>
            <span>${money(plan.total_value_cents)}</span>
            <span>Frete ${number(plan.freight_pct, 2)}%</span>
            <span>${number(plan.total_volume_m3, 3)} m3</span>
            <span>P/M ${number(plan.small_medium_units || 0)}</span>
            <span>G/XG ${number(plan.large_xlarge_units || 0)}</span>
          </div>
          ${plan.observation ? `<small>${escapeHtml(plan.observation)}</small>` : ""}
        </div>
        <div class="full-plan-card__actions">
          <button class="full-icon-btn" type="button" data-plan-export="${plan.id}" title="Exportar PDF" aria-label="Exportar PDF">${icons.export}</button>
          <button class="full-icon-btn" type="button" data-plan-open="${plan.id}" title="Abrir planejamento" aria-label="Abrir planejamento">${icons.open}</button>
          <button class="full-icon-btn" type="button" data-plan-edit="${plan.id}" title="Editar nome" aria-label="Editar nome">${icons.edit}</button>
          <button class="full-icon-btn full-icon-btn--danger" type="button" data-plan-delete="${plan.id}" title="Remover do banco" aria-label="Remover do banco">${icons.trash}</button>
        </div>
      </article>
    `).join("");
  }

  async function loadPlans() {
    const payload = await apiJson("/api/full/plans");
    state.plans = Array.isArray(payload.plans) ? payload.plans : [];
    renderPlans();
  }

  async function openPlan(id) {
    const payload = await apiJson(`/api/full/plans/${id}`);
    if ($("fullPlanDetailMeta")) $("fullPlanDetailMeta").textContent = `${payload.plan.name}  -  ${dateOnly(payload.plan.date_from)} a ${dateOnly(payload.plan.date_to)}`;
    if ($("fullPlanDetailBody")) $("fullPlanDetailBody").innerHTML = plannerRows(payload.items || [], "Planejamento sem itens salvos.", { editable: false });
  }

  async function editPlan(id) {
    const payload = await apiJson(`/api/full/plans/${id}`);
    state.savingPlanId = payload.plan?.id || id;
    state.editingPlan = payload.plan || null;
    setPlannerMode("manual");
    switchTab("planner");
    renderPlanner({
      ok: true,
      plan: payload.plan,
      range: {
        from: payload.plan?.date_from,
        to: payload.plan?.date_to,
        days: payload.plan?.period_days || 30,
        label: payload.plan?.name || "Planejamento salvo",
      },
      settings: {
        planner_mode: "manual",
        coverage_days: payload.plan?.coverage_days || 30,
        safety_factor: payload.plan?.safety_factor || 0,
        max_items: Math.max(25, Number(payload.items?.length || 0)),
      },
      items: Array.isArray(payload.items) ? payload.items : [],
      totals: null,
    });
    if ($("plannerFreightValue")) $("plannerFreightValue").value = payload.plan?.freight_cents ? number(Number(payload.plan.freight_cents) / 100, 2) : "";
    if ($("plannerMaxItems")) $("plannerMaxItems").value = Math.max(25, Number(payload.items?.length || 0));
    if ($("fullPlannerMeta")) $("fullPlannerMeta").textContent = `Editando ${payload.plan?.name || "planejamento salvo"} - adicione, remova ou ajuste itens e clique em Salvar planejamento.`;
  }

  function exportPlanPdf(plan, items = [], targetWindow = null, fieldKeys = selectedPdfFields()) {
    const totals = items.reduce((acc, row) => {
      acc.units += Number(row.suggested_restock || 0);
      acc.value += Number(row.suggested_value_cents || 0);
      acc.volume += Number(row.volume_m3_total || 0);
      return acc;
    }, { units: 0, value: 0, volume: 0 });
    const freightCents = Number(plan?.freight_cents || 0);
    const freightPct = totals.value > 0 ? (freightCents / totals.value) * 100 : Number(plan?.freight_pct || 0);
    const freightLabel = freightCents > 0
      ? `${number(freightPct, 2)}% - ${freightPct <= 5 ? "viavel" : "nao viavel"}`
      : "sem frete informado";
    const selected = new Set(Array.isArray(fieldKeys) && fieldKeys.length ? fieldKeys : selectedPdfFields());
    const exportControls = PDF_EXPORT_FIELDS.map((field) => `
      <label class="field-toggle">
        <input type="checkbox" data-pdf-field-toggle="${field.key}" ${selected.has(field.key) ? "checked" : ""}>
        <span>${escapeHtml(field.label)}</span>
      </label>
    `).join("");
    const headers = PDF_EXPORT_FIELDS.map((field) => `<th data-pdf-field="${field.key}"${selected.has(field.key) ? "" : " hidden"}>${escapeHtml(field.label)}</th>`).join("");
    const rows = items.map((row) => `
      <tr>
        ${PDF_EXPORT_FIELDS.map((field) => `<td data-pdf-field="${field.key}"${selected.has(field.key) ? "" : " hidden"}>${field.render(row)}</td>`).join("")}
      </tr>
    `).join("");
    const win = targetWindow || window.open("", "_blank", "noopener,noreferrer");
    if (!win) return showError(new Error("Pop-up bloqueado para exportar o PDF."));
    win.document.open();
    win.document.write(`<!doctype html>
      <html><head><title>${escapeHtml(plan?.name || "Planejamento Full")}</title>
      <style>
        body{font-family:Arial,sans-serif;color:#111827;margin:24px}
        h1{font-size:20px;margin:0 0 4px}
        .meta{font-size:12px;color:#475569;margin-bottom:16px}
        table{width:100%;border-collapse:collapse;font-size:11px}
        th,td{border:1px solid #d1d5db;padding:6px;text-align:left;vertical-align:middle}
        th{background:#f3f4f6;text-transform:uppercase;font-size:10px}
        img{width:42px;height:42px;object-fit:cover;border-radius:6px}
        .totals{margin:12px 0;font-weight:700}
        .export-tools{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin:12px 0 16px;padding:10px;border:1px solid #d1d5db;border-radius:8px;background:#f8fafc}
        .export-tools strong{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#475569;margin-top:6px}
        .field-toggle{display:inline-flex;align-items:center;gap:6px;min-height:30px;border:1px solid #dbe4ef;border-radius:999px;background:#fff;padding:0 9px;font-size:12px;font-weight:700;color:#334155}
        .field-toggle input{width:13px;height:13px;margin:0}
        [hidden]{display:none!important}
        @media print{button,.export-tools{display:none} body{margin:12mm}}
      </style></head><body>
      <button onclick="window.print()">Imprimir / salvar PDF</button>
      <h1>${escapeHtml(plan?.name || "Planejamento Full")}</h1>
      <div class="meta">${dateOnly(plan?.date_from)} a ${dateOnly(plan?.date_to)} - ${number(items.length)} itens</div>
      <div class="totals">Total: ${number(totals.units)} unidades - ${money(totals.value)} - ${number(totals.volume, 3)} m3 - Frete / venda: ${freightLabel}</div>
      <div class="export-tools"><strong>Campos do PDF</strong>${exportControls}</div>
      <table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>
      <script>
        (() => {
          const storageKey = ${JSON.stringify(PDF_EXPORT_STORAGE_KEY)};
          const fields = ${JSON.stringify(PDF_EXPORT_FIELDS.map((field) => field.key))};
          const apply = () => {
            const toggles = Array.from(document.querySelectorAll("[data-pdf-field-toggle]"));
            let selected = toggles.filter((input) => input.checked).map((input) => input.dataset.pdfFieldToggle);
            if (!selected.length) {
              toggles.forEach((input) => { input.checked = true; });
              selected = fields.slice();
            }
            const active = new Set(selected);
            document.querySelectorAll("[data-pdf-field]").forEach((cell) => {
              cell.hidden = !active.has(cell.dataset.pdfField);
            });
            try { localStorage.setItem(storageKey, JSON.stringify(selected)); } catch {}
          };
          document.querySelectorAll("[data-pdf-field-toggle]").forEach((input) => input.addEventListener("change", apply));
          apply();
        })();
      </script>
      </body></html>`);
    win.document.close();
    win.focus();
  }

  async function exportPlan(id, targetWindow = null, fieldKeys = selectedPdfFields()) {
    try {
      if (targetWindow) {
        targetWindow.document.write("<!doctype html><title>Carregando planejamento...</title><p>Carregando planejamento...</p>");
        targetWindow.document.close();
      }
      const payload = await apiJson(`/api/full/plans/${id}`);
      exportPlanPdf(payload.plan, payload.items || [], targetWindow, fieldKeys);
    } catch (error) {
      if (targetWindow) {
        targetWindow.document.open();
        targetWindow.document.write(`<!doctype html><title>Erro</title><p>${escapeHtml(error?.message || String(error))}</p>`);
        targetWindow.document.close();
      }
      throw error;
    }
  }

  async function deletePlan(id) {
    if (!window.confirm("Remover este planejamento salvo?")) return;
    await apiJson(`/api/full/plans/${id}`, { method: "DELETE" });
    await loadPlans();
    if ($("fullPlanDetailBody")) $("fullPlanDetailBody").innerHTML = `<tr><td colspan="10" class="full-empty">Nenhum planejamento aberto.</td></tr>`;
  }

  function switchTab(tab) {
    state.activeTab = tab;
    qsa("[data-full-tab]").forEach((btn) => {
      const active = btn.dataset.fullTab === tab;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    qsa("[data-full-panel]").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.fullPanel === tab));
    if (tab === "plans") loadPlans().catch(showError);
  }

  function showError(error) {
    const message = error?.message || String(error);
    if (window.ML?.toast) window.ML.toast(message, "error");
    else window.alert(message);
  }

  function bind() {
    qsa("[data-full-tab]").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.fullTab)));
    $("btnSyncFull")?.addEventListener("click", () => syncFull().catch(showError));
    $("fullProductsFilters")?.addEventListener("submit", (event) => { event.preventDefault(); loadProducts().catch(showError); });
    $("plannerPeriod")?.addEventListener("change", updateCustomDates);
    qsa("[data-planner-mode]").forEach((btn) => btn.addEventListener("click", () => setPlannerMode(btn.dataset.plannerMode)));
    qsa("[data-selection-group]").forEach((btn) => btn.addEventListener("click", () => setSelectionGroup(btn.dataset.selectionGroup)));
    $("fullPlannerForm")?.addEventListener("submit", (event) => { event.preventDefault(); calculatePlanner().catch(showError); });
    $("plannerFreightValue")?.addEventListener("input", () => renderPlannerTotals(state.planner));
    $("btnRecalculateSuggestion")?.addEventListener("click", () => recalculateSuggestions().catch(showError));
    $("fullPlannerBody")?.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-planner-remove]");
      if (remove) removePlannerItem(Number(remove.dataset.plannerRemove));
    });
    $("fullPlannerBody")?.addEventListener("change", (event) => {
      const input = event.target.closest("[data-planner-units]");
      if (input) updatePlannerUnits(Number(input.dataset.plannerUnits), input.value);
    });
    $("btnSavePlan")?.addEventListener("click", () => openSaveModal());
    $("btnConfirmSavePlan")?.addEventListener("click", () => confirmSavePlan().catch(showError));
    qsa("[data-full-modal-close]").forEach((el) => el.addEventListener("click", closeSaveModal));
    $("btnReloadPlans")?.addEventListener("click", () => loadPlans().catch(showError));
    $("fullPlansList")?.addEventListener("click", (event) => {
      const open = event.target.closest("[data-plan-open]");
      const edit = event.target.closest("[data-plan-edit]");
      const exp = event.target.closest("[data-plan-export]");
      const del = event.target.closest("[data-plan-delete]");
      if (exp) {
        const win = window.open("", "_blank");
        if (!win) return showError(new Error("Pop-up bloqueado para exportar o PDF."));
        return void exportPlan(exp.dataset.planExport, win, selectedPdfFields()).catch(showError);
      }
      if (open) openPlan(open.dataset.planOpen).catch(showError);
      if (edit) {
        const plan = state.plans.find((row) => String(row.id) === String(edit.dataset.planEdit));
        if (plan) openSaveModal(plan);
      }
      if (del) deletePlan(del.dataset.planDelete).catch(showError);
      if (!open && !edit && !exp && !del) {
        const card = event.target.closest("[data-plan-id]");
        if (card) editPlan(card.dataset.planId).catch(showError);
      }
    });
  }

  function initDates() {
    const today = new Date();
    const from = new Date(today.getTime());
    from.setDate(from.getDate() - 29);
    if ($("plannerDateFrom")) $("plannerDateFrom").value = from.toISOString().slice(0, 10);
    if ($("plannerDateTo")) $("plannerDateTo").value = today.toISOString().slice(0, 10);
    updateCustomDates();
  }

  document.addEventListener("DOMContentLoaded", () => {
    loadPdfExportFields();
    bind();
    bindHoverLabels();
    initDates();
    setPlannerMode("replenishment");
    setSelectionGroup("all");
    loadProducts().catch(showError);
  });
})();
