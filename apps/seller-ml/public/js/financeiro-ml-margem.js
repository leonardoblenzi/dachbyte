(() => {
  "use strict";

  const moneyFmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const numFmt = new Intl.NumberFormat("pt-BR");
  const pctFmt = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const state = {
    activeTab: "summary",
    periodRows: [],
    equilibriumRows: [],
    periodPage: 1,
    equilibriumPage: 1,
    pageSize: 25,
    meta: {},
    operationalSummary: null,
    marketingSummary: null,
    marketingRequestId: 0,
  };

  const els = {
    status: document.getElementById("fml-margin-status"),
    form: document.getElementById("fml-margin-filters"),
    body: document.getElementById("fml-margin-body"),
    subtitle: document.getElementById("fml-margin-subtitle"),
    note: document.getElementById("fml-margin-note"),
    insights: document.getElementById("fml-insights"),
    page: document.getElementById("fml-margin-page"),
    prev: document.getElementById("fml-margin-prev"),
    next: document.getElementById("fml-margin-next"),
    refresh: document.getElementById("fml-refresh-margin"),
    refreshEquilibrium: document.getElementById("fml-refresh-equilibrium"),
    exportSummary: document.getElementById("fml-export-summary"),
    exportPeriod: document.getElementById("fml-export-period"),
    exportEquilibrium: document.getElementById("fml-export-equilibrium"),
    tabSummary: document.getElementById("fml-tab-summary"),
    tabPeriod: document.getElementById("fml-tab-period"),
    tabEquilibrium: document.getElementById("fml-tab-equilibrium"),
    panelSummary: document.getElementById("fml-summary-panel"),
    panelPeriod: document.getElementById("fml-period-panel"),
    panelEquilibrium: document.getElementById("fml-equilibrium-panel"),
    equilibriumBody: document.getElementById("fml-equilibrium-body"),
    equilibriumSubtitle: document.getElementById("fml-equilibrium-subtitle"),
    equilibriumPage: document.getElementById("fml-equilibrium-page"),
    equilibriumPrev: document.getElementById("fml-equilibrium-prev"),
    equilibriumNext: document.getElementById("fml-equilibrium-next"),
    summaryGross: document.getElementById("fml-summary-gross"),
    summaryCancelled: document.getElementById("fml-summary-cancelled"),
    summaryReturned: document.getElementById("fml-summary-returned"),
    summaryGmv: document.getElementById("fml-summary-gmv"),
    costs: document.getElementById("fml-margin-costs"),
    productCost: document.getElementById("fml-margin-product-cost"),
    commissions: document.getElementById("fml-margin-commissions"),
    taxBase: document.getElementById("fml-margin-tax-base"),
    taxes: document.getElementById("fml-margin-taxes"),
    profit: document.getElementById("fml-margin-profit"),
    pct: document.getElementById("fml-margin-pct"),
    buyerShipping: document.getElementById("fml-margin-buyer-shipping"),
    collectionFee: document.getElementById("fml-margin-collection-fee"),
    coupons: document.getElementById("fml-margin-coupons"),
    rebate: document.getElementById("fml-margin-rebate"),
    marketingStatus: document.getElementById("fml-marketing-status"),
    marketingNote: document.getElementById("fml-marketing-note"),
    marketingProductAds: document.getElementById("fml-marketing-product-ads"),
    marketingProductAdsState: document.getElementById("fml-marketing-product-ads-state"),
    marketingProductAdsNote: document.getElementById("fml-marketing-product-ads-note"),
    marketingDsp: document.getElementById("fml-marketing-dsp"),
    marketingDspState: document.getElementById("fml-marketing-dsp-state"),
    marketingDspNote: document.getElementById("fml-marketing-dsp-note"),
    marketingDisplay: document.getElementById("fml-marketing-display"),
    marketingDisplayState: document.getElementById("fml-marketing-display-state"),
    marketingDisplayNote: document.getElementById("fml-marketing-display-note"),
    marketingBrandAds: document.getElementById("fml-marketing-brand-ads"),
    marketingBrandAdsState: document.getElementById("fml-marketing-brand-ads-state"),
    marketingBrandAdsNote: document.getElementById("fml-marketing-brand-ads-note"),
    marketingAffiliates: document.getElementById("fml-marketing-affiliates"),
    marketingAffiliatesState: document.getElementById("fml-marketing-affiliates-state"),
    marketingAffiliatesNote: document.getElementById("fml-marketing-affiliates-note"),
    marketingTotal: document.getElementById("fml-marketing-total"),
    marketingTotalState: document.getElementById("fml-marketing-total-state"),
    marketingTotalNote: document.getElementById("fml-marketing-total-note"),
    finalOperational: document.getElementById("fml-final-operational"),
    finalMarketing: document.getElementById("fml-final-marketing"),
    finalResult: document.getElementById("fml-final-result"),
    finalMargin: document.getElementById("fml-final-margin"),
    finalTacos: document.getElementById("fml-final-tacos"),
    marketingFinalNote: document.getElementById("fml-marketing-final-note"),
  };

  function setStatus(text, tone = "info") {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.dataset.tone = tone;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[ch]);
  }

  function fmtMoney(value) {
    return moneyFmt.format(Number(value || 0));
  }

  function fmtMaybeMoney(value) {
    return value == null || value === "" ? "-" : fmtMoney(value);
  }

  function fmtNum(value) {
    return numFmt.format(Number(value || 0));
  }

  function initFloatingTooltips() {
    if (document.getElementById("fml-floating-tooltip")) return;

    const tooltip = document.createElement("div");
    tooltip.id = "fml-floating-tooltip";
    tooltip.className = "fml-floating-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.setAttribute("aria-hidden", "true");
    tooltip.hidden = true;
    document.body.appendChild(tooltip);
    document.body.classList.add("fml-floating-tooltips");

    let activeTrigger = null;

    const positionTooltip = () => {
      if (!activeTrigger || tooltip.hidden) return;
      const rect = activeTrigger.getBoundingClientRect();
      const tipRect = tooltip.getBoundingClientRect();
      const gap = 10;
      const viewportPadding = 12;

      let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
      left = Math.max(viewportPadding, Math.min(left, window.innerWidth - tipRect.width - viewportPadding));

      let top = rect.top - tipRect.height - gap;
      let placement = "top";
      if (top < viewportPadding) {
        top = rect.bottom + gap;
        placement = "bottom";
      }
      top = Math.max(viewportPadding, Math.min(top, window.innerHeight - tipRect.height - viewportPadding));

      tooltip.style.left = `${Math.round(left)}px`;
      tooltip.style.top = `${Math.round(top)}px`;
      tooltip.dataset.placement = placement;
    };

    const showTooltip = (trigger) => {
      const text = trigger?.dataset?.tooltip;
      if (!text) return;
      activeTrigger = trigger;
      tooltip.textContent = text;
      tooltip.hidden = false;
      tooltip.setAttribute("aria-hidden", "false");
      requestAnimationFrame(positionTooltip);
    };

    const hideTooltip = (trigger) => {
      if (trigger && activeTrigger && trigger !== activeTrigger) return;
      activeTrigger = null;
      tooltip.hidden = true;
      tooltip.setAttribute("aria-hidden", "true");
    };

    document.addEventListener("pointerover", (event) => {
      const trigger = event.target.closest?.(".fml-help[data-tooltip]");
      if (!trigger || trigger === activeTrigger) return;
      showTooltip(trigger);
    });

    document.addEventListener("pointerout", (event) => {
      const trigger = event.target.closest?.(".fml-help[data-tooltip]");
      if (!trigger || trigger !== activeTrigger) return;
      if (event.relatedTarget && trigger.contains(event.relatedTarget)) return;
      hideTooltip(trigger);
    });

    document.addEventListener("focusin", (event) => {
      const trigger = event.target.closest?.(".fml-help[data-tooltip]");
      if (trigger) showTooltip(trigger);
    });

    document.addEventListener("focusout", (event) => {
      const trigger = event.target.closest?.(".fml-help[data-tooltip]");
      if (trigger) hideTooltip(trigger);
    });

    window.addEventListener("resize", positionTooltip);
    window.addEventListener("scroll", positionTooltip, true);
  }


  function fmtPct(value) {
    return `${pctFmt.format(Number(value || 0))}%`;
  }

  function fmtDate(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleDateString("pt-BR");
  }

  function todayISO() {
    return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function addDaysISO(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function initDates() {
    const from = els.form?.elements.namedItem("date_from");
    const to = els.form?.elements.namedItem("date_to");
    if (from && !from.value) from.value = addDaysISO(-6);
    if (to && !to.value) to.value = todayISO();
  }

  function diffDaysInclusive(from, to) {
    const a = new Date(`${from}T12:00:00`);
    const b = new Date(`${to}T12:00:00`);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
    return Math.floor((b.getTime() - a.getTime()) / 86400000) + 1;
  }

  function validatePeriod() {
    const from = els.form?.elements.namedItem("date_from")?.value;
    const to = els.form?.elements.namedItem("date_to")?.value;
    if (!from || !to) return true;
    const start = from <= to ? from : to;
    const end = from <= to ? to : from;
    if (diffDaysInclusive(start, end) > 92) {
      setStatus("Periodo maximo para busca: 3 meses.", "error");
      return false;
    }
    return true;
  }

  function buildQuery() {
    const params = new URLSearchParams(new FormData(els.form));
    params.set("page", "1");
    params.set("pageSize", "50");
    return params;
  }

  function setActiveTab(tab) {
    state.activeTab = ["summary", "period", "equilibrium"].includes(tab) ? tab : "summary";
    const summary = state.activeTab === "summary";
    const period = state.activeTab === "period";
    const equilibrium = state.activeTab === "equilibrium";
    els.tabSummary?.classList.toggle("is-active", summary);
    els.tabPeriod?.classList.toggle("is-active", period);
    els.tabEquilibrium?.classList.toggle("is-active", equilibrium);
    els.panelSummary?.classList.toggle("fml-hidden", !summary);
    els.panelPeriod?.classList.toggle("fml-hidden", !period);
    els.panelEquilibrium?.classList.toggle("fml-hidden", !equilibrium);
  }

  function exportXlsx(view) {
    if (!validatePeriod()) return;
    const params = buildQuery();
    params.delete("page");
    params.delete("pageSize");
    params.set("view", view);
    const link = document.createElement("a");
    link.href = mlUrl(`/api/financeiro-ml/margin/export?${params.toString()}`);
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setStatus("Gerando arquivo XLSX com os filtros atuais...", "info");
  }

  function renderOrderStatus(value) {
    const status = String(value || "Preparando");
    const tone = status === "Concluído"
      ? "fml-chip--ok"
      : ["Cancelado", "Problema"].includes(status)
        ? "fml-chip--bad"
        : ["Devolução", "Devolvido"].includes(status)
          ? "fml-chip--missing"
          : "";
    return `<span class="fml-chip ${tone}">${escapeHtml(status)}</span>`;
  }

  function renderPeriodRows(rows = []) {
    if (!rows.length) {
      els.body.innerHTML = '<tr><td colspan="18" class="fml-empty">Nenhum pedido encontrado.</td></tr>';
      return;
    }
    els.body.innerHTML = rows.map((row) => {
      const profit = Number(row.profit || 0);
      const marginPct = Number(row.margin_pct || 0);
      const bufferUnit = Number(row.buffer_unit || 0);
      const rebate = Number(row.rebate || 0);
      const profitCls = profit > 0 ? "fml-money-positive" : profit < 0 ? "fml-money-negative" : "";
      const marginCls = marginPct > 0 ? "fml-money-positive" : marginPct < 0 ? "fml-money-negative" : "";
      const bufferCls = bufferUnit > 0 ? "fml-money-positive" : bufferUnit < 0 ? "fml-money-negative" : "";
      const rebateCls = rebate > 0 ? "fml-money-positive" : "";
      const missing = Number(row.missing_cost_items || 0) > 0
        ? `<small class="fml-muted fml-text-warn">${fmtNum(row.missing_cost_items)} item(ns) sem custo</small>`
        : "";
      const mlbs = Array.from(new Set(
        (Array.isArray(row.order_items) ? row.order_items : [])
          .map((item) => String(item?.mlb || "").trim())
          .filter(Boolean),
      ));
      const mlbVisible = mlbs.length
        ? `${escapeHtml(mlbs[0])}${mlbs.length > 1 ? ` +${mlbs.length - 1}` : ""}`
        : "";
      const mlbMeta = mlbVisible
        ? `<span class="fml-order-mlb" title="${escapeHtml(mlbs.join(" • "))}">${mlbVisible}</span>`
        : "";
      return `
        <tr>
          <td><div><div class="fml-order-id-line"><strong>${escapeHtml(row.order_id || "-")}</strong>${mlbMeta}</div><small class="fml-muted">${escapeHtml(row.items_label || "-")}</small>${missing}</div></td>
          <td>${fmtDate(row.date_created)}</td>
          <td><span class="fml-chip">${escapeHtml(row.shipping_mode || "-")}</span><small class="fml-muted">${escapeHtml(row.logistic_type || "")}</small></td>
          <td>${fmtMoney(row.gmv)}</td>
          <td>${fmtMoney(row.product_revenue)}</td>
          <td>${fmtMoney(row.product_cost)}</td>
          <td>${fmtMoney(row.commissions)}</td>
          <td>${fmtMoney(row.buyer_shipping_paid)}</td>
          <td><strong>${fmtMoney(row.tax_base)}</strong></td>
          <td>${fmtMoney(row.taxes)}<small class="fml-muted">${fmtPct(row.tax_rate_pct)}</small></td>
          <td>${fmtMoney(row.shipping_tariff)}</td>
          <td>${fmtMoney(row.coupon_discount)}</td>
          <td class="${rebateCls}">${fmtMoney(row.rebate)}</td>
          <td class="${profitCls}">${fmtMoney(row.profit)}</td>
          <td class="${marginCls}">${fmtPct(row.margin_pct)}</td>
          <td>${fmtMoney(row.equilibrium_unit)}</td>
          <td class="${bufferCls}">${fmtMoney(row.buffer_unit)}</td>
          <td>${renderOrderStatus(row.lifecycle_status)}</td>
        </tr>`;
    }).join("");
  }

  function renderPeriodPage() {
    const total = state.periodRows.length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    state.periodPage = Math.min(Math.max(1, state.periodPage), totalPages);
    const start = (state.periodPage - 1) * state.pageSize;
    renderPeriodRows(state.periodRows.slice(start, start + state.pageSize));
    if (els.page) els.page.textContent = `Pagina ${state.periodPage} de ${totalPages} - ${fmtNum(total)} pedido(s)`;
    if (els.prev) els.prev.disabled = state.periodPage <= 1;
    if (els.next) els.next.disabled = state.periodPage >= totalPages;
  }

  function equilibriumStatusChip(row) {
    const status = String(row.equilibrium_status || "sem_custo");
    if (status === "abaixo") return '<span class="fml-chip fml-chip--bad">Abaixo</span>';
    if (status === "proximo") return '<span class="fml-chip fml-chip--missing">Proximo</span>';
    if (status === "acima") return '<span class="fml-chip fml-chip--ok">Acima</span>';
    return '<span class="fml-chip fml-chip--missing">Sem custo</span>';
  }

  function equilibriumBuyerShippingCell(row = {}) {
    const source = String(row.buyer_shipping_estimate_source || "sem_historico");
    if (source === "frete_gratis") {
      return `${fmtMoney(0)}<small class="fml-muted">Frete gratis</small>`;
    }
    if (source === "historico_periodo") {
      return `<strong>${fmtMoney(row.estimated_buyer_shipping)}</strong><small class="fml-muted">Media historica/un.</small>`;
    }
    return '<span class="fml-chip fml-chip--missing">Sem historico</span><small class="fml-muted">Frete nao considerado</small>';
  }

  function renderEquilibriumRows(rows = []) {
    if (!rows.length) {
      els.equilibriumBody.innerHTML = '<tr><td colspan="17" class="fml-empty">Nenhum anuncio/variacao encontrado.</td></tr>';
      return;
    }
    els.equilibriumBody.innerHTML = rows.map((row) => {
      const bufferCls = row.equilibrium_buffer == null
        ? ""
        : Number(row.equilibrium_buffer) >= 0 ? "fml-money-positive" : "fml-money-negative";
      return `
        <tr>
          <td><div class="fml-product fml-product--compact"><div><strong>${escapeHtml(row.title || "-")}</strong><small>${escapeHtml(row.status || "-")} • ${escapeHtml(row.logistic_type || row.shipping_mode_raw || "-")}</small></div></div></td>
          <td>${row.reference_sku ? `<span class="fml-chip">${escapeHtml(row.reference_sku)}</span>` : '<span class="fml-chip fml-chip--missing">Sem SKU</span>'}</td>
          <td>${escapeHtml(row.item_id || "-")}</td>
          <td>${escapeHtml(row.variation_id || "-")}</td>
          <td>${fmtMoney(row.price)}</td>
          <td>${row.has_cost ? fmtMoney(row.product_cost) : '<span class="fml-chip fml-chip--missing">Sem custo</span>'}</td>
          <td><strong>${fmtMoney(row.commission)}</strong><small class="fml-muted">${fmtPct(row.commission_rate_pct)} + ${fmtMoney(row.commission_fixed)} fixo</small></td>
          <td>${equilibriumBuyerShippingCell(row)}</td>
          <td><strong>${fmtMoney(row.tax_base_estimated)}</strong><small class="fml-muted">${row.tax_estimate_complete ? "Base estimada" : "Frete nao considerado"}</small></td>
          <td><strong>${fmtMoney(row.taxes)}</strong><small class="fml-muted">${fmtPct(row.tax_rate_pct)}</small></td>
          <td>${fmtMoney(row.shipping_tariff)}</td>
          <td><strong>${fmtMaybeMoney(row.equilibrium_price)}</strong><small class="fml-muted">Estimado</small></td>
          <td>${fmtMaybeMoney(row.price_margin_10)}</td>
          <td>${fmtMaybeMoney(row.price_margin_15)}</td>
          <td>${fmtMaybeMoney(row.price_margin_20)}</td>
          <td class="${bufferCls}">${fmtMaybeMoney(row.equilibrium_buffer)}</td>
          <td>${equilibriumStatusChip(row)}</td>
        </tr>`;
    }).join("");
  }

  function renderEquilibriumPage() {
    const total = state.equilibriumRows.length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    state.equilibriumPage = Math.min(Math.max(1, state.equilibriumPage), totalPages);
    const start = (state.equilibriumPage - 1) * state.pageSize;
    renderEquilibriumRows(state.equilibriumRows.slice(start, start + state.pageSize));
    if (els.equilibriumPage) els.equilibriumPage.textContent = `Pagina ${state.equilibriumPage} de ${totalPages} - ${fmtNum(total)} registro(s)`;
    if (els.equilibriumPrev) els.equilibriumPrev.disabled = state.equilibriumPage <= 1;
    if (els.equilibriumNext) els.equilibriumNext.disabled = state.equilibriumPage >= totalPages;
  }

  function renderSummary(summary = {}) {
    state.operationalSummary = summary || {};
    const gross = Number(summary.gross_revenue || 0) || Number(summary.listed_revenue || 0);
    if (els.summaryGross) els.summaryGross.textContent = fmtMoney(gross);
    if (els.summaryCancelled) els.summaryCancelled.textContent = fmtMoney(summary.cancelled_revenue);
    if (els.summaryReturned) els.summaryReturned.textContent = fmtMoney(summary.returned_revenue);
    if (els.costs) els.costs.textContent = fmtMoney(summary.total_costs);
    if (els.productCost) els.productCost.textContent = fmtMoney(summary.product_cost);
    if (els.commissions) els.commissions.textContent = fmtMoney(summary.commissions);
    if (els.taxBase) els.taxBase.textContent = fmtMoney(summary.tax_base);
    if (els.taxes) els.taxes.textContent = fmtMoney(summary.taxes);
    if (els.profit) {
      els.profit.textContent = fmtMoney(summary.projected_profit);
      els.profit.className = Number(summary.projected_profit || 0) >= 0 ? "fml-money-positive" : "fml-money-negative";
    }
    if (els.pct) els.pct.textContent = fmtPct(summary.margin_pct);
    if (els.summaryGmv) els.summaryGmv.textContent = fmtMoney(summary.listed_revenue);
    if (els.buyerShipping) els.buyerShipping.textContent = fmtMoney(summary.buyer_shipping_paid);
    if (els.collectionFee) els.collectionFee.textContent = fmtMoney(summary.collection_shipping_fee);
    if (els.coupons) els.coupons.textContent = fmtMoney(summary.seller_coupon_discount);
    if (els.rebate) {
      els.rebate.textContent = fmtMoney(summary.meli_rebate);
      els.rebate.className = "fml-money-positive";
    }
    if (els.finalOperational) {
      const operationalProfit = Number(summary.projected_profit || 0);
      els.finalOperational.textContent = fmtMoney(operationalProfit);
      els.finalOperational.className = operationalProfit >= 0 ? "fml-money-positive" : "fml-money-negative";
    }
    if (state.marketingSummary) renderMarketingSummary(state.marketingSummary);
  }

  function marketingPeriodScopeCompatible() {
    const form = els.form;
    if (!form) return true;
    const value = (name) => String(form.elements.namedItem(name)?.value || "").trim();
    return !value("q")
      && ["", "all"].includes(value("status").toLowerCase())
      && ["", "all"].includes(value("margin_status").toLowerCase())
      && ["", "all"].includes(value("cost_status").toLowerCase())
      && ["", "all"].includes(value("equilibrium_state").toLowerCase())
      && !value("min_margin")
      && !value("max_margin");
  }

  function marketingStateLabel(row = {}) {
    const status = String(row?.status || "").toLowerCase();
    if (status === "ok") return "Disponivel";
    if (status === "not_available") return "Nao disponivel";
    if (status === "range_limit") return "Fora da janela";
    if (status === "unsupported") return "Indisponivel";
    if (status === "error") return "Falha";
    return "Indisponivel";
  }

  function marketingTone(row = {}) {
    const status = String(row?.status || "").toLowerCase();
    if (status === "ok") return "ok";
    if (status === "not_available" || status === "unsupported") return "muted";
    if (status === "range_limit") return "warn";
    return "error";
  }

  function setMarketingChannel(prefix, row = {}, fallbackNote = "") {
    const valueEl = els[`marketing${prefix}`];
    const stateEl = els[`marketing${prefix}State`];
    const noteEl = els[`marketing${prefix}Note`];
    if (valueEl) {
      valueEl.textContent = row?.available ? fmtMoney(row.investment) : marketingStateLabel(row);
      valueEl.classList.toggle("fml-marketing-unavailable", !row?.available);
    }
    if (stateEl) {
      stateEl.textContent = marketingStateLabel(row);
      stateEl.dataset.tone = marketingTone(row);
    }
    if (noteEl) noteEl.textContent = row?.reason || fallbackNote;
  }

  function resetMarketingUi() {
    state.marketingSummary = null;
    if (els.marketingStatus) {
      els.marketingStatus.textContent = "Calculando";
      els.marketingStatus.dataset.tone = "loading";
    }
    if (els.marketingNote) els.marketingNote.textContent = "Carregando Product Ads, DSP e Brand Ads em paralelo.";
    const pairs = [
      ["ProductAds", "Investimento consumido no periodo."],
      ["Dsp", "Investimento consumido no Mercado Ads DSP."],
      ["BrandAds", "Investimento consumido no periodo, quando disponivel para a conta."],
    ];
    for (const [prefix, note] of pairs) {
      const valueEl = els[`marketing${prefix}`];
      const stateEl = els[`marketing${prefix}State`];
      const noteEl = els[`marketing${prefix}Note`];
      if (valueEl) { valueEl.textContent = "--"; valueEl.classList.remove("fml-marketing-unavailable"); }
      if (stateEl) { stateEl.textContent = "Calculando"; stateEl.dataset.tone = "loading"; }
      if (noteEl) noteEl.textContent = note;
    }
    if (els.marketingDisplay) {
      els.marketingDisplay.textContent = "Indisponivel";
      els.marketingDisplay.classList.add("fml-marketing-unavailable");
    }
    if (els.marketingDisplayState) {
      els.marketingDisplayState.textContent = "Indisponivel";
      els.marketingDisplayState.dataset.tone = "muted";
    }
    if (els.marketingDisplayNote) {
      els.marketingDisplayNote.textContent = "Campanha de seguidores da pagina; investimento ainda sem fonte publica nesta integracao.";
    }
    if (els.marketingAffiliates) {
      els.marketingAffiliates.textContent = "Indisponivel";
      els.marketingAffiliates.classList.add("fml-marketing-unavailable");
    }
    if (els.marketingAffiliatesState) {
      els.marketingAffiliatesState.textContent = "Indisponivel";
      els.marketingAffiliatesState.dataset.tone = "muted";
    }
    if (els.marketingTotal) els.marketingTotal.textContent = "--";
    if (els.marketingTotalState) { els.marketingTotalState.textContent = "Calculando"; els.marketingTotalState.dataset.tone = "loading"; }
    if (els.marketingTotalNote) els.marketingTotalNote.textContent = "Soma dos canais que a integracao conseguiu consultar.";
    if (els.finalMarketing) els.finalMarketing.textContent = "--";
    if (els.finalResult) els.finalResult.textContent = "--";
    if (els.finalMargin) els.finalMargin.textContent = "--";
    if (els.finalTacos) els.finalTacos.textContent = "--";
    if (els.marketingFinalNote) els.marketingFinalNote.textContent = "Aguardando os dados de marketing.";
  }

  function renderMarketingSummary(marketing = {}) {
    state.marketingSummary = marketing;
    const channels = marketing.channels || {};
    setMarketingChannel("ProductAds", channels.product_ads, "Investimento consumido no periodo.");
    // Nomenclatura da UI: o product_id tecnico DISPLAY da API e mostrado como DSP.
    // O card Display e reservado para campanhas de seguidores da pagina e, por
    // enquanto, permanece indisponivel. Nao somar os dois como se fossem fontes distintas.
    setMarketingChannel("Dsp", channels.dsp, "Investimento consumido no Mercado Ads DSP.");
    setMarketingChannel("Display", channels.display, "Campanha de seguidores da pagina; investimento ainda sem fonte publica nesta integracao.");
    setMarketingChannel("BrandAds", channels.brand_ads, "Investimento consumido no periodo, quando disponivel para a conta.");
    setMarketingChannel("Affiliates", channels.affiliates, "A API publica do Mercado Livre ainda nao fornece a comissao de Afiliados para esta integracao.");

    const totalKnown = Number(marketing.total_marketing_known || 0);
    if (els.marketingTotal) els.marketingTotal.textContent = fmtMoney(totalKnown);
    if (els.marketingTotalState) {
      els.marketingTotalState.textContent = marketing.partial ? "Parcial" : "Completo";
      els.marketingTotalState.dataset.tone = marketing.partial ? "warn" : "ok";
    }
    if (els.marketingTotalNote) {
      els.marketingTotalNote.textContent = "Soma de Product Ads, DSP e Brand Ads quando disponiveis. Display (seguidores) e Afiliados nao entram enquanto estiverem indisponiveis.";
    }
    if (els.marketingStatus) {
      els.marketingStatus.textContent = marketing.partial ? "Dados parciais" : "Carregado";
      els.marketingStatus.dataset.tone = marketing.partial ? "warn" : "ok";
    }
    if (els.marketingNote) {
      els.marketingNote.textContent = marketing.note || "Investimento de marketing carregado para o periodo selecionado.";
    }

    const operational = state.operationalSummary || {};
    const operationalProfit = Number(operational.projected_profit || 0);
    const gmv = Number(operational.listed_revenue || 0);
    if (els.finalOperational) {
      els.finalOperational.textContent = fmtMoney(operationalProfit);
      els.finalOperational.className = operationalProfit >= 0 ? "fml-money-positive" : "fml-money-negative";
    }

    if (!marketingPeriodScopeCompatible()) {
      if (els.finalMarketing) els.finalMarketing.textContent = fmtMoney(totalKnown);
      if (els.finalResult) els.finalResult.textContent = "--";
      if (els.finalMargin) els.finalMargin.textContent = "--";
      if (els.finalTacos) els.finalTacos.textContent = gmv > 0 ? fmtPct((totalKnown / gmv) * 100) : "--";
      if (els.marketingFinalNote) {
        els.marketingFinalNote.textContent = "Marketing representa o total do periodo. Para calcular Resultado apos marketing e Margem final, remova filtros de produto, status, custo ou margem e mantenha apenas as datas.";
        els.marketingFinalNote.dataset.tone = "warn";
      }
      return;
    }

    const afterMarketing = operationalProfit - totalKnown;
    const finalMargin = gmv > 0 ? (afterMarketing / gmv) * 100 : 0;
    const tacos = gmv > 0 ? (totalKnown / gmv) * 100 : 0;
    if (els.finalMarketing) els.finalMarketing.textContent = fmtMoney(totalKnown);
    if (els.finalResult) {
      els.finalResult.textContent = fmtMoney(afterMarketing);
      els.finalResult.className = afterMarketing >= 0 ? "fml-money-positive" : "fml-money-negative";
    }
    if (els.finalMargin) {
      els.finalMargin.textContent = fmtPct(finalMargin);
      els.finalMargin.className = finalMargin >= 0 ? "fml-money-positive" : "fml-money-negative";
    }
    if (els.finalTacos) els.finalTacos.textContent = fmtPct(tacos);
    if (els.marketingFinalNote) {
      els.marketingFinalNote.textContent = marketing.partial
        ? "Resultado parcial: considera apenas os canais de marketing disponiveis na integracao. Display (seguidores) e Afiliados ainda nao estao incluidos."
        : "Resultado final calculado com todos os canais de marketing disponiveis para a conta.";
      els.marketingFinalNote.dataset.tone = marketing.partial ? "warn" : "ok";
    }
  }

  async function loadMarketingSummary({ force = false, requestId = null } = {}) {
    const from = els.form?.elements.namedItem("date_from")?.value;
    const to = els.form?.elements.namedItem("date_to")?.value;
    if (!from || !to) return;
    const currentRequest = requestId ?? ++state.marketingRequestId;
    resetMarketingUi();
    const params = new URLSearchParams({ date_from: from, date_to: to });
    if (force) params.set("force_refresh", "true");
    try {
      const response = await fetch(mlUrl(`/api/financeiro-ml/margin/marketing-summary?${params.toString()}`), {
        credentials: "include",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const data = await response.json().catch(() => null);
      if (currentRequest !== state.marketingRequestId) return;
      if (!response.ok || !data?.success) throw new Error(data?.error || "Falha ao carregar marketing.");
      renderMarketingSummary(data);
    } catch (error) {
      if (currentRequest !== state.marketingRequestId) return;
      if (els.marketingStatus) { els.marketingStatus.textContent = "Indisponivel"; els.marketingStatus.dataset.tone = "error"; }
      if (els.marketingNote) els.marketingNote.textContent = error.message || "Falha ao carregar marketing do periodo.";
      if (els.marketingFinalNote) {
        els.marketingFinalNote.textContent = "Margem operacional permanece valida; o resultado apos marketing nao pode ser calculado enquanto as fontes de publicidade estiverem indisponiveis.";
        els.marketingFinalNote.dataset.tone = "error";
      }
    }
  }

  function renderInsights(insights = []) {
    if (!els.insights) return;
    if (!insights.length) {
      els.insights.innerHTML = '<div class="fml-empty">Sem insights para o recorte atual.</div>';
      return;
    }
    els.insights.innerHTML = insights.map((item) => {
      const cls = item.type === "danger" ? "fml-insight--danger" : item.type === "warn" ? "fml-insight--warn" : item.type === "ok" ? "fml-insight--ok" : "";
      const title = String(item.title || "").toLowerCase();
      const value = title.includes("maior lucro") ? fmtMoney(item.value) : title.includes("gmv alto") ? fmtPct(item.value) : fmtNum(item.value);
      return `
        <article class="fml-insight ${cls}">
          <span>${escapeHtml(item.title)}</span>
          <div class="fml-metric-value"><strong>${escapeHtml(value)}</strong><span class="fml-help" tabindex="0" aria-label="Insight gerado a partir dos pedidos filtrados." data-tooltip="Insight gerado a partir dos pedidos filtrados."><i class="bi bi-info-circle"></i></span></div>
          <p>${escapeHtml(item.text)}</p>
        </article>`;
    }).join("");
  }

  async function loadMargin({ force = false } = {}) {
    if (!validatePeriod()) return;
    const params = buildQuery();
    if (force) params.set("force_refresh", "true");
    if (els.body) els.body.innerHTML = '<tr><td colspan="18" class="fml-empty">Carregando margens...</td></tr>';
    if (els.equilibriumBody) els.equilibriumBody.innerHTML = '<tr><td colspan="17" class="fml-empty">Carregando precificacao estimada...</td></tr>';
    setStatus("Calculando vendas e precificacao...", "info");
    const marketingRequestId = ++state.marketingRequestId;
    resetMarketingUi();
    window.MLLoadingOverlay?.show({
      context: "Financeiro ML",
      label: "Margem e precificacao",
      message: "Consultando pedidos, custos, tarifas e anuncios...",
      texts: [
        "Lendo pedidos do periodo...",
        "Aplicando custos por SKU e variacao...",
        "Conciliando cupons, rebates e descontos...",
        "Calculando preco de equilibrio...",
      ],
      initialProgress: 14,
      maxProgress: 92,
    });

    try {
      const response = await fetch(mlUrl(`/api/financeiro-ml/margin?${params.toString()}`), {
        credentials: "include",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.error || "Falha ao carregar margem.");

      state.meta = data.meta || {};
      state.periodRows = Array.isArray(data.period_rows) ? data.period_rows : [];
      state.equilibriumRows = Array.isArray(data.equilibrium_rows) ? data.equilibrium_rows : [];
      state.periodPage = 1;
      state.equilibriumPage = 1;
      renderSummary(data.summary || {});
      renderInsights(data.insights || []);
      loadMarketingSummary({ force, requestId: marketingRequestId });
      renderPeriodPage();
      renderEquilibriumPage();

      if (els.subtitle) els.subtitle.textContent = `${fmtNum(state.periodRows.length)} pedido(s) apos os filtros.`;
      if (els.equilibriumSubtitle) {
        const partialText = data.meta?.partial ? " (recorte parcial de anuncios)" : "";
        els.equilibriumSubtitle.textContent = `${fmtNum(state.equilibriumRows.length)} anuncio(s)/variacao(oes)${partialText}.`;
      }
      if (els.note) els.note.textContent = data.meta?.note || "Margem carregada.";

      const available = Number(data.meta?.orders_available || 0);
      const scanned = Number(data.meta?.orders_scanned || 0);
      if (data.meta?.order_partial) {
        setStatus(`Margem carregada parcialmente: ${fmtNum(scanned)} de ${fmtNum(available)} pedidos.`, "error");
      } else if (data.meta?.partial) {
        setStatus("Vendas carregadas; a precificacao usa um recorte de anuncios da conta.", "info");
      } else {
        setStatus("Margem e precificacao carregadas.", "ok");
      }
    } catch (error) {
      if (els.body) els.body.innerHTML = `<tr><td colspan="18" class="fml-empty">${escapeHtml(error.message)}</td></tr>`;
      if (els.equilibriumBody) els.equilibriumBody.innerHTML = `<tr><td colspan="17" class="fml-empty">${escapeHtml(error.message)}</td></tr>`;
      state.periodRows = [];
      state.equilibriumRows = [];
      renderInsights([]);
      setStatus(error.message || "Falha ao carregar.", "error");
    } finally {
      window.MLLoadingOverlay?.hide();
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    initFloatingTooltips();
    initDates();
    setActiveTab("summary");
    els.tabSummary?.addEventListener("click", () => setActiveTab("summary"));
    els.tabPeriod?.addEventListener("click", () => setActiveTab("period"));
    els.tabEquilibrium?.addEventListener("click", () => setActiveTab("equilibrium"));
    els.form?.addEventListener("submit", (event) => {
      event.preventDefault();
      state.periodPage = 1;
      state.equilibriumPage = 1;
      loadMargin();
    });
    els.prev?.addEventListener("click", () => {
      if (state.periodPage > 1) {
        state.periodPage -= 1;
        renderPeriodPage();
      }
    });
    els.next?.addEventListener("click", () => {
      const totalPages = Math.max(1, Math.ceil(state.periodRows.length / state.pageSize));
      if (state.periodPage < totalPages) {
        state.periodPage += 1;
        renderPeriodPage();
      }
    });
    els.equilibriumPrev?.addEventListener("click", () => {
      if (state.equilibriumPage > 1) {
        state.equilibriumPage -= 1;
        renderEquilibriumPage();
      }
    });
    els.equilibriumNext?.addEventListener("click", () => {
      const totalPages = Math.max(1, Math.ceil(state.equilibriumRows.length / state.pageSize));
      if (state.equilibriumPage < totalPages) {
        state.equilibriumPage += 1;
        renderEquilibriumPage();
      }
    });
    els.refresh?.addEventListener("click", () => loadMargin({ force: true }));
    els.refreshEquilibrium?.addEventListener("click", () => loadMargin({ force: true }));
    els.exportSummary?.addEventListener("click", () => exportXlsx("summary"));
    els.exportPeriod?.addEventListener("click", () => exportXlsx("period"));
    els.exportEquilibrium?.addEventListener("click", () => exportXlsx("equilibrium"));
    loadMargin();
  });
})();
