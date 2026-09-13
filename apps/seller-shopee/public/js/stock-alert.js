(function stockAlertModule() {
  "use strict";

  const state = {
    periodPreset: "30d",
    dateFrom: "",
    dateTo: "",
    riskOnly: false,
    searchQuery: "",
    selectedToMonitor: new Set(),
    lastItems: [],
  };

  let isBound = false;
  let riskChart = null;
  let trendChart = null;
  let arrivalDialogResolver = null;

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatInt(value) {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed.toLocaleString("pt-BR") : "0";
  }

  function formatDecimal(value, digits = 2) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return "-";
    return parsed.toLocaleString("pt-BR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function formatPct(value, digits = 2) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return "-";
    return `${parsed.toLocaleString("pt-BR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}%`;
  }

  function formatDateBr(value) {
    if (!value) return "-";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "-";
    return parsed.toLocaleDateString("pt-BR");
  }

  function riskLabel(level) {
    const map = {
      alto: "Alto",
      medio: "Medio",
      atencao: "Atencao",
      baixo: "Baixo",
      aguardando: "Aguardando chegada",
    };
    return map[String(level || "").toLowerCase()] || "-";
  }

  function trendLabel(status) {
    const map = {
      crescimento: "Crescimento",
      queda: "Queda",
      estabilidade: "Estabilidade",
    };
    return map[String(status || "").toLowerCase()] || "-";
  }

  function toneIcon(tone) {
    const normalized = String(tone || "").toLowerCase();
    if (normalized === "danger") return "🔴";
    if (normalized === "warning") return "🟠";
    if (normalized === "positive") return "🟢";
    return "🔵";
  }

  function ensureChartJs() {
    return Boolean(window.Chart);
  }

  async function apiRequest(path, options = {}) {
    const response = await fetch(path, {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        data?.error?.message || data?.message || data?.error || `HTTP ${response.status}`;
      throw new Error(String(message));
    }
    return data;
  }

  async function fetchOverview() {
    const params = new URLSearchParams();
    params.set("periodPreset", state.periodPreset);
    if (state.periodPreset === "custom") {
      if (state.dateFrom) params.set("dateFrom", state.dateFrom);
      if (state.dateTo) params.set("dateTo", state.dateTo);
    }
    if (state.riskOnly) params.set("riskOnly", "1");
    return apiRequest(`/shopee/shops/active/dashboard/stock-alert/overview?${params.toString()}`);
  }

  async function fetchSearchProducts() {
    const params = new URLSearchParams();
    params.set("q", state.searchQuery);
    params.set("limit", "50");
    return apiRequest(`/shopee/shops/active/dashboard/stock-alert/products?${params.toString()}`);
  }

  function renderSummary(data) {
    const summary = data?.summary || {};
    const meta = data?.meta || {};
    const root = $("stockAlertSummary");
    if (!root) return;

    root.innerHTML = `
      <article class="strategy-kpi-card">
        <div class="strategy-kpi-card__label">Periodo analisado</div>
        <div class="strategy-kpi-card__value strategy-kpi-card__value--sm">${escapeHtml(meta.periodLabel || "-")}</div>
      </article>
      <article class="strategy-kpi-card">
        <div class="strategy-kpi-card__label">Itens monitorados</div>
        <div class="strategy-kpi-card__value">${formatInt(meta.monitoredCount || 0)}</div>
      </article>
      <article class="strategy-kpi-card">
        <div class="strategy-kpi-card__label">Risco alto</div>
        <div class="strategy-kpi-card__value">${formatInt(summary.highRiskCount || 0)}</div>
      </article>
      <article class="strategy-kpi-card">
        <div class="strategy-kpi-card__label">Risco medio</div>
        <div class="strategy-kpi-card__value">${formatInt(summary.mediumRiskCount || 0)}</div>
      </article>
      <article class="strategy-kpi-card">
        <div class="strategy-kpi-card__label">Crescimento vs anterior</div>
        <div class="strategy-kpi-card__value">${formatPct(summary.salesGrowthPct || 0, 2)}</div>
      </article>
      <article class="strategy-kpi-card">
        <div class="strategy-kpi-card__label">Cobertura media (dias)</div>
        <div class="strategy-kpi-card__value">${formatDecimal(summary.averageCoverageDays || 0, 1)}</div>
      </article>
    `;
  }

  function renderInsights(data) {
    const root = $("stockAlertInsights");
    if (!root) return;
    const insights = Array.isArray(data?.insights) ? data.insights : [];
    const recommendations = Array.isArray(data?.recommendations) ? data.recommendations : [];
    const rows = [...insights, ...recommendations];
    if (!rows.length) {
      root.innerHTML = `<div class="muted">Sem insights no momento.</div>`;
      return;
    }

    root.innerHTML = rows
      .map(
        (insight) => `
          <article class="ads-insight-card">
            <div class="ads-insight-card__body">
              <strong>${toneIcon(insight?.tone)} ${escapeHtml(insight?.title || "Insight")}</strong>
              <span>${escapeHtml(insight?.message || "")}</span>
            </div>
          </article>
        `,
      )
      .join("");
  }

  function destroyCharts() {
    if (riskChart) {
      riskChart.destroy();
      riskChart = null;
    }
    if (trendChart) {
      trendChart.destroy();
      trendChart = null;
    }
  }

  function renderCharts(data) {
    if (!ensureChartJs()) return;

    const summary = data?.summary || {};
    const items = Array.isArray(data?.items) ? data.items : [];
    const riskCtx = $("stockAlertRiskChart")?.getContext?.("2d");
    const trendCtx = $("stockAlertTrendChart")?.getContext?.("2d");
    if (!riskCtx || !trendCtx) return;

    destroyCharts();

    riskChart = new window.Chart(riskCtx, {
      type: "doughnut",
      data: {
        labels: ["Risco alto", "Risco medio", "Atencao", "Baixo", "Aguardando"],
        datasets: [
          {
            data: [
              Number(summary.highRiskCount || 0),
              Number(summary.mediumRiskCount || 0),
              Number(items.filter((item) => item.riskLevel === "atencao").length),
              Number(items.filter((item) => item.riskLevel === "baixo").length),
              Number(summary.awaitingArrivalCount || 0),
            ],
            backgroundColor: ["#ef4444", "#f59e0b", "#f97316", "#22c55e", "#60a5fa"],
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: "bottom" },
        },
      },
    });

    const topByCoverage = [...items]
      .filter((item) => Number.isFinite(Number(item.daysCoverage)))
      .sort((a, b) => Number(a.daysCoverage || 0) - Number(b.daysCoverage || 0))
      .slice(0, 8);

    trendChart = new window.Chart(trendCtx, {
      type: "bar",
      data: {
        labels: topByCoverage.map((item) => String(item.itemSku || item.itemId || "-")),
        datasets: [
          {
            label: "Crescimento % vs periodo anterior",
            data: topByCoverage.map((item) => Number(item?.trend?.deltaPct || 0)),
            backgroundColor: topByCoverage.map((item) =>
              Number(item?.trend?.deltaPct || 0) >= 0 ? "rgba(34,197,94,.7)" : "rgba(239,68,68,.7)"),
          },
          {
            label: "Cobertura (dias)",
            data: topByCoverage.map((item) => Number(item.daysCoverage || 0)),
            type: "line",
            borderColor: "rgba(59,130,246,.9)",
            backgroundColor: "rgba(59,130,246,.15)",
            yAxisID: "y1",
            tension: 0.25,
          },
        ],
      },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        scales: {
          y: {
            title: { display: true, text: "Crescimento (%)" },
          },
          y1: {
            position: "right",
            title: { display: true, text: "Cobertura (dias)" },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
  }

  function renderTable(data) {
    const tbody = $("stockAlertTableBody");
    if (!tbody) return;
    const items = Array.isArray(data?.items) ? data.items : [];
    state.lastItems = items;

    if (!items.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="18"><div class="muted">Nenhum item monitorado para os filtros atuais.</div></td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = items
      .map((item) => {
        const alerts = Array.isArray(item?.alerts) ? item.alerts : [];
        const alertsText = alerts.length
          ? alerts.map((line) => `<div>* ${escapeHtml(line)}</div>`).join("")
          : `<span class="muted">Sem alerta ativo</span>`;
        const recommendation = item?.recommendation || {};
        const image = item?.imageUrl
          ? `<img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title || "produto")}" class="stock-alert-thumb" />`
          : `<div class="stock-alert-thumb stock-alert-thumb--empty">Sem imagem</div>`;

        return `
          <tr>
            <td>${escapeHtml(item.itemId || "-")}</td>
            <td>
              <div class="stock-alert-product-cell">
                ${image}
                <div>
                  <div>${escapeHtml(item.title || "-")}</div>
                  <div class="muted">SKU ${escapeHtml(item.itemSku || "-")}</div>
                </div>
              </div>
            </td>
            <td>${formatInt(item.stock || 0)}</td>
            <td>${formatInt(item?.sales?.days30 || 0)}</td>
            <td>${formatInt(item?.sales?.days60 || 0)}</td>
            <td>${formatInt(item?.sales?.days90 || 0)}</td>
            <td>${formatDecimal(item.averageSalesPerDay || 0, 2)}</td>
            <td>${formatDecimal(item.adjustedDailyDemand || 0, 2)}</td>
            <td>${item.daysCoverage == null ? "-" : formatDecimal(item.daysCoverage, 1)}</td>
            <td>${formatDateBr(item.stockoutDate)}</td>
            <td>${escapeHtml(trendLabel(item?.trend?.status))}</td>
            <td>${formatPct(item?.trend?.deltaPct || 0, 2)}</td>
            <td>${escapeHtml(riskLabel(item.riskLevel))}</td>
            <td>${formatDecimal(item.giro || 0, 2)}</td>
            <td>${formatInt(item.recommendedPurchaseQty || 0)}</td>
            <td>
              <div>${toneIcon(recommendation?.tone)} ${escapeHtml(recommendation?.title || "-")}</div>
              <div class="muted">${escapeHtml(recommendation?.message || "-")}</div>
            </td>
            <td>${alertsText}</td>
            <td>
              <div class="stock-alert-actions">
                <button class="btn btn-ghost btn-stock-alert-purchase" data-item-id="${escapeHtml(item.itemId)}">Compra realizada</button>
                <button class="btn btn-ghost btn-stock-alert-confirm" data-item-id="${escapeHtml(item.itemId)}">Confirmar chegada</button>
                <button class="btn btn-ghost btn-stock-alert-remove" data-item-id="${escapeHtml(item.itemId)}">Parar monitoramento</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function renderSearch(data) {
    const root = $("stockAlertSearchResults");
    if (!root) return;
    const items = Array.isArray(data?.items) ? data.items : [];

    if (!items.length) {
      root.innerHTML = `<div class="muted">Nenhum produto encontrado para a busca informada.</div>`;
      return;
    }

    root.innerHTML = items
      .map((item) => {
        const checked = state.selectedToMonitor.has(String(item.itemId)) ? "checked" : "";
        const image = item?.imageUrl
          ? `<img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title || "produto")}" class="stock-alert-thumb" />`
          : `<div class="stock-alert-thumb stock-alert-thumb--empty">Sem imagem</div>`;
        return `
          <label class="stock-alert-product-option">
            <input type="checkbox" class="stock-alert-product-check" data-item-id="${escapeHtml(item.itemId)}" ${checked}/>
            ${image}
            <span>
              <strong>${escapeHtml(item.title || "Produto")}</strong>
              <small>ID ${escapeHtml(item.itemId || "-")} | SKU ${escapeHtml(item.itemSku || "-")} | Estoque ${formatInt(item.totalStock || 0)}${item.isMonitored ? " | ja monitorado" : ""}</small>
            </span>
          </label>
        `;
      })
      .join("");
  }

  function renderSearchIdle() {
    const root = $("stockAlertSearchResults");
    if (!root) return;
    root.innerHTML = `<div class="muted">Digite um termo e clique em Buscar para listar produtos.</div>`;
  }

  async function loadOverview() {
    const status = $("stockAlertStatus");
    if (status) status.textContent = "Carregando monitoramento de estoque...";
    const data = await fetchOverview();
    renderSummary(data);
    renderInsights(data);
    renderCharts(data);
    renderTable(data);
    if (status) status.textContent = "";
    return data;
  }

  async function loadSearch() {
    if (!state.searchQuery) {
      renderSearchIdle();
      return;
    }
    const data = await fetchSearchProducts();
    renderSearch(data);
  }

  async function onMonitorSelected() {
    const itemIds = Array.from(state.selectedToMonitor);
    if (!itemIds.length) return;

    await apiRequest("/shopee/shops/active/dashboard/stock-alert/monitor", {
      method: "POST",
      body: JSON.stringify({ itemIds }),
    });

    state.selectedToMonitor.clear();
    await loadSearch();
    await loadOverview();
    await loadKpi();
  }

  async function onSyncMonitoredStock() {
    const status = $("stockAlertStatus");
    const button = $("stockAlertSyncStock");
    if (button) button.disabled = true;
    if (status) status.textContent = "Sincronizando estoque dos itens monitorados...";

    try {
      const data = await apiRequest("/shopee/shops/active/dashboard/stock-alert/sync-stock", {
        method: "POST",
        body: "{}",
      });
      await loadOverview();
      await loadKpi();
      const summary = data?.summary || {};
      if (status) {
        status.textContent = `Sincronizacao concluida. Produtos atualizados: ${formatInt(summary.updatedProducts || 0)}. Variacoes atualizadas: ${formatInt(summary.updatedModels || 0)}.`;
      }
    } catch (error) {
      if (status) {
        status.textContent = `Falha ao sincronizar estoque: ${String(error?.message || error)}`;
      }
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function onPurchaseMarked(itemId) {
    const row = state.lastItems.find((item) => String(item.itemId) === String(itemId));
    const defaultDate = new Date();
    defaultDate.setDate(defaultDate.getDate() + 7);
    const input = await openArrivalDateDialog({
      defaultDate: defaultDate.toISOString().slice(0, 10),
      productLabel: row?.title || row?.itemSku || `ID ${itemId}`,
    });
    if (!input) return;

    await apiRequest(`/shopee/shops/active/dashboard/stock-alert/${encodeURIComponent(itemId)}/purchase`, {
      method: "POST",
      body: JSON.stringify({
        expectedArrivalDate: String(input).trim(),
        currentStock: Number(row?.stock || 0),
      }),
    });
    await loadOverview();
    await loadKpi();
  }

  function isIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
  }

  function closeArrivalDateDialog(result = null) {
    const overlay = $("stockAlertArrivalDialog");
    if (overlay) {
      overlay.classList.remove("is-open");
      overlay.setAttribute("aria-hidden", "true");
    }
    if (arrivalDialogResolver) {
      const resolve = arrivalDialogResolver;
      arrivalDialogResolver = null;
      resolve(result);
    }
  }

  function openArrivalDateDialog({ defaultDate, productLabel }) {
    return new Promise((resolve) => {
      const overlay = $("stockAlertArrivalDialog");
      const input = $("stockAlertArrivalDialogDate");
      const error = $("stockAlertArrivalDialogError");
      const product = $("stockAlertArrivalDialogProduct");
      if (!overlay || !input) {
        const legacy = window.prompt(
          "Informe a data estimada de chegada do novo estoque (AAAA-MM-DD):",
          defaultDate || "",
        );
        resolve(String(legacy || "").trim() || null);
        return;
      }

      arrivalDialogResolver = resolve;
      if (error) error.textContent = "";
      if (product) product.textContent = productLabel ? `Produto: ${productLabel}` : "";
      input.value = String(defaultDate || "");
      overlay.classList.add("is-open");
      overlay.setAttribute("aria-hidden", "false");

      setTimeout(() => {
        input.focus();
      }, 0);
    });
  }

  async function onConfirmArrival(itemId) {
    await apiRequest(
      `/shopee/shops/active/dashboard/stock-alert/${encodeURIComponent(itemId)}/confirm-arrival`,
      { method: "POST", body: "{}" },
    );
    await loadOverview();
    await loadKpi();
  }

  async function onUnmonitor(itemId) {
    await apiRequest(`/shopee/shops/active/dashboard/stock-alert/${encodeURIComponent(itemId)}`, {
      method: "DELETE",
    });
    state.selectedToMonitor.delete(String(itemId));
    await loadSearch();
    await loadOverview();
    await loadKpi();
  }

  function bindEvents() {
    if (isBound) return;
    isBound = true;

    $("stockAlertArrivalDialogConfirm")?.addEventListener("click", () => {
      const input = $("stockAlertArrivalDialogDate");
      const error = $("stockAlertArrivalDialogError");
      const value = String(input?.value || "").trim();
      if (!isIsoDate(value)) {
        if (error) error.textContent = "Informe uma data valida no formato AAAA-MM-DD.";
        input?.focus();
        return;
      }
      if (error) error.textContent = "";
      closeArrivalDateDialog(value);
    });

    $("stockAlertArrivalDialogCancel")?.addEventListener("click", () => {
      closeArrivalDateDialog(null);
    });

    $("stockAlertArrivalDialogClose")?.addEventListener("click", () => {
      closeArrivalDateDialog(null);
    });

    $("stockAlertArrivalDialog")?.addEventListener("click", (event) => {
      if (event.target?.id === "stockAlertArrivalDialog") {
        closeArrivalDateDialog(null);
      }
    });

    $("stockAlertArrivalDialogDate")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        $("stockAlertArrivalDialogConfirm")?.click();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeArrivalDateDialog(null);
      }
    });

    $("stockAlertPreset")?.addEventListener("change", async (event) => {
      state.periodPreset = String(event.target.value || "30d");
      const customWrap = $("stockAlertCustomRange");
      if (customWrap) customWrap.style.display = state.periodPreset === "custom" ? "flex" : "none";
      await loadOverview();
      await loadKpi();
    });

    $("stockAlertDateFrom")?.addEventListener("change", (event) => {
      state.dateFrom = String(event.target.value || "");
    });
    $("stockAlertDateTo")?.addEventListener("change", (event) => {
      state.dateTo = String(event.target.value || "");
    });
    $("stockAlertApplyCustom")?.addEventListener("click", async () => {
      if (state.periodPreset !== "custom") state.periodPreset = "custom";
      await loadOverview();
      await loadKpi();
    });

    $("stockAlertRiskOnly")?.addEventListener("change", async (event) => {
      state.riskOnly = Boolean(event.target.checked);
      await loadOverview();
      await loadKpi();
    });

    $("stockAlertRefresh")?.addEventListener("click", async () => {
      await loadOverview();
      await loadKpi();
    });

    $("stockAlertSyncStock")?.addEventListener("click", async () => {
      await onSyncMonitoredStock();
    });

    $("stockAlertSearchBtn")?.addEventListener("click", async () => {
      state.searchQuery = String($("stockAlertSearchInput")?.value || "").trim();
      await loadSearch();
    });

    $("stockAlertSearchInput")?.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      state.searchQuery = String(event.target.value || "").trim();
      await loadSearch();
    });

    $("stockAlertAddSelected")?.addEventListener("click", onMonitorSelected);

    $("stockAlertSearchResults")?.addEventListener("change", (event) => {
      const target = event.target;
      if (!target || !target.classList.contains("stock-alert-product-check")) return;
      const itemId = String(target.getAttribute("data-item-id") || "");
      if (!itemId) return;
      if (target.checked) state.selectedToMonitor.add(itemId);
      else state.selectedToMonitor.delete(itemId);
    });

    $("stockAlertTableBody")?.addEventListener("click", async (event) => {
      const button = event.target?.closest?.("button");
      if (!button) return;
      const itemId = String(button.getAttribute("data-item-id") || "");
      if (!itemId) return;

      if (button.classList.contains("btn-stock-alert-purchase")) {
        await onPurchaseMarked(itemId);
      } else if (button.classList.contains("btn-stock-alert-confirm")) {
        await onConfirmArrival(itemId);
      } else if (button.classList.contains("btn-stock-alert-remove")) {
        await onUnmonitor(itemId);
      }
    });
  }

  async function load() {
    bindEvents();
    const syncBtn = $("stockAlertSyncStock");
    if (syncBtn) {
      syncBtn.style.display = "inline-flex";
      syncBtn.disabled = false;
    }
    const customWrap = $("stockAlertCustomRange");
    if (customWrap) customWrap.style.display = state.periodPreset === "custom" ? "flex" : "none";
    renderSearchIdle();
    await loadOverview();
    await loadKpi();
  }

  async function loadKpi() {
    const countEl = $("controlPanelStockRiskCount");
    const listEl = $("controlPanelStockRiskList");
    if (!countEl || !listEl) return;

    try {
      const data = await apiRequest("/shopee/shops/active/dashboard/stock-alert/overview?periodPreset=30d");
      const kpiItems = Array.isArray(data?.kpiRiskItems) ? data.kpiRiskItems : [];
      countEl.textContent = formatInt(kpiItems.length);

      if (!kpiItems.length) {
        listEl.innerHTML = `<div class="muted">Sem risco de ruptura alto/medio no momento.</div>`;
        return;
      }

      listEl.innerHTML = kpiItems
        .map(
          (item) => {
            const image = item?.imageUrl
              ? `<img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title || "produto")}" class="stock-alert-thumb" />`
              : `<div class="stock-alert-thumb stock-alert-thumb--empty">Sem imagem</div>`;
            return `
              <article class="control-panel-product">
                <div class="control-panel-product__rank">!</div>
                <div class="control-panel-product__body">
                  <div style="display:flex; gap:8px; align-items:center;">
                    ${image}
                    <strong>${escapeHtml(item?.title || "Produto")}</strong>
                  </div>
                  <span>SKU ${escapeHtml(item?.itemSku || "-")} | Estoque ${formatInt(item?.stock || 0)} | Ruptura ${formatDateBr(item?.stockoutDate)}</span>
                </div>
              </article>
            `;
          },
        )
        .join("");
    } catch (error) {
      countEl.textContent = "-";
      listEl.innerHTML = `<div class="muted">Falha ao carregar risco de ruptura: ${escapeHtml(error?.message || String(error))}</div>`;
    }
  }

  window.stockAlertManager = {
    load,
    loadKpi,
  };
})();
