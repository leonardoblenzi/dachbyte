(() => {
  "use strict";

  const moneyFmt = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
  const numFmt = new Intl.NumberFormat("pt-BR");
  const pctFmt = new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const state = {
    page: 1,
    pageSize: 25,
    lastQuery: "",
    riskStatus: "all",
  };

  const els = {
    status: document.getElementById("fml-cost-status"),
    form: document.getElementById("fml-cost-filters"),
    body: document.getElementById("fml-cost-body"),
    subtitle: document.getElementById("fml-cost-subtitle"),
    page: document.getElementById("fml-cost-page"),
    prev: document.getElementById("fml-cost-prev"),
    next: document.getElementById("fml-cost-next"),
    refresh: document.getElementById("fml-refresh-costs"),
    sync: document.getElementById("fml-sync-costs"),
    export: document.getElementById("fml-export-costs"),
    import: document.getElementById("fml-import-costs"),
    file: document.getElementById("fml-cost-file"),
    taxRate: document.getElementById("fml-tax-rate"),
    saveTax: document.getElementById("fml-save-tax"),
    lookupType: document.getElementById("fml-cost-lookup-type"),
    search: document.getElementById("fml-cost-search"),
    searchLabel: document.getElementById("fml-cost-search-label"),
    filterHelp: document.getElementById("fml-cost-filter-help"),
    kpiTotal: document.getElementById("fml-kpi-total"),
    kpiFilled: document.getElementById("fml-kpi-filled"),
    kpiMissing: document.getElementById("fml-kpi-missing"),
    kpiCoverage: document.getElementById("fml-kpi-coverage"),
    kpiNote: document.getElementById("fml-kpi-note"),
    riskTabs: document.querySelectorAll(".fml-risk-tab"),
    historyDrawer: document.getElementById("fml-history-drawer"),
    historyBackdrop: document.getElementById("fml-history-backdrop"),
    historyClose: document.getElementById("fml-history-close"),
    historySku: document.getElementById("fml-history-sku"),
    historyContent: document.getElementById("fml-history-content"),
    costInsights: document.getElementById("fml-cost-insights"),
    costPriority: document.getElementById("fml-cost-priority"),
  };

  function setStatus(text, tone = "info") {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.dataset.tone = tone;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[ch]);
  }

  function parseInputNumber(value) {
    const raw = String(value || "").trim();
    if (!raw) return 0;
    const normalized = raw.replace(/\./g, "").replace(",", ".").replace(/[^0-9.-]/g, "");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : 0;
  }

  function fmtMoney(value) {
    return moneyFmt.format(Number(value || 0));
  }

  function fmtNum(value) {
    return numFmt.format(Number(value || 0));
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

  function fmtDeltaPct(value) {
    if (value == null || !Number.isFinite(Number(value))) return "sem historico";
    const n = Number(value);
    const sign = n > 0 ? "+" : "";
    return `${sign}${pctFmt.format(n)} em 30d`;
  }

  function deltaClass(value, inverse = false) {
    if (value == null || !Number.isFinite(Number(value)) || Number(value) === 0) return "";
    const positive = Number(value) > 0;
    return positive === !inverse ? "is-up" : "is-down";
  }

  function buildQuery() {
    const params = new URLSearchParams(new FormData(els.form));
    params.set("page", String(state.page));
    params.set("pageSize", String(state.pageSize));
    if (state.riskStatus && state.riskStatus !== "all") {
      params.set("risk_status", state.riskStatus);
    }
    return params;
  }

  function applyLookupText() {
    const type = els.lookupType?.value || "sku";
    const labels = {
      sku: {
        label: "Buscar SKU",
        placeholder: "Informe um SKU ou uma lista",
        help: "SKU usa busca direta no Mercado Livre e encontra anuncios fora da lista inicial.",
      },
      mlb: {
        label: "Buscar MLB",
        placeholder: "Ex: MLB1234567890",
        help: "MLB busca o anuncio exato e usa o SKU de referencia encontrado nele.",
      },
      ean: {
        label: "Buscar EAN / GTIN",
        placeholder: "Informe EAN, GTIN ou lista",
        help: "EAN/GTIN filtra os codigos ja lidos nos atributos da base carregada.",
      },
      product: {
        label: "Buscar produto",
        placeholder: "Digite parte do nome do produto",
        help: "Produto filtra pelo titulo dentro da base carregada para manter a tela leve.",
      },
    };
    const config = labels[type] || labels.sku;
    if (els.searchLabel) els.searchLabel.textContent = config.label;
    if (els.search) els.search.placeholder = config.placeholder;
    if (els.filterHelp) els.filterHelp.textContent = config.help;
  }

  function thumb(row) {
    if (row.thumbnail) {
      return `<img src="${escapeHtml(row.thumbnail)}" alt="">`;
    }
    return '<span class="fml-thumb-fallback">ML</span>';
  }

  function renderSignal(row) {
    const flags = Array.isArray(row.risk_flags) ? row.risk_flags : [];
    if (flags.includes("margin_risk")) {
      return `<span class="fml-signal fml-signal--danger">Margem risco</span>
        <small class="fml-signal-note">Margem est. ${fmtPct(row.estimated_margin_pct)}</small>`;
    }
    if (flags.includes("cost_up")) {
      return `<span class="fml-signal fml-signal--warn">Custo subindo</span>
        <small class="fml-signal-note">${fmtDeltaPct(row.cost_delta_30d_pct)}</small>`;
    }
    if (flags.includes("price_down")) {
      return `<span class="fml-signal fml-signal--danger">Preco caindo</span>
        <small class="fml-signal-note">${fmtDeltaPct(row.price_delta_30d_pct)}</small>`;
    }
    if (row.latest_price_snapshot_date) {
      return `<span class="fml-signal fml-signal--ok">Monitorado</span>
        <small class="fml-signal-note">${fmtDate(row.latest_price_snapshot_date)}</small>`;
    }
    return `<span class="fml-signal">Sem historico</span>
      <small class="fml-signal-note">sincronize SKUs</small>`;
  }

  function riskLabel(type) {
    const labels = {
      margin_risk: "Margem em risco",
      cost_up: "Custo subindo",
      price_down: "Preco caindo",
      missing_cost: "Sem custo",
      healthy: "Saudavel",
    };
    return labels[type] || "Atencao";
  }

  function riskTone(type) {
    if (type === "margin_risk" || type === "price_down") return "danger";
    if (type === "cost_up" || type === "missing_cost") return "warn";
    return "ok";
  }

  function riskDetail(row) {
    if (row.risk_type === "margin_risk") {
      return `Margem est. ${row.estimated_margin_pct == null ? "-" : fmtPct(row.estimated_margin_pct)} - preco ${fmtMoney(row.current_price)}`;
    }
    if (row.risk_type === "cost_up") {
      return `Custo ${fmtDeltaPct(row.cost_delta_30d_pct)} - atual ${fmtMoney(row.cost)}`;
    }
    if (row.risk_type === "price_down") {
      return `Preco ${fmtDeltaPct(row.price_delta_30d_pct)} - atual ${fmtMoney(row.current_price)}`;
    }
    if (row.risk_type === "missing_cost") {
      return `${fmtNum(row.item_count)} anuncio(s), estoque ${fmtNum(row.stock)}`;
    }
    return "Sem alerta forte";
  }

  function renderRiskOverview(overview = {}) {
    const summary = overview.summary || {};
    const insights = Array.isArray(overview.insights) ? overview.insights : [];
    const ranking = Array.isArray(overview.ranking) ? overview.ranking : [];
    if (els.costInsights) {
      const kpis = `
        <div class="fml-cost-risk-kpis">
          <span><strong>${fmtNum(summary.attention_count)}</strong> em atencao</span>
          <span><strong>${fmtNum(summary.margin_risk_count)}</strong> margem risco</span>
          <span><strong>${fmtNum(summary.cost_up_count)}</strong> custo subindo</span>
          <span><strong>${fmtNum(summary.price_down_count)}</strong> preco caindo</span>
        </div>
      `;
      const cards = insights.length
        ? insights.map((item) => `
          <article class="fml-cost-insight fml-cost-insight--${escapeHtml(item.severity || "info")}">
            <span>${escapeHtml(riskLabel(item.type))}</span>
            <strong>${escapeHtml(item.title || "Insight")}</strong>
            <p>${escapeHtml(item.message || "")}</p>
          </article>
        `).join("")
        : '<div class="fml-empty">Sem insights para este recorte.</div>';
      els.costInsights.innerHTML = kpis + cards;
    }
    if (els.costPriority) {
      if (!ranking.length) {
        els.costPriority.innerHTML = '<div class="fml-empty">Nenhum SKU critico no recorte atual.</div>';
        return;
      }
      els.costPriority.innerHTML = ranking.map((row) => `
        <article class="fml-priority-row" data-sku="${escapeHtml(row.reference_sku || "")}">
          <div class="fml-priority-pos">#${fmtNum(row.position)}</div>
          <div class="fml-priority-product">
            ${row.thumbnail ? `<img src="${escapeHtml(row.thumbnail)}" alt="">` : '<span class="fml-thumb-fallback">ML</span>'}
            <div>
              <strong>${escapeHtml(row.reference_sku || "-")}</strong>
              <small title="${escapeHtml(row.title || "")}">${escapeHtml(row.title || "-")}</small>
              <em>${escapeHtml((row.mlbs || []).join(" | ") || "Sem MLB de amostra")}</em>
            </div>
          </div>
          <div>
            <span class="fml-signal fml-signal--${riskTone(row.risk_type)}">${escapeHtml(riskLabel(row.risk_type))}</span>
            <small class="fml-signal-note">${escapeHtml(riskDetail(row))}</small>
          </div>
          <button class="fml-btn fml-btn--ghost fml-history-open" type="button">Analisar SKU</button>
        </article>
      `).join("");
    }
  }

  function renderRows(items = []) {
    if (!items.length) {
      els.body.innerHTML = '<tr><td colspan="9" class="fml-empty">Nenhum SKU encontrado.</td></tr>';
      return;
    }

    els.body.innerHTML = items.map((row) => {
      const sku = row.reference_sku || "Sem SKU";
      const skuChip = row.has_reference_sku
        ? `<span class="fml-chip">${escapeHtml(sku)}</span>`
        : '<span class="fml-chip fml-chip--missing">Sem SKU</span>';
      const eans = (row.eans || []).map((ean) => `<span class="fml-chip">${escapeHtml(ean)}</span>`).join("");
      const mlbs = (row.mlbs || []).map((mlb) => `<span class="fml-chip">${escapeHtml(mlb)}</span>`).join("");
      const hidden = Number(row.hidden_mlbs_count || 0) > 0
        ? `<span class="fml-chip">+${fmtNum(row.hidden_mlbs_count)}</span>`
        : "";
      const statuses = (row.statuses || []).map((status) => `<span class="fml-chip">${escapeHtml(status)}</span>`).join("");
      const price = row.min_price === row.max_price
        ? fmtMoney(row.min_price)
        : `${fmtMoney(row.min_price)} a ${fmtMoney(row.max_price)}`;
      const missing = row.cost_status === "missing";

      return `
        <tr data-sku="${escapeHtml(row.reference_sku || "")}">
          <td>${skuChip}</td>
          <td>${eans || "-"}</td>
          <td>
            <div class="fml-product">
              ${thumb(row)}
              <div>
                <strong>${escapeHtml(row.title || "-")}</strong>
                <small>${fmtNum(row.item_count)} anuncio(s) - estoque ${fmtNum(row.stock)}</small>
              </div>
            </div>
          </td>
          <td>${mlbs || "-"}${hidden}</td>
          <td>${statuses || "-"}</td>
          <td>${escapeHtml(price)}</td>
          <td>${renderSignal(row)}</td>
          <td>
            <input class="fml-input fml-cost-input ${missing ? "is-missing" : ""}" type="text" inputmode="decimal" value="${Number(row.cost || 0).toFixed(2).replace(".", ",")}" ${row.has_reference_sku ? "" : "disabled"} />
          </td>
          <td>
            <div class="fml-row-actions">
              <button class="fml-btn fml-btn--ghost fml-save-cost" type="button" ${row.has_reference_sku ? "" : "disabled"}>Salvar</button>
              <button class="fml-btn fml-btn--ghost fml-history-open" type="button" ${row.has_reference_sku ? "" : "disabled"}>Historico</button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }

  function applySummary(summary = {}) {
    els.kpiTotal.textContent = fmtNum(summary.total_skus);
    els.kpiFilled.textContent = fmtNum(summary.filled_skus);
    els.kpiMissing.textContent = fmtNum(summary.missing_skus);
    els.kpiCoverage.textContent = fmtPct(summary.coverage_pct);
  }

  async function loadTax() {
    const response = await fetch(mlUrl("/api/financeiro-ml/settings/tax"), {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    const data = await response.json().catch(() => null);
    if (response.ok && data?.success && els.taxRate) {
      els.taxRate.value = String(Number(data.config?.aliquota || 0).toFixed(2)).replace(".", ",");
    }
  }

  async function saveTax() {
    const aliquota = parseInputNumber(els.taxRate.value);
    const response = await fetch(mlUrl("/api/financeiro-ml/settings/tax"), {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ aliquota }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) throw new Error(data?.error || "Falha ao salvar aliquota.");
    setStatus("Aliquota salva.", "ok");
  }

  async function loadCosts({ force = false } = {}) {
    const params = buildQuery();
    if (force) params.set("force_refresh", "true");
    state.lastQuery = params.toString();
    els.body.innerHTML = '<tr><td colspan="9" class="fml-empty">Carregando custos...</td></tr>';
    setStatus("Carregando lista de SKUs...", "info");
    window.MLLoadingOverlay?.show({
      context: "Financeiro ML",
      label: "Custos",
      message: "Carregando anuncios e custos por SKU...",
      initialProgress: 16,
      maxProgress: 90,
    });

    try {
      const response = await fetch(mlUrl(`/api/financeiro-ml/costs?${params.toString()}`), {
        credentials: "include",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.error || "Falha ao carregar custos.");

      applySummary(data.summary || {});
      renderRiskOverview(data.risk_overview || {});
      renderRows(data.items || []);
      const partial = !!data.meta?.partial;
      els.subtitle.textContent = partial
        ? `${fmtNum(data.total)} SKU(s) no recorte carregado.`
        : `${fmtNum(data.total)} SKU(s) filtrado(s).`;
      if (els.kpiNote) {
        if (data.meta?.source === "catalog") {
          els.kpiNote.textContent = "Indicadores calculados sobre a base sincronizada de SKUs ativos da conta.";
        } else {
          els.kpiNote.textContent = partial
            ? `Indicadores da leitura otimizada atual, limitada a ${fmtNum(data.meta?.max_items)} anuncios. Para a planilha de preenchimento, use Baixar XLSX.`
            : "Indicadores da leitura carregada na tela. Para montar a planilha de preenchimento, use Baixar XLSX.";
        }
      }
      els.page.textContent = `Pagina ${data.page} de ${data.totalPages}`;
      els.prev.disabled = data.page <= 1;
      els.next.disabled = data.page >= data.totalPages;
      state.page = data.page;
      if (Number(data.meta?.targeted_items || 0) > 0) {
        if (data.meta?.status_filter_overridden) {
          setStatus("Anuncio encontrado pela busca direta fora do status selecionado. O custo pode ser cadastrado normalmente.", "info");
        } else {
          setStatus("Busca direta aplicada e custos carregados.", "ok");
        }
      } else if (data.meta?.source === "catalog") {
        setStatus("Base sincronizada de SKUs ativos carregada.", "ok");
      } else {
        setStatus(
          partial
            ? "Sincronize para obter todos os SKUs ativos da conta."
            : "Custos carregados.",
          partial ? "info" : "ok",
        );
      }
    } catch (error) {
      els.body.innerHTML = `<tr><td colspan="9" class="fml-empty">${escapeHtml(error.message)}</td></tr>`;
      setStatus(error.message || "Falha ao carregar.", "error");
    } finally {
      window.MLLoadingOverlay?.hide();
    }
  }

  async function saveRow(row) {
    const sku = row?.dataset?.sku;
    const input = row?.querySelector(".fml-cost-input");
    if (!sku || !input) return;
    const cost = parseInputNumber(input.value);
    const button = row.querySelector(".fml-save-cost");
    button.disabled = true;
    try {
      const response = await fetch(mlUrl(`/api/financeiro-ml/costs/${encodeURIComponent(sku)}`), {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ cost }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.error || "Falha ao salvar custo.");
      button.textContent = "Salvo";
      setStatus(`Custo salvo para ${sku}.`, "ok");
      setTimeout(() => {
        button.textContent = "Salvar";
      }, 900);
      await loadCosts();
    } finally {
      button.disabled = false;
    }
  }

  function openHistoryShell(sku) {
    if (els.historySku) els.historySku.textContent = sku || "-";
    if (els.historyContent) {
      els.historyContent.innerHTML = '<p class="fml-empty">Carregando historico do SKU...</p>';
    }
    els.historyDrawer?.removeAttribute("hidden");
    els.historyBackdrop?.removeAttribute("hidden");
    els.historyDrawer?.setAttribute("aria-hidden", "false");
    document.body.classList.add("fml-history-is-open");
  }

  function closeHistory() {
    els.historyDrawer?.setAttribute("hidden", "");
    els.historyBackdrop?.setAttribute("hidden", "");
    els.historyDrawer?.setAttribute("aria-hidden", "true");
    document.body.classList.remove("fml-history-is-open");
  }

  function scalePoints(series = [], key = "price", width = 360, height = 120) {
    const values = series.map((row) => Number(row[key])).filter((value) => Number.isFinite(value) && value > 0);
    if (!values.length) return "";
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1, max - min);
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
    if (!clean.length) {
      return '<div class="fml-history-empty">Sem historico suficiente para montar o grafico.</div>';
    }
    const pricePoints = scalePoints(clean, "price");
    const costPoints = scalePoints(clean, "cost");
    return `
      <div class="fml-history-chart">
        <div class="fml-history-chart-head">
          <span><i class="price"></i>Preco ML</span>
          <span><i class="cost"></i>Custo</span>
        </div>
        <svg viewBox="0 0 360 120" preserveAspectRatio="none" aria-hidden="true">
          <polyline class="fml-chart-line fml-chart-line--price" points="${escapeHtml(pricePoints)}"></polyline>
          <polyline class="fml-chart-line fml-chart-line--cost" points="${escapeHtml(costPoints)}"></polyline>
        </svg>
      </div>
    `;
  }

  function renderMetric(label, value, delta, options = {}) {
    const deltaText = delta == null ? "sem comparativo" : fmtDeltaPct(delta);
    return `
      <article class="fml-history-metric">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <small class="${deltaClass(delta, options.inverseDelta)}">${escapeHtml(deltaText)}</small>
      </article>
    `;
  }

  function alertClass(tone) {
    if (tone === "danger") return "fml-history-alert--danger";
    if (tone === "warn") return "fml-history-alert--warn";
    return "fml-history-alert--ok";
  }

  function renderHistory(data) {
    const summary = data.summary || {};
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    const listings = Array.isArray(data.listings) ? data.listings : [];
    const events = Array.isArray(data.events) ? data.events : [];
    if (els.historySku) els.historySku.textContent = data.sku || "-";
    els.historyContent.innerHTML = `
      <section class="fml-history-summary">
        ${renderMetric("Custo atual", fmtMoney(summary.current_cost), summary.cost_delta_30d_pct, { inverseDelta: true })}
        ${renderMetric("Preco vigente medio", fmtMoney(summary.current_price), summary.price_delta_30d_pct)}
        ${renderMetric("Margem estimada", summary.estimated_margin_pct == null ? "Nao calculada" : fmtPct(summary.estimated_margin_pct), summary.margin_delta_30d_pp)}
      </section>
      <section class="fml-history-diagnosis">
        <strong>Diagnostico</strong>
        <p>${escapeHtml(summary.diagnosis || "Historico carregado para analise.")}</p>
        <small>${escapeHtml(data.meta?.note || "")}</small>
      </section>
      <section class="fml-history-comparisons">
        ${["d7", "d30", "d90"].map((key) => {
          const comparison = data.comparisons?.[key] || {};
          const label = key === "d7" ? "7 dias" : key === "d30" ? "30 dias" : "90 dias";
          return `
            <article>
              <span>${label}</span>
              <strong class="${deltaClass(comparison.cost_delta_pct, true)}">Custo ${fmtDeltaPct(comparison.cost_delta_pct)}</strong>
              <small class="${deltaClass(comparison.price_delta_pct)}">Preco ${fmtDeltaPct(comparison.price_delta_pct)}</small>
            </article>
          `;
        }).join("")}
      </section>
      <section class="fml-history-alerts">
        ${alerts.map((alert) => `
          <article class="fml-history-alert ${alertClass(alert.tone)}">
            <strong>${escapeHtml(alert.title)}</strong>
            <p>${escapeHtml(alert.description)}</p>
          </article>
        `).join("")}
      </section>
      ${renderMiniChart(data.series || [])}
      <section class="fml-history-grid">
        <article>
          <span>Ultimo custo</span>
          <strong>${fmtDate(summary.last_cost_update)}</strong>
        </article>
        <article>
          <span>Ultimo preco ML</span>
          <strong>${fmtDate(summary.last_price_snapshot)}</strong>
        </article>
        <article>
          <span>Anuncios ligados</span>
          <strong>${fmtNum(summary.listings_count)}</strong>
        </article>
        <article>
          <span>Estoque total</span>
          <strong>${fmtNum(summary.stock_total)}</strong>
        </article>
      </section>
      <section class="fml-history-section">
        <h3>Anuncios deste SKU</h3>
        <div class="fml-history-listings">
          ${listings.length ? listings.slice(0, 8).map((item) => `
            <a href="${escapeHtml(item.permalink || "#")}" target="_blank" rel="noopener" class="fml-history-listing">
              <span>${escapeHtml(item.mlb || "-")}</span>
              <strong>${escapeHtml(item.title || data.sku || "-")}</strong>
              <small>${escapeHtml(item.status || "-")} &middot; ${fmtMoney(item.price)} &middot; estoque ${fmtNum(item.stock)}</small>
            </a>
          `).join("") : '<p class="fml-history-empty">Nenhum anuncio sincronizado para este SKU ainda.</p>'}
        </div>
      </section>
      <section class="fml-history-section">
        <h3>Linha do tempo</h3>
        <div class="fml-history-events">
          ${events.length ? events.map((event) => `
            <article>
              <span>${fmtDate(event.datetime || event.date)}</span>
              <strong>${escapeHtml(event.label)}</strong>
              <small>${fmtMoney(event.value)}${event.listings_count ? ` em ${fmtNum(event.listings_count)} anuncio(s)` : ""}</small>
            </article>
          `).join("") : '<p class="fml-history-empty">Sem eventos registrados.</p>'}
        </div>
      </section>
    `;
  }

  async function loadHistory(sku) {
    if (!sku) return;
    openHistoryShell(sku);
    try {
      const response = await fetch(mlUrl(`/api/financeiro-ml/costs/${encodeURIComponent(sku)}/timeline?days=180`), {
        credentials: "include",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.error || "Falha ao carregar historico.");
      renderHistory(data);
    } catch (error) {
      els.historyContent.innerHTML = `<p class="fml-empty">${escapeHtml(error.message || "Falha ao carregar historico.")}</p>`;
    }
  }

  async function fileToBase64(file) {
    const buffer = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  async function importFile(file) {
    if (!String(file?.name || "").toLowerCase().endsWith(".xlsx")) {
      throw new Error("Formato invalido. Selecione uma planilha XLSX (.xlsx).");
    }
    const content_base64 = await fileToBase64(file);
    const response = await fetch(mlUrl("/api/financeiro-ml/costs/import"), {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ filename: file.name, content_base64 }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) throw new Error(data?.error || "Falha ao importar custos.");
    setStatus(`Importacao concluida: ${fmtNum(data.updated)} SKU(s) atualizado(s).`, "ok");
  }

  async function pollSync(jobId) {
    if (!jobId) return;
    for (;;) {
      const response = await fetch(mlUrl(`/api/financeiro-ml/costs/sync/${encodeURIComponent(jobId)}`), {
        credentials: "include",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.error || "Falha ao consultar sincronizacao.");
      const job = data.job || {};
      setStatus(`Sincronizando SKUs relevantes... ${Math.round(Number(job.progress || 0))}%`, "info");
      if (job.completed) {
        if (job.status === "erro") throw new Error(job.failedReason || "Sincronizacao falhou.");
        setStatus("Sincronizacao concluida. Atualizando custos...", "ok");
        await loadCosts({ force: true });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1800));
    }
  }

  async function startSync() {
    if (els.sync) els.sync.disabled = true;
    try {
      setStatus("Iniciando sincronizacao dos SKUs relevantes...", "info");
      const response = await fetch(mlUrl("/api/financeiro-ml/costs/sync"), {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json" },
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.error || "Falha ao iniciar sincronizacao.");
      await pollSync(data.job_id);
    } finally {
      if (els.sync) els.sync.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    els.form?.addEventListener("submit", (event) => {
      event.preventDefault();
      state.page = 1;
      loadCosts();
    });
    els.lookupType?.addEventListener("change", () => {
      applyLookupText();
      if (els.search) els.search.value = "";
    });
    els.riskTabs?.forEach((tab) => {
      tab.addEventListener("click", () => {
        state.riskStatus = tab.dataset.risk || "all";
        state.page = 1;
        els.riskTabs.forEach((item) => item.classList.toggle("is-active", item === tab));
        loadCosts();
      });
    });
    els.prev?.addEventListener("click", () => {
      if (state.page > 1) {
        state.page -= 1;
        loadCosts();
      }
    });
    els.next?.addEventListener("click", () => {
      state.page += 1;
      loadCosts();
    });
    els.refresh?.addEventListener("click", () => loadCosts({ force: true }));
    els.sync?.addEventListener("click", async () => {
      try {
        await startSync();
      } catch (error) {
        setStatus(error.message || "Falha ao sincronizar SKUs.", "error");
      }
    });
    els.export?.addEventListener("click", () => {
      const params = buildQuery();
      params.delete("page");
      params.delete("pageSize");
      params.set("export_scope", "all");
      window.location.href = mlUrl(`/api/financeiro-ml/costs/export?${params.toString()}`);
    });
    els.import?.addEventListener("click", () => els.file?.click());
    els.file?.addEventListener("change", async () => {
      const file = els.file.files?.[0];
      if (!file) return;
      try {
        setStatus("Importando planilha XLSX...", "info");
        window.MLLoadingOverlay?.show({
          context: "Financeiro ML",
          label: "Importacao",
          message: "Processando planilha XLSX de custos por SKU...",
        });
        await importFile(file);
        await loadCosts({ force: true });
      } catch (error) {
        setStatus(error.message || "Falha ao importar.", "error");
      } finally {
        els.file.value = "";
        window.MLLoadingOverlay?.hide();
      }
    });
    els.saveTax?.addEventListener("click", async () => {
      try {
        await saveTax();
      } catch (error) {
        setStatus(error.message || "Falha ao salvar aliquota.", "error");
      }
    });
    els.historyClose?.addEventListener("click", closeHistory);
    els.historyBackdrop?.addEventListener("click", closeHistory);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeHistory();
    });
    els.costPriority?.addEventListener("click", (event) => {
      const historyButton = event.target.closest(".fml-history-open");
      if (!historyButton) return;
      const row = historyButton.closest("[data-sku]");
      loadHistory(row?.dataset?.sku);
    });
    els.body?.addEventListener("click", async (event) => {
      const historyButton = event.target.closest(".fml-history-open");
      if (historyButton) {
        const row = historyButton.closest("[data-sku]");
        const sku = row?.dataset?.sku;
        loadHistory(sku);
        return;
      }
      const button = event.target.closest(".fml-save-cost");
      if (!button) return;
      try {
        await saveRow(button.closest("tr"));
      } catch (error) {
        setStatus(error.message || "Falha ao salvar custo.", "error");
      }
    });
    els.body?.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") return;
      const input = event.target.closest(".fml-cost-input");
      if (!input) return;
      event.preventDefault();
      try {
        await saveRow(input.closest("tr"));
      } catch (error) {
        setStatus(error.message || "Falha ao salvar custo.", "error");
      }
    });

    applyLookupText();
    await loadTax().catch(() => {});
    await loadCosts();
  });
})();
