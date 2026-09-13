"use strict";

(() => {
  const state = {
    ordenarPor: "faturamento",
    toggles: {
      catalogo: null,
      clips: null,
      ads: null,
      full: null,
    },
    lastPayload: null,
    watchlistMap: {},
    pendingWatchlistRow: null,
    requestSeq: 0,
    rankingConfig: {
      persist_enabled: false,
      snapshot_limit: 30,
    },
    rankingCanManage: false,
    rankingMicroStatus: "Persistencia inativa",
    rankingConfigLoaded: false,
  };

  const $ = (id) => document.getElementById(id);
  const qsa = (selector) => Array.from(document.querySelectorAll(selector));
  const SNAPSHOT_PRESET_LIMITS = [30, 50, 100];
  const LIVE_LIMIT_MIN = 10;
  const LIVE_LIMIT_MAX = 100;

  const periodLabels = {
    ultimos_7_dias: "Ultimos 7 dias",
    mes_atual: "Mes atual",
    ultimos_30_dias: "Ultimos 30 dias",
    trimestre: "Trimestre",
    semestre: "Semestre",
    personalizado: "Data personalizada",
  };

  const compareLabels = {
    periodo_anterior: "Periodo anterior",
    ultimos_7_dias: "Ultimos 7 dias",
    mes_anterior: "Mes anterior",
    trimestre_anterior: "Trimestre anterior",
    semestre_anterior: "Semestre anterior",
    personalizado: "Data personalizada",
  };

  function isMainCustomPeriod(value) {
    const normalized = String(value || "").toLowerCase();
    return normalized === "custom" || normalized === "personalizado" || normalized === "data_personalizada";
  }

  function isCompareCustomPeriod(value) {
    const normalized = String(value || "").toLowerCase();
    return normalized === "custom" || normalized === "personalizado" || normalized === "data_personalizada";
  }

  function ymd(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(date, days) {
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + days);
    return d;
  }

  function addMonths(date, months) {
    const d = new Date(date.getTime());
    d.setMonth(d.getMonth() + months);
    return d;
  }

  function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  function endOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0);
  }

  function startOfQuarter(date) {
    const month = Math.floor(date.getMonth() / 3) * 3;
    return new Date(date.getFullYear(), month, 1);
  }

  function endOfQuarter(date) {
    const start = startOfQuarter(date);
    return new Date(start.getFullYear(), start.getMonth() + 3, 0);
  }

  function parseDateInput(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const dt = new Date(`${raw}T00:00:00`);
    if (!Number.isFinite(dt.getTime())) return null;
    return dt;
  }

  function readDateRange(startId, endId) {
    const from = parseDateInput($(startId)?.value);
    const to = parseDateInput($(endId)?.value);
    if (!from || !to || from > to) return null;
    return { from, to };
  }

  function writeDateRange(startId, endId, range) {
    const start = $(startId);
    const end = $(endId);
    if (!start || !end || !range?.from || !range?.to) return;
    start.value = ymd(range.from);
    end.value = ymd(range.to);
  }

  function resolveMainRangeForUi(periodValue) {
    const today = new Date();
    const period = String(periodValue || "mes_atual").toLowerCase();

    if (isMainCustomPeriod(period)) {
      const custom = readDateRange("dataInicio", "dataFim");
      if (custom) return custom;
      return { from: startOfMonth(today), to: today };
    }

    if (period === "ultimos_7_dias" || period === "7d") {
      return { from: addDays(today, -6), to: today };
    }
    if (period === "ultimos_30_dias" || period === "30d") {
      return { from: addDays(today, -29), to: today };
    }
    if (period === "trimestre" || period === "tri") {
      const quarterEnd = endOfQuarter(today);
      return { from: startOfQuarter(today), to: today < quarterEnd ? today : quarterEnd };
    }
    if (period === "semestre" || period === "sem") {
      return { from: addMonths(today, -6), to: today };
    }

    return { from: startOfMonth(today), to: today };
  }

  function resolveCompareRangeForUi(compareValue, mainRange) {
    const mode = String(compareValue || "periodo_anterior").toLowerCase();
    const today = new Date();
    const mainFrom = mainRange?.from || startOfMonth(today);
    const mainTo = mainRange?.to || today;
    const days = Math.max(1, Math.round((mainTo - mainFrom) / 86400000) + 1);

    if (isCompareCustomPeriod(mode)) {
      const custom = readDateRange("dataComparacaoInicio", "dataComparacaoFim");
      if (custom) return custom;
      return { from: addDays(mainFrom, -days), to: addDays(mainFrom, -1) };
    }

    if (mode === "ultimos_7_dias" || mode === "7d") {
      return { from: addDays(today, -6), to: today };
    }
    if (mode === "mes_anterior" || mode === "previous_month") {
      const prev = addMonths(startOfMonth(mainFrom), -1);
      return { from: startOfMonth(prev), to: endOfMonth(prev) };
    }
    if (mode === "trimestre_anterior" || mode === "triant") {
      const prevQuarter = addMonths(startOfQuarter(mainFrom), -3);
      return { from: prevQuarter, to: endOfQuarter(prevQuarter) };
    }
    if (mode === "semestre_anterior" || mode === "semant") {
      const to = addDays(mainFrom, -1);
      return { from: addMonths(to, -6), to };
    }

    return { from: addDays(mainFrom, -days), to: addDays(mainFrom, -1) };
  }

  function normalizeSnapshotLimit(value, fallback = 30) {
    const num = Number(value);
    return SNAPSHOT_PRESET_LIMITS.includes(num) ? num : fallback;
  }

  function parseBool(value, fallback = false) {
    if (value === true || value === false) return value;
    const normalized = String(value ?? "").trim().toLowerCase();
    if (["1", "true", "sim", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "nao", "no", "off"].includes(normalized)) return false;
    return fallback;
  }

  function money(cents) {
    return (Number(cents || 0) / 100).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
  }

  function pct(value, digits = 1) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "Novo";
    return `${Number(value).toFixed(digits)}%`;
  }

  function pp(value) {
    const n = Number(value || 0);
    return `${n >= 0 ? "+" : ""}${n.toFixed(1)} p.p.`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function signedDelta(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      return `<span class="rank-info">Novo</span>`;
    }
    const n = Number(value);
    const cls = n >= 0 ? "rank-up" : "rank-down";
    return `<span class="${cls}">${n >= 0 ? "↑" : "↓"} ${Math.abs(n).toFixed(1)}%</span>`;
  }

  function movementLabel(row) {
    if (!row.previous_position) return `<span class="rank-move rank-info">Novo</span>`;
    const diff = Number(row.position_movement || 0);
    if (diff > 0) return `<span class="rank-move rank-up">↑ +${diff}</span>`;
    if (diff < 0) return `<span class="rank-move rank-down">↓ ${Math.abs(diff)}</span>`;
    return `<span class="rank-move">-</span>`;
  }

  function statusClass(status) {
    const normalized = String(status || "").toLowerCase();
    if (normalized.includes("novo")) return "rank-status--new";
    if (normalized.includes("saiu")) return "rank-status--out";
    if (normalized.includes("crescendo")) return "rank-status--growth";
    if (normalized.includes("estavel")) return "rank-status--stable";
    if (normalized.includes("atencao")) return "rank-status--attention";
    return "rank-status--drop";
  }

  function badge(label, cls) {
    return `<span class="rank-badge ${cls}">${label}</span>`;
  }

  function appUrl(path) {
    return window.ML?.url ? window.ML.url(path) : typeof window.withBase === "function" ? window.withBase(path) : path;
  }

  async function apiJson(path, options = {}) {
    const response = await fetch(appUrl(path), {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || data.detail || `HTTP ${response.status}`);
    return data;
  }

  function renderBadges(row) {
    const b = row.badges || {};
    return [
      b.catalog ? badge("Catalogo", "rank-badge--purple") : "",
      b.clips ? badge("Clips", "rank-badge--blue") : "",
      b.full ? badge("Full", "rank-badge--blue") : "",
      b.promo ? badge("Promocao", "rank-badge--yellow") : "",
      b.ads ? badge("Ads", "rank-badge--gray") : "",
      b.free_shipping ? badge("Frete gratis", "rank-badge--green") : "",
    ].filter(Boolean).join("");
  }

  function renderTooltip(row) {
    const currentTicket = row.average_ticket_cents || 0;
    const previousTicket = row.previous_average_ticket_cents || 0;
    const summary = row.previous_position
      ? `${row.mlb} foi de #${row.previous_position} para #${row.position_current}.`
      : `${row.mlb} entrou no ranking neste periodo.`;
    return `
      <div class="rank-tooltip__box">
        <div class="rank-tooltip__title">Comparativo do periodo</div>
        <div class="rank-tooltip__row"><span>Vendas atuais</span><strong>${money(row.gross_sales_cents)}</strong></div>
        <div class="rank-tooltip__row"><span>Vendas anteriores</span><strong>${money(row.previous_gross_sales_cents)}</strong></div>
        <div class="rank-tooltip__row"><span>Qtd. atual</span><strong>${row.units_sold || 0}</strong></div>
        <div class="rank-tooltip__row"><span>Qtd. anterior</span><strong>${row.previous_units_sold || 0}</strong></div>
        <div class="rank-tooltip__row"><span>Ticket atual</span><strong>${money(currentTicket)}</strong></div>
        <div class="rank-tooltip__row"><span>Ticket anterior</span><strong>${money(previousTicket)}</strong></div>
        <div class="rank-tooltip__row"><span>Part. atual</span><strong>${pct((row.revenue_share || 0) * 100)}</strong></div>
        <div class="rank-tooltip__row"><span>Part. anterior</span><strong>${pct((row.previous_revenue_share || 0) * 100)}</strong></div>
        <div class="rank-tooltip__row"><span>Posicao</span><strong>#${row.position_current || "-"} / ${row.previous_position ? `#${row.previous_position}` : "-"}</strong></div>
        <div class="rank-tooltip__row"><span>Resumo</span><strong>${escapeHtml(summary)}</strong></div>
      </div>
    `;
  }

  function renderKpis(payload) {
    const summary = payload?.summary || {};
    const bestUp = summary.best_up;
    const bestDown = summary.best_down;
    const items = [
      {
        label: "Faturamento total",
        value: money(summary.gross_sales_total_cents),
        sub: signedDelta(summary.gross_sales_delta_percent) + " vs anterior",
      },
      {
        label: "Qtd. de vendas",
        value: `${Number(summary.units_total || 0).toLocaleString("pt-BR")} vendas`,
        sub: signedDelta(summary.units_delta_percent) + " vs anterior",
      },
      {
        label: "Ticket medio geral",
        value: money(summary.average_ticket_cents),
        sub: signedDelta(summary.average_ticket_delta_percent) + " vs anterior",
      },
      {
        label: `Top ${payload?.meta?.limite || 10} representam`,
        value: pct(Number(summary.top_share || 0) * 100),
        sub: "do faturamento total",
      },
      {
        label: "Maior crescimento",
        value: bestUp ? `#${bestUp.mlb}` : "-",
        sub: bestUp ? `<span class="rank-up">↑ ${bestUp.position_movement} posicoes</span>` : "Sem alta no periodo",
      },
      {
        label: "Maior queda",
        value: bestDown ? `#${bestDown.mlb}` : "-",
        sub: bestDown ? `<span class="rank-down">↓ ${Math.abs(bestDown.position_movement)} posicoes</span>` : "Sem queda no periodo",
      },
    ];

    $("rankingKpis").innerHTML = items.map((item) => `
      <article class="rank-kpi">
        <div class="rank-kpi__label">${item.label}</div>
        <div class="rank-kpi__value">${item.value}</div>
        <div class="rank-kpi__sub">${item.sub}</div>
      </article>
    `).join("");
  }

  function renderTable(payload) {
    const rows = Array.isArray(payload?.ranking) ? payload.ranking : [];
    const body = $("rankingBody");
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="8" class="rank-empty">Nenhum anuncio encontrado para os filtros selecionados.</td></tr>`;
      return;
    }

    body.innerHTML = rows.map((row) => {
      const title = escapeHtml(row.title || row.mlb);
      const variation = row.variation ? `<div class="rank-product__meta">${escapeHtml(row.variation)}</div>` : "";
      const thumb = row.thumbnail
        ? `<img src="${escapeHtml(row.thumbnail)}" alt="" loading="lazy" />`
        : `<span aria-hidden="true">▢</span>`;
      const unitDelta = Number(row.units_delta || 0);
      const unitDeltaCls = unitDelta >= 0 ? "rank-up" : "rank-down";
      const inWatchlist = !!state.watchlistMap?.[row.mlb];
      return `
        <tr>
          <td>
            <div class="rank-position">#${row.position_current}</div>
            ${movementLabel(row)}
          </td>
          <td>
            <div class="rank-product">
              <div class="rank-thumb">${thumb}</div>
              <div>
                <div class="rank-product__mlb">${escapeHtml(row.mlb)}</div>
                <div class="rank-product__title" title="${title}">${title}</div>
                ${variation}
                <div class="rank-product__meta">${money(row.average_price_cents)} medio no periodo</div>
                <div class="rank-badges">${renderBadges(row)}</div>
                <button class="rank-watchlist-btn rank-product__watchlist ${inWatchlist ? "is-active" : ""}" type="button" data-watchlist-mlb="${escapeHtml(row.mlb)}" data-watchlist-added="${inWatchlist ? "1" : "0"}" aria-label="${inWatchlist ? "Ja esta na Watchlist" : "Adicionar a Watchlist"}" title="${inWatchlist ? "Ja esta na Watchlist" : "Adicionar a Watchlist de Estrategicos"}">
                  <span class="rank-watchlist-btn__icon" aria-hidden="true">${inWatchlist ? "♥" : "♡"}</span> ${inWatchlist ? "Na Watchlist" : "Watchlist"}
                </button>
              </div>
            </div>
          </td>
          <td>
            <div class="rank-tooltip">
              <div class="rank-value">${money(row.gross_sales_cents)}</div>
              <div class="rank-delta">${signedDelta(row.gross_sales_delta_percent)}</div>
              ${renderTooltip(row)}
            </div>
          </td>
          <td>
            <div class="rank-value">${Number(row.units_sold || 0).toLocaleString("pt-BR")} vendas</div>
            <div class="rank-delta ${unitDeltaCls}">${unitDelta >= 0 ? "↑ +" : "↓ "}${Math.abs(unitDelta)} vs ant.</div>
          </td>
          <td>
            <div class="rank-value">${pct(Number(row.revenue_share || 0) * 100)}</div>
            <div class="rank-sub">${pp(row.revenue_share_delta_pp)}</div>
          </td>
          <td>
            <div class="rank-value">${money(row.average_ticket_cents)}</div>
            <div class="rank-sub">ant: ${money(row.previous_average_ticket_cents)}</div>
          </td>
          <td>
            <div class="rank-value">${row.previous_position ? `#${row.previous_position}` : "-"}</div>
          </td>
          <td><span class="rank-status ${statusClass(row.performance_status)}">${escapeHtml(row.performance_status)}</span></td>
        </tr>
      `;
    }).join("");
  }

  function renderMovement(payload) {
    const rows = Array.isArray(payload?.ranking) ? payload.ranking : [];
    const exited = Array.isArray(payload?.exited_ranking) ? payload.exited_ranking : [];
    const list = rows.concat(exited).slice(0, Number(payload?.meta?.limite || 10) + 5);
    $("movementLabel").textContent = `${list.length} movimentos`;
    $("rankingMovement").innerHTML = list.map((row) => {
      const exitedRow = row.exited || !row.position_current;
      const before = row.previous_position ? `#${row.previous_position}` : "Nao estava";
      const after = exitedRow ? "Saiu" : `#${row.position_current}`;
      const movement = exitedRow
        ? `<span class="rank-down">Saiu</span>`
        : movementLabel(row).replace("rank-move ", "");
      return `
        <div class="rank-movement__row">
          <span class="rank-movement__mlb">${escapeHtml(row.mlb)}</span>
          <span class="rank-movement__box">${before}</span>
          <span aria-hidden="true">→</span>
          <span class="rank-movement__box">${after}</span>
          <span class="rank-movement__title">${escapeHtml(row.title || row.mlb)}</span>
          ${movement}
        </div>
      `;
    }).join("");
  }

  function renderInsights(payload) {
    const insights = Array.isArray(payload?.insights) ? payload.insights : [];
    if (!insights.length) {
      $("rankingInsights").innerHTML = `<div class="rank-empty">Sem insights para este recorte.</div>`;
      return;
    }
    const typeLabel = {
      growth: "Movimentacao positiva",
      drop: "Movimentacao negativa",
      entered: "Novo no ranking",
      exited: "Saiu do ranking",
      attention: "Atencao",
      revenue_up: "Faturamento em alta",
      revenue_down: "Faturamento em queda",
      concentration: "Concentracao",
    };
    $("rankingInsights").innerHTML = insights.map((item) => `
      <article class="rank-insight rank-insight--${escapeHtml(item.severity || "info")}">
        <div class="rank-insight__type">${escapeHtml(typeLabel[item.type] || "Insight")}</div>
        <div class="rank-insight__title">${escapeHtml(item.title || "Ranking")}</div>
        <div class="rank-insight__message">${escapeHtml(item.message || "")}</div>
      </article>
    `).join("");
  }

  function setLoading(on) {
    const body = $("rankingBody");
    if (on) {
      body.innerHTML = `<tr><td colspan="8" class="rank-empty">Carregando ranking...</td></tr>`;
      window.MLLoadingOverlay?.show?.({
        context: "Ranking",
        message: "Consultando vendas e comparando posicoes...",
        initialProgress: 18,
        maxProgress: 88,
      });
    } else {
      window.MLLoadingOverlay?.hide?.();
    }
  }

  function collectParams() {
    const params = new URLSearchParams();
    const form = $("rankingFilters");
    const data = new FormData(form);
    data.forEach((value, key) => {
      const text = String(value || "").trim();
      if (text) params.set(key, text);
    });
    const rawLimit = Number(params.get("limite") || LIVE_LIMIT_MIN);
    const safeLimit = Number.isFinite(rawLimit)
      ? Math.max(LIVE_LIMIT_MIN, Math.min(LIVE_LIMIT_MAX, rawLimit))
      : LIVE_LIMIT_MIN;
    params.set("limite", String(safeLimit));
    params.set("ordenarPor", state.ordenarPor);
    ["catalogo", "clips", "ads", "full"].forEach((key) => {
      if (state.toggles[key] !== null) params.set(key, state.toggles[key] ? "1" : "0");
    });
    if (!isMainCustomPeriod($("periodo")?.value)) {
      params.delete("dataInicio");
      params.delete("dataFim");
    }
    if (!isCompareCustomPeriod($("compararCom")?.value)) {
      params.delete("dataComparacaoInicio");
      params.delete("dataComparacaoFim");
    }
    return params;
  }

  async function loadRankingConfig() {
    try {
      const response = await apiJson("/api/mercadolivre/ranking-anuncios/config");
      const config = response?.config || {};
      state.rankingConfig = {
        persist_enabled: parseBool(config.persist_enabled, false),
        snapshot_limit: normalizeSnapshotLimit(config.snapshot_limit, 30),
      };
      state.rankingCanManage = parseBool(response?.permissions?.can_manage, false);
      state.rankingMicroStatus = String(response?.micro_status || "").trim() || "Persistencia inativa";
    } catch (error) {
      console.warn("[Ranking] Falha ao carregar configuracao:", error?.message || error);
      state.rankingConfig = {
        persist_enabled: false,
        snapshot_limit: 30,
      };
      state.rankingCanManage = false;
      state.rankingMicroStatus = "Persistencia inativa";
    } finally {
      state.rankingConfigLoaded = true;
      hydrateRankingConfigUi();
    }
  }

  function hydrateRankingConfigUi() {
    const persistNode = $("rankPersistSnapshots");
    const saveButton = $("btnSaveRankingConfig");
    const readOnlyNote = $("rankConfigReadonlyNote");
    const statusNode = $("rankPersistStatus");
    const disabled = !state.rankingCanManage;
    if (persistNode) {
      persistNode.checked = !!state.rankingConfig.persist_enabled;
      persistNode.disabled = disabled;
    }
    qsa("[data-rank-preset-limit]").forEach((button) => {
      const limit = normalizeSnapshotLimit(button.dataset.rankPresetLimit, 30);
      button.classList.toggle("is-active", limit === normalizeSnapshotLimit(state.rankingConfig.snapshot_limit, 30));
      button.disabled = disabled;
      button.setAttribute("aria-disabled", disabled ? "true" : "false");
    });
    if (saveButton) {
      saveButton.disabled = disabled;
      saveButton.hidden = false;
    }
    if (readOnlyNote) {
      readOnlyNote.hidden = !disabled;
    }
    if (statusNode) {
      statusNode.textContent = state.rankingMicroStatus || "Persistencia inativa";
    }
  }

  function closeRankingConfigModal() {
    const modal = $("rankConfigModal");
    if (modal) modal.hidden = true;
  }

  function openRankingConfigModal() {
    hydrateRankingConfigUi();
    const modal = $("rankConfigModal");
    if (modal) modal.hidden = false;
  }

  async function saveRankingConfig() {
    if (!state.rankingCanManage) return;
    const button = $("btnSaveRankingConfig");
    if (!button) return;
    const currentLimit = qsa("[data-rank-preset-limit].is-active")[0]?.dataset?.rankPresetLimit;
    const payload = {
      persist_enabled: $("rankPersistSnapshots")?.checked === true,
      snapshot_limit: normalizeSnapshotLimit(currentLimit, state.rankingConfig.snapshot_limit || 30),
    };
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Salvando...";
    try {
      const response = await apiJson("/api/mercadolivre/ranking-anuncios/config", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      state.rankingConfig = {
        persist_enabled: parseBool(response?.config?.persist_enabled, payload.persist_enabled),
        snapshot_limit: normalizeSnapshotLimit(response?.config?.snapshot_limit, payload.snapshot_limit),
      };
      state.rankingCanManage = parseBool(response?.permissions?.can_manage, state.rankingCanManage);
      state.rankingMicroStatus = String(response?.micro_status || "").trim() || "Persistencia inativa";
      hydrateRankingConfigUi();
      closeRankingConfigModal();
    } catch (error) {
      alert(error?.message || "Nao foi possivel salvar o modo de performance.");
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  async function loadRanking() {
    const requestId = ++state.requestSeq;
    setLoading(true);
    try {
      const response = await fetch(`/api/mercadolivre/ranking-anuncios?${collectParams().toString()}`, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.detail || payload?.error || `HTTP ${response.status}`);
      }
      if (requestId !== state.requestSeq) return;
      state.lastPayload = payload;
      await syncWatchlistContains(payload.ranking || []);
      const sourceText = payload?.meta?.source === "snapshot" && payload?.meta?.snapshot_limit
        ? ` • snapshot mensal (${payload.meta.snapshot_limit})`
        : "";
      $("rankLabel").textContent = `Top ${payload.meta.limite} - ordenado por ${payload.meta.ordenarPor === "quantidade" ? "quantidade" : "faturamento"}${sourceText}`;
      renderKpis(payload);
      renderTable(payload);
      renderMovement(payload);
      renderInsights(payload);
    } catch (error) {
      if (requestId !== state.requestSeq) return;
      console.error(error);
      $("rankingBody").innerHTML = `<tr><td colspan="8" class="rank-empty">Falha ao carregar ranking: ${escapeHtml(error?.message || error)}</td></tr>`;
    } finally {
      if (requestId === state.requestSeq) setLoading(false);
    }
  }

  async function syncWatchlistContains(rows = []) {
    const mlbs = rows.map((row) => row.mlb).filter(Boolean).slice(0, 500);
    if (!mlbs.length) {
      state.watchlistMap = {};
      return;
    }
    try {
      const data = await apiJson(`/api/estrategicos/watchlist/contains?mlbs=${encodeURIComponent(mlbs.join(","))}`);
      state.watchlistMap = data.items || {};
    } catch (error) {
      console.warn("Falha ao verificar Watchlist", error);
      state.watchlistMap = {};
    }
  }

  function closeWatchlistModal() {
    const modal = $("rankWatchlistModal");
    if (modal) modal.hidden = true;
    state.pendingWatchlistRow = null;
  }

  function openWatchlistModal(mlb) {
    const rows = Array.isArray(state.lastPayload?.ranking) ? state.lastPayload.ranking : [];
    const row = rows.find((item) => String(item.mlb) === String(mlb));
    if (!row || state.watchlistMap?.[row.mlb]) return;
    state.pendingWatchlistRow = row;
    $("rankWatchlistReason").value = "Queda no ranking";
    $("rankWatchlistNotes").value = "";
    $("rankWatchlistProduct").innerHTML = `
      <div class="rank-product">
        <div class="rank-thumb">${row.thumbnail ? `<img src="${escapeHtml(row.thumbnail)}" alt="" loading="lazy" />` : `<span aria-hidden="true">&#9633;</span>`}</div>
        <div>
          <div class="rank-product__mlb">${escapeHtml(row.mlb)}</div>
          <div class="rank-product__title">${escapeHtml(row.title || row.mlb)}</div>
          <div class="rank-product__meta">Posicao atual #${escapeHtml(row.position_current || "-")} · ${money(row.gross_sales_cents)} no periodo</div>
        </div>
      </div>`;
    $("rankWatchlistModal").hidden = false;
  }

  async function confirmWatchlistAdd() {
    const row = state.pendingWatchlistRow;
    const btn = $("btnConfirmRankWatchlist");
    if (!row || !btn) return;
    const original = btn.innerHTML;
    try {
      btn.disabled = true;
      btn.innerHTML = "Adicionando...";
      await apiJson("/api/estrategicos/watchlist", {
        method: "POST",
        body: JSON.stringify({
          item: {
            mlb: row.mlb,
            id: row.mlb,
            sku: row.sku || null,
            title: row.title || row.mlb,
            thumbnail: row.thumbnail || null,
            price: row.average_price_cents ? Number(row.average_price_cents) / 100 : null,
          },
          reason: $("rankWatchlistReason").value,
          notes: $("rankWatchlistNotes").value,
          base_metrics: row,
        }),
      });
      state.watchlistMap[row.mlb] = { status: "tracking" };
      closeWatchlistModal();
      renderTable(state.lastPayload);
    } catch (error) {
      alert(error.message || "Nao foi possivel adicionar a Watchlist.");
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  function updateCustomVisibility() {
    const mainCustom = isMainCustomPeriod($("periodo")?.value);
    const compareCustom = isCompareCustomPeriod($("compararCom")?.value);

    let mainRange = resolveMainRangeForUi($("periodo")?.value);
    if (!mainCustom) {
      writeDateRange("dataInicio", "dataFim", mainRange);
    } else if (!readDateRange("dataInicio", "dataFim")) {
      writeDateRange("dataInicio", "dataFim", mainRange);
      mainRange = resolveMainRangeForUi($("periodo")?.value);
    }

    const compareRange = resolveCompareRangeForUi($("compararCom")?.value, mainRange);
    if (!compareCustom) {
      writeDateRange("dataComparacaoInicio", "dataComparacaoFim", compareRange);
    } else if (!readDateRange("dataComparacaoInicio", "dataComparacaoFim")) {
      writeDateRange("dataComparacaoInicio", "dataComparacaoFim", compareRange);
    }

    qsa("[data-custom-main]").forEach((node) => {
      const input = node.querySelector("input");
      if (input) input.disabled = !mainCustom;
      node.classList.toggle("is-disabled", !mainCustom);
    });
    qsa("[data-custom-compare]").forEach((node) => {
      const input = node.querySelector("input");
      if (input) input.disabled = !compareCustom;
      node.classList.toggle("is-disabled", !compareCustom);
    });
  }

  function closePeriodMenus(exceptMenu = null) {
    [
      ["periodDropdownButton", "periodDropdownMenu"],
      ["compareDropdownButton", "compareDropdownMenu"],
    ].forEach(([buttonId, menuId]) => {
      const button = $(buttonId);
      const menu = $(menuId);
      if (!menu || menu === exceptMenu) return;
      menu.hidden = true;
      button?.setAttribute("aria-expanded", "false");
    });
  }

  function syncPeriodDropdowns() {
    const periodValue = $("periodo")?.value || "mes_atual";
    const compareValue = $("compararCom")?.value || "periodo_anterior";
    const periodLabel = $("periodDropdownLabel");
    const compareLabel = $("compareDropdownLabel");
    if (periodLabel) periodLabel.textContent = periodLabels[periodValue] || "Periodo";
    if (compareLabel) compareLabel.textContent = compareLabels[compareValue] || "Comparacao";
    qsa("[data-period-value]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.periodValue === periodValue);
    });
    qsa("[data-compare-value]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.compareValue === compareValue);
    });
  }

  function setSelectValue(selectId, value) {
    const select = $(selectId);
    if (!select) return;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function bindPeriodDropdowns() {
    const periodButton = $("periodDropdownButton");
    const periodMenu = $("periodDropdownMenu");
    const compareButton = $("compareDropdownButton");
    const compareMenu = $("compareDropdownMenu");

    periodButton?.addEventListener("click", () => {
      const willOpen = periodMenu.hidden;
      closePeriodMenus(periodMenu);
      periodMenu.hidden = !willOpen;
      periodButton.setAttribute("aria-expanded", willOpen ? "true" : "false");
    });

    compareButton?.addEventListener("click", () => {
      const willOpen = compareMenu.hidden;
      closePeriodMenus(compareMenu);
      compareMenu.hidden = !willOpen;
      compareButton.setAttribute("aria-expanded", willOpen ? "true" : "false");
    });

    qsa("[data-period-value]").forEach((button) => {
      button.addEventListener("click", () => {
        setSelectValue("periodo", button.dataset.periodValue);
        syncPeriodDropdowns();
        closePeriodMenus();
      });
    });

    qsa("[data-compare-value]").forEach((button) => {
      button.addEventListener("click", () => {
        setSelectValue("compararCom", button.dataset.compareValue);
        syncPeriodDropdowns();
        closePeriodMenus();
      });
    });

    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-rank-dropdown]")) return;
      closePeriodMenus();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePeriodMenus();
    });
  }

  function setDefaultLiveLimit() {
    const limitSelect = $("limite");
    if (!limitSelect) return;
    limitSelect.value = "10";
  }

  function exportCsv() {
    if (!state.lastPayload?.ranking?.length) return;
    const rows = state.lastPayload.ranking;
    const header = [
      "posicao",
      "variacao_posicao",
      "mlb",
      "titulo",
      "vendas_brutas",
      "vendas_brutas_anterior",
      "qtd_vendas",
      "qtd_vendas_anterior",
      "participacao",
      "ticket_medio",
      "posicao_anterior",
      "status",
    ];
    const csvRows = rows.map((row) => [
      row.position_current,
      row.position_movement ?? "novo",
      row.mlb,
      row.title,
      (row.gross_sales_cents || 0) / 100,
      (row.previous_gross_sales_cents || 0) / 100,
      row.units_sold || 0,
      row.previous_units_sold || 0,
      Number(row.revenue_share || 0) * 100,
      (row.average_ticket_cents || 0) / 100,
      row.previous_position || "",
      row.performance_status || "",
    ].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","));
    const blob = new Blob([[header.join(","), ...csvRows].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "ranking-anuncios-ml.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  function bind() {
    $("rankingFilters").addEventListener("submit", (event) => {
      event.preventDefault();
      loadRanking();
    });
    $("periodo").addEventListener("change", () => {
      updateCustomVisibility();
      syncPeriodDropdowns();
    });
    $("compararCom").addEventListener("change", () => {
      updateCustomVisibility();
      syncPeriodDropdowns();
    });
    $("dataInicio")?.addEventListener("change", () => {
      if (!isCompareCustomPeriod($("compararCom")?.value)) updateCustomVisibility();
    });
    $("dataFim")?.addEventListener("change", () => {
      if (!isCompareCustomPeriod($("compararCom")?.value)) updateCustomVisibility();
    });
    bindPeriodDropdowns();
    qsa("[data-order]").forEach((button) => {
      button.addEventListener("click", () => {
        state.ordenarPor = button.dataset.order || "faturamento";
        qsa("[data-order]").forEach((item) => item.classList.toggle("is-active", item === button));
      });
    });
    qsa("[data-filter-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const key = button.dataset.filterToggle;
        state.toggles[key] = state.toggles[key] === true ? null : true;
        button.classList.toggle("is-active", state.toggles[key] === true);
      });
    });
    $("btnRankingConfig")?.addEventListener("click", openRankingConfigModal);
    qsa("[data-rank-preset-limit]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!state.rankingCanManage) return;
        const limit = normalizeSnapshotLimit(button.dataset.rankPresetLimit, 30);
        state.rankingConfig.snapshot_limit = limit;
        hydrateRankingConfigUi();
      });
    });
    $("btnSaveRankingConfig")?.addEventListener("click", saveRankingConfig);
    $("btnExportRanking").addEventListener("click", exportCsv);
    $("rankingBody").addEventListener("click", (event) => {
      const button = event.target.closest("[data-watchlist-mlb]");
      if (!button || button.dataset.watchlistAdded === "1") return;
      openWatchlistModal(button.dataset.watchlistMlb);
    });
    $("rankWatchlistModal")?.addEventListener("click", (event) => {
      if (event.target.closest("[data-rank-watchlist-close]")) closeWatchlistModal();
    });
    $("rankConfigModal")?.addEventListener("click", (event) => {
      if (event.target.closest("[data-rank-config-close]")) closeRankingConfigModal();
    });
    $("btnConfirmRankWatchlist")?.addEventListener("click", confirmWatchlistAdd);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeRankingConfigModal();
    });
  }

  window.addEventListener("DOMContentLoaded", async () => {
    setDefaultLiveLimit();
    updateCustomVisibility();
    syncPeriodDropdowns();
    bind();
    await loadRankingConfig();
    loadRanking();
  });
})();
