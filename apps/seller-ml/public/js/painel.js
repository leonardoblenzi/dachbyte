"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const page = document.querySelector(".painel-page");
  const tabs = Array.from(document.querySelectorAll(".painel-finance-tab"));
  const SESSION_CACHE_KEY = "ml:painel:session-cache:v7";
  const OVERVIEW_TIMEOUT_MS = 45000;
  const INACTIVITY_TIMEOUT_MS = 45000;
  const FINANCE_TIMEOUT_MS = 70000;
  const INACTIVITY_WATCHDOG_MS = 20000;

  const state = {
    preset: "7d",
    loading: false,
    hasLoadedOnce: false,
    cacheByPreset: new Map(),
    inactivityByScope: new Map(),
    accountScope: null,
    accountScopeLoaded: false,
    requestSeq: 0,
    inactivityRequestSeq: 0,
    financeRequestSeq: 0,
    financeLoadingPreset: "",
    inactivityLoadingScope: "",
    inactivityWatchdogTimer: null,
    lastPayload: null,
    loadingTexts: [
      "Consolidando operacao, financeiro e Product Ads da conta ativa.",
      "Consultando pedidos, custos e reputacao...",
      "Atualizando o cockpit executivo da conta selecionada...",
      "Preparando indicadores e comparativos do periodo...",
    ],
    loadingTimer: null,
    loadingIndex: 0,
  };

  const fmtMoney = (value) =>
    new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(Number(value || 0));

  const fmtNum = (value) =>
    new Intl.NumberFormat("pt-BR").format(Number(value || 0));

  const fmtPct = (value, digits = 1) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return `${n.toLocaleString("pt-BR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}%`;
  };

  const fmtDecimal = (value, digits = 1) =>
    Number(value || 0).toLocaleString("pt-BR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });

  const fmtMoneyNoCents = (value) =>
    new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
      maximumFractionDigits: 0,
    }).format(Number(value || 0));

  const clampPct = (value) =>
    Math.max(0, Math.min(100, Number(value || 0)));

  const signedPrefix = (value) => (Number(value || 0) >= 0 ? "+" : "-");
  function formatCurrency(value) {
    const n = Number(value || 0);
    if (n >= 1000000) return `R$ ${fmtDecimal(n / 1000000, 1)}M`;
    if (n >= 1000) return `R$ ${fmtDecimal(n / 1000, 1)}k`;
    return fmtMoney(n);
  }

  function formatPercent(value, decimals = 1) {
    return fmtPct(Number(value || 0), decimals);
  }

  function getDeltaClass(value) {
    return Number(value || 0) >= 0 ? "delta-up" : "delta-down";
  }

  function getScoreColor(score) {
    const n = Number(score || 0);
    if (n <= 2.9) return "#C53030";
    if (n <= 5.9) return "#EF9F27";
    return "#2E7D32";
  }

  function getMarkerLeft(score) {
    return `${Math.min((Number(score || 0) / 10) * 100, 97)}%`;
  }

  function parseLocaleNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const normalized = String(value ?? "")
      .replace(/[^\d,.-]/g, "")
      .replace(/\./g, "")
      .replace(",", ".");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function setTone(id, tone) {
    const el = $(id);
    if (!el) return;
    if (tone) el.dataset.tone = tone;
    else el.removeAttribute("data-tone");
  }

  function firstDefinedNumber(...values) {
    for (const value of values) {
      if (value === undefined || value === null || value === "") continue;
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return 0;
  }

  function safeSection(label, fn) {
    try {
      return fn();
    } catch (error) {
      console.error(`[Painel] Falha ao renderizar ${label}:`, error);
      return null;
    }
  }

  function sourceState(payload, key) {
    return payload?.meta?.sources?.[key] || { available: true, error: null };
  }

  function clearUnavailableStates() {
    document.querySelectorAll('.is-source-unavailable').forEach((el) => {
      el.classList.remove('is-source-unavailable');
      el.removeAttribute('data-source-message');
    });
  }

  function markSourceUnavailable(ids = [], message = 'Fonte temporariamente indisponivel.') {
    ids.forEach((id) => {
      const el = $(id);
      if (!el) return;
      if (/value|main|revenue|sales|orders|margin|conversion|ticket|total/i.test(id)) {
        el.textContent = 'Indisponivel';
      }
      const surface = el.closest('.overview-kpi, .overview-mini-metric, .painel-metric-card, .painel-risk-card, .painel-ads-strip');
      if (surface) {
        surface.classList.add('is-source-unavailable');
        surface.dataset.sourceMessage = message;
      }
    });
  }

  function applySourceAvailability(payload = {}) {
    const orders = sourceState(payload, 'orders_current');
    const visits = sourceState(payload, 'visits_current');
    const ads = sourceState(payload, 'product_ads');
    const month = sourceState(payload, 'orders_month_current');
    const inactivityOrders = sourceState(payload, 'inactivity_orders');
    const activeItems = sourceState(payload, 'active_items');
    const reputation = sourceState(payload, 'reputation');

    if (orders.available === false) {
      markSourceUnavailable([
        'painel-kpi-revenue-value', 'painel-kpi-orders-value', 'painel-kpi-margin-value',
        'painel-summary-sales', 'painel-summary-revenue', 'painel-margin-pct', 'painel-ticket'
      ], orders.error || 'Vendas do periodo indisponiveis.');
      setText('painel-kpi-revenue-meta', 'Fonte de vendas indisponivel');
      setText('painel-kpi-orders-meta', 'Fonte de vendas indisponivel');
      setText('painel-kpi-margin-meta', 'Aguardando dados de vendas');
    }

    if (orders.available === false || visits.available === false) {
      markSourceUnavailable([
        'painel-kpi-conversion-value', 'painel-conversion-rate', 'painel-conversion-organic',
        'painel-conversion-ads', 'painel-conversion-visits'
      ], visits.error || orders.error || 'Conversao indisponivel no momento.');
      setText('painel-kpi-conversion-meta', 'Fonte de conversao indisponivel');
    }

    if (ads.available === false) {
      markSourceUnavailable([
        'painel-kpi-ads-value', 'painel-kpi-ads-cost-value', 'painel-ads-roas',
        'painel-ads-cost', 'painel-ads-revenue', 'painel-ads-units'
      ], ads.error || 'Product Ads indisponivel no momento.');
      setText('painel-kpi-ads-meta', 'Product Ads indisponivel');
      setText('painel-kpi-ads-cost-meta', 'Product Ads indisponivel');
    }

    if (month.available === false) {
      const rhythmCard = $('painel-rhythm-card');
      if (rhythmCard) {
        rhythmCard.classList.add('is-source-unavailable');
        rhythmCard.dataset.sourceMessage = month.error || 'Ritmo do mês indisponível.';
      }
      const slot = $('painel-rhythm-revenue');
      if (slot) slot.innerHTML = '<div class="painel-empty">Ritmo do mês indisponível no momento.</div>';
      setText('painel-rhythm-status', 'Indisponivel');
    }

    if (inactivityOrders.available === false || activeItems.available === false) {
      const card = $('painel-inactivity-card');
      if (card) {
        card.classList.add('is-source-unavailable');
        card.dataset.sourceMessage = inactivityOrders.error || activeItems.error || 'Inatividade indisponivel.';
      }
      setText('painel-inactivity-risk', 'Indisponivel');
    }

    if (reputation.available === false) {
      const card = $('painel-reputation-card');
      if (card) {
        card.classList.add('is-source-unavailable');
        card.dataset.sourceMessage = reputation.error || 'Reputacao indisponivel.';
      }
      setText('painel-reputation-status', 'Indisponivel');
    }

    if (payload?.meta?.partial) {
      setText('painel-sync', 'Atualizado com dados parciais');
    }
  }

  function ensureLocalLoadingOverlay() {
    let root = document.getElementById("painel-loading-fallback");
    if (root) return root;

    root = document.createElement("div");
    root.id = "painel-loading-fallback";
    root.hidden = true;
    root.setAttribute("aria-live", "polite");
    root.innerHTML = `
      <div data-role="backdrop"></div>
      <div data-role="panel">
        <div data-role="head">
          <span data-role="spinner" aria-hidden="true"></span>
          <strong>Atualizando Painel</strong>
          <span data-role="percent">...</span>
        </div>
        <div data-role="text">Consolidando os indicadores da conta...</div>
        <div data-role="track"><span data-role="bar"></span></div>
      </div>
    `;

    Object.assign(root.style, {
      position: "fixed", inset: "0", zIndex: "2147483000",
      display: "grid", placeItems: "center", padding: "20px",
      fontFamily: "inherit"
    });
    const backdrop = root.querySelector('[data-role="backdrop"]');
    Object.assign(backdrop.style, {
      position: "absolute", inset: "0", background: "rgba(7, 15, 28, .34)",
      backdropFilter: "blur(3px)"
    });
    const panel = root.querySelector('[data-role="panel"]');
    Object.assign(panel.style, {
      position: "relative", width: "min(460px, calc(100vw - 36px))",
      padding: "18px 20px", borderRadius: "18px",
      border: "1px solid rgba(148,163,184,.22)",
      background: "var(--ml-surface, #fff)", color: "var(--ml-ink, #17203b)",
      boxShadow: "0 24px 70px rgba(15,23,42,.20)"
    });
    const head = root.querySelector('[data-role="head"]');
    Object.assign(head.style, { display: "flex", alignItems: "center", gap: "10px" });
    const spinner = root.querySelector('[data-role="spinner"]');
    Object.assign(spinner.style, {
      width: "17px", height: "17px", borderRadius: "999px",
      border: "2px solid rgba(96,165,250,.25)", borderTopColor: "#3b82f6",
      animation: "painelFallbackSpin .8s linear infinite"
    });
    const percent = root.querySelector('[data-role="percent"]');
    Object.assign(percent.style, { marginLeft: "auto", color: "#3b82f6", fontSize: "12px", fontWeight: "700" });
    const text = root.querySelector('[data-role="text"]');
    Object.assign(text.style, { marginTop: "11px", color: "var(--ml-muted, #64748b)", fontSize: "12px", lineHeight: "1.5" });
    const track = root.querySelector('[data-role="track"]');
    Object.assign(track.style, { marginTop: "13px", height: "4px", overflow: "hidden", borderRadius: "999px", background: "rgba(96,165,250,.15)" });
    const bar = root.querySelector('[data-role="bar"]');
    Object.assign(bar.style, { display: "block", width: "68%", height: "100%", borderRadius: "inherit", background: "#3b82f6" });

    if (!document.getElementById("painel-loading-fallback-style")) {
      const style = document.createElement("style");
      style.id = "painel-loading-fallback-style";
      style.textContent = `@keyframes painelFallbackSpin{to{transform:rotate(360deg)}}`;
      document.head.appendChild(style);
    }
    document.body.appendChild(root);
    return root;
  }

  function showLoadingOverlay(message) {
    if (window.MLLoadingOverlay?.show) {
      window.MLLoadingOverlay.show({
        context: "Painel",
        label: "Atualizando dados",
        texts: state.loadingTexts,
        message: message || state.loadingTexts[0],
        initialProgress: 18,
        maxProgress: 92,
      });
      return;
    }

    const fallback = ensureLocalLoadingOverlay();
    fallback.hidden = false;
    fallback.style.display = "grid";
    const text = fallback.querySelector('[data-role="text"]');
    if (text) text.textContent = message || state.loadingTexts[0];
  }

  function updateLoadingOverlay(message) {
    if (window.MLLoadingOverlay?.update) {
      window.MLLoadingOverlay.update({ message });
      return;
    }
    const fallback = document.getElementById("painel-loading-fallback");
    const text = fallback?.querySelector('[data-role="text"]');
    if (text) text.textContent = message || state.loadingTexts[0];
  }

  function hideLoadingOverlay() {
    if (window.MLLoadingOverlay?.hide) window.MLLoadingOverlay.hide();
    const fallback = document.getElementById("painel-loading-fallback");
    if (fallback) {
      fallback.hidden = true;
      fallback.style.display = "none";
    }
  }

  function pctDelta(current, previous) {
    const prev = Number(previous || 0);
    if (prev <= 0) return null;
    return ((Number(current || 0) - prev) / prev) * 100;
  }

  function getComparisonInlineLabel() {
    const labels = {
      today: "vs dia anterior",
      "7d": "vs 7 dias anteriores",
      "14d": "vs 14 dias anteriores",
      "30d": "vs 30 dias anteriores",
    };
    return labels[state.preset] || "vs período anterior equivalente";
  }

  function formatDeltaPct(current, previous, { inverse = false, digits = 0 } = {}) {
    const delta = pctDelta(current, previous);
    if (delta == null) {
      return { text: "Sem comparativo", tone: "neutral", value: 0 };
    }
    const good = inverse ? delta <= 0 : delta >= 0;
    return {
      value: delta,
      tone: good ? "positive" : "negative",
      text: `${delta >= 0 ? "+" : "-"}${fmtPct(Math.abs(delta), digits)} ${getComparisonInlineLabel()}`,
    };
  }

  function setDeltaMeta(id, current, previous, options = {}) {
    const result = formatDeltaPct(current, previous, options);
    setText(id, result.text);
    setTone(id, result.tone);
    return result;
  }

  function getComparisonPeriodLabel() {
    const labels = {
      today: "Dia anterior",
      "7d": "7 dias anteriores",
      "14d": "14 dias anteriores",
      "30d": "30 dias anteriores",
    };
    return labels[state.preset] || "Período anterior equivalente";
  }

  function renderComparison(
    id,
    {
      label,
      current = 0,
      previous = 0,
      format = (value) => String(value ?? ""),
      mode = "percent",
      digits = 1,
      inverse = false,
      hasBase = true,
      showDelta = true,
    } = {},
  ) {
    const el = $(id);
    if (!el) return;

    const currentValue = Number(current || 0);
    const previousValue = Number(previous || 0);
    const canCompare = hasBase && Number.isFinite(previousValue) && (mode === "points" || previousValue !== 0);
    const rawDelta = mode === "points"
      ? currentValue - previousValue
      : canCompare
        ? ((currentValue - previousValue) / Math.abs(previousValue)) * 100
        : 0;
    const good = inverse ? rawDelta <= 0 : rawDelta >= 0;
    const tone = !canCompare ? "neutral" : good ? "positive" : "negative";
    const suffix = mode === "points" ? " p.p." : "%";
    const deltaText = canCompare
      ? `${rawDelta >= 0 ? "+" : "-"}${fmtDecimal(Math.abs(rawDelta), digits)}${suffix}`
      : "Sem base";

    const previousPeriodLabel = getComparisonPeriodLabel();
    el.classList.add("painel-comparison");
    el.setAttribute("tabindex", "0");
    el.setAttribute(
      "aria-label",
      `${label}: ${format(currentValue)}. ${previousPeriodLabel}: ${format(previousValue)}. Variação: ${deltaText}.`,
    );
    el.innerHTML = `
      <span class="painel-comparison__value">${format(currentValue)}</span>
      ${showDelta ? `<span class="painel-comparison__delta" data-tone="${tone}">${canCompare ? (rawDelta >= 0 ? "&uarr;" : "&darr;") : ""} ${deltaText}</span>` : ""}
      <span class="painel-comparison__box" role="tooltip">
        <span class="painel-comparison__title">Comparativo do período</span>
        <span class="painel-comparison__row"><span>${label} atual</span><b>${format(currentValue)}</b></span>
        <span class="painel-comparison__row"><span>${previousPeriodLabel}</span><b>${format(previousValue)}</b></span>
        <span class="painel-comparison__row"><span>Variação</span><b data-tone="${tone}">${deltaText}</b></span>
      </span>
    `;
  }

  function inactivitySeverity(inactivity = {}) {
    const inactive = Number(inactivity.inactive || 0);
    const total = Number(inactivity.total || 0);
    const pct = total > 0 ? (inactive / total) * 100 : 0;
    const score = parseLocaleNumber(inactivity.points ?? inactivity.score ?? inactivity.points_label ?? 0);
    if (pct >= 70 || score < 3) return { tone: "critical", label: "Risco alto de inatividade", pct };
    if (pct >= 35 || score < 6) return { tone: "warning", label: "Risco moderado de inatividade", pct };
    return { tone: "positive", label: "Saude operacional boa", pct };
  }

  function marginTone(value) {
    const n = Number(value || 0);
    if (n >= 60) return "positive";
    if (n >= 35) return "warning";
    return "critical";
  }

  function clearInactivityWatchdog() {
    if (state.inactivityWatchdogTimer) {
      clearTimeout(state.inactivityWatchdogTimer);
      state.inactivityWatchdogTimer = null;
    }
  }

  function setInactivityLoading(active, text = "Atualizando leitura...") {
    const card = $("painel-inactivity-card");
    const loading = $("painel-inactivity-loading");
    const message = loading?.querySelector(".painel-inactivity-loading__text");

    if (!active) {
      clearInactivityWatchdog();
    }

    if (card) {
      card.classList.toggle("is-background-loading", !!active);
    }

    if (loading) {
      loading.hidden = !active;
      loading.style.display = active ? "grid" : "none";
      loading.setAttribute("aria-hidden", active ? "false" : "true");
    }

    if (message) {
      message.textContent = text;
    }
  }

  function setInactivityStatus(text) {
    const loading = $("painel-inactivity-loading");
    const message = loading?.querySelector(".painel-inactivity-loading__text");
    if (message) {
      message.textContent = text;
    }
  }

  function renderInactivity(inactivity = {}) {
    const severity = inactivitySeverity(inactivity);
    const inactive = Number(inactivity.inactive || 0);
    const total = Number(inactivity.total || 0);
    const score = parseLocaleNumber(inactivity.points_label ?? inactivity.points ?? inactivity.score ?? 0);
    const inactivePct = total > 0 ? (inactive / total) * 100 : 0;
    const activePct = Math.max(0, 100 - inactivePct);
    const scoreColor = getScoreColor(score);
    const marker = $("painel-inactivity-marker");
    const scoreEl = $("painel-inactivity-score");
    const inactivePctEl = $("painel-inactive-percent");
    const active = Math.max(0, total - inactive);
    const banner = $("painel-health-banner");
    const card = $("painel-inactivity-card");
    const statusLabel =
      severity.tone === "critical"
        ? "Critico"
        : severity.tone === "warning"
          ? "Atencao"
          : "Saudavel";

    setText("painel-inactivity-score", fmtDecimal(score, 1));
    if (scoreEl) scoreEl.style.color = scoreColor;
    if (marker) {
      marker.style.left = getMarkerLeft(score);
      marker.style.background = scoreColor;
    }
    setText(
      "painel-inactive-items",
      inactivity.inactive == null ? "--" : fmtNum(inactivity.inactive),
    );
    setText("painel-active-items", fmtNum(active));
    setText("painel-inactivity-risk", statusLabel);
    setTone("painel-inactivity-risk", severity.tone);
    setText(
      "painel-inactive-percent",
      `⚠ ${fmtNum(inactive)} de ${fmtNum(total)} anuncios sem venda nos ultimos 30 dias (${formatPercent(inactivePct, 1)})`,
    );
    if (inactivePctEl) {
      inactivePctEl.style.color =
        inactivePct > 80 ? "#C53030" : inactivePct > 50 ? "#EF9F27" : "#2E7D32";
    }
    setText(
      "painel-active-percent",
      `Apenas ${formatPercent(activePct, 1)} (${fmtNum(Math.max(0, total - inactive))}) anuncios venderam no periodo`,
    );
    setText("painel-inactive-percent", formatPercent(inactivePct, 1));
    if (inactivePctEl) {
      inactivePctEl.style.color =
        inactivePct > 80 ? "#a32d2d" : inactivePct > 50 ? "#8a5b0b" : "#2f6b11";
    }
    setText(
      "painel-active-percent",
      `${formatPercent(activePct, 1)} (${fmtNum(active)}) anuncios venderam no periodo`,
    );
    if (card) card.dataset.tone = severity.tone;
    if (banner) {
      if (severity.tone === "positive" || total <= 0) {
        banner.hidden = true;
      } else {
        banner.hidden = false;
        banner.dataset.tone = severity.tone;
        setText(
          "painel-health-banner-text",
          `Saude da conta ${statusLabel.toLowerCase()} · ${fmtNum(inactive)} anuncios sem venda`,
        );
      }
    }

    const inactivityGauge = $("painel-inactivity-gauge");
    if (inactivityGauge) {
      const inactivityScore =
        typeof inactivity.score === "number" &&
        Number.isFinite(inactivity.score)
          ? inactivity.score
          : 0;

      inactivityGauge.style.setProperty(
        "--inactivity-angle",
        `${Math.max(8, inactivityScore * 180)}deg`,
      );
    }
  }

  function renderRhythmMetric(slotId, metric = {}, rhythm = {}, type = "revenue") {
    const slot = $(slotId);
    if (!slot) return;

    const status = String(metric?.status || "no_base");
    const isAhead = status === "ahead";
    const hasBase = status !== "no_base";
    const day = Number(rhythm?.reference_day || 1);
    const daysInMonth = Number(rhythm?.days_in_month || 30);
    const difference = Number(metric?.difference || 0);
    const projectionDelta = Number(metric?.projection_delta || 0);
    const current = Number(metric?.current || 0);
    const expectedToday = Number(metric?.expected_today || 0);
    const actualPct = clampPct(metric?.actual_pct || 0);
    const requiredPct = clampPct(metric?.required_pct || 0);
    const badgeTone = !hasBase ? "neutral" : isAhead ? "positive" : "critical";
    const expectedTone = current >= expectedToday ? "positive" : "negative";
    const card = $("painel-rhythm-card");
    const statusEl = $("painel-rhythm-status");

    const labelPrefix = isAhead ? "Acima" : "Abaixo";
    const valueText =
      type === "sales"
        ? `${signedPrefix(difference)} ${fmtNum(Math.abs(Math.round(difference)))} vendas`
        : `${signedPrefix(difference)} ${fmtMoneyNoCents(Math.abs(difference))}`;
    const captionText = hasBase
      ? `${labelPrefix} do ritmo necessário para igualar o mês passado (dia ${day} de ${daysInMonth})`
      : `Sem mês anterior para comparar (dia ${day} de ${daysInMonth})`;
    const projectionText =
      type === "sales"
        ? fmtNum(Math.round(Number(metric?.projection || 0)))
        : fmtMoneyNoCents(metric?.projection || 0);
    const deltaText =
      type === "sales"
        ? `${projectionDelta >= 0 ? "+" : "-"}${fmtNum(
            Math.abs(Math.round(projectionDelta)),
          )} vs mês passado`
        : `${projectionDelta >= 0 ? "+" : "-"} ${fmtMoneyNoCents(
            Math.abs(projectionDelta),
          )} vs mês passado`;
    if (card && type === "revenue") card.dataset.tone = badgeTone;
    if (statusEl && type === "revenue") {
      statusEl.dataset.tone = badgeTone;
      statusEl.textContent = !hasBase ? "Sem base" : isAhead ? "Acima" : "Abaixo";
    }

    slot.dataset.status = status;
    slot.innerHTML = `
      <strong class="painel-rhythm-main-value">${hasBase ? valueText : "--"}</strong>
      <span class="painel-rhythm-caption">${captionText}</span>

      <div class="painel-rhythm-progress-labels">
        <span>Realizado</span>
        <span>Ritmo p/ igualar mês passado</span>
      </div>
      <div class="painel-rhythm-track">
        <span class="painel-rhythm-fill" style="width:${actualPct}%"></span>
        <span class="painel-rhythm-marker" style="left:${requiredPct}%"></span>
      </div>
      <div class="painel-rhythm-progress-values">
        <span>${fmtPct(actualPct, 2)}</span>
        <span>${fmtPct(requiredPct, 2)}</span>
      </div>

      <div class="painel-rhythm-cells">
        <article>
          <span>${type === "sales" ? "Realizadas" : "Realizado"}</span>
          <strong>${type === "sales" ? fmtNum(metric?.current || 0) : fmtMoneyNoCents(metric?.current || 0)}</strong>
        </article>
        <article data-tone="${expectedTone}">
          <span>Esperado até hoje</span>
          <strong>${type === "sales" ? fmtNum(Math.round(metric?.expected_today || 0)) : fmtMoneyNoCents(metric?.expected_today || 0)}</strong>
        </article>
        <article>
          <span>Mês passado</span>
          <strong>${type === "sales" ? fmtNum(metric?.previous || 0) : fmtMoneyNoCents(metric?.previous || 0)}</strong>
        </article>
      </div>

      <div class="painel-rhythm-projection">
        <div>
          <span>Projeção do mês (ritmo atual)</span>
          <strong>${projectionText}</strong>
        </div>
        <strong>${hasBase ? deltaText : "--"}</strong>
      </div>
    `;
  }

  function renderRhythm(rhythm = {}) {
    renderRhythmMetric(
      "painel-rhythm-revenue",
      rhythm?.revenue || {},
      rhythm,
      "revenue",
    );
    renderRhythmMetric(
      "painel-rhythm-sales",
      rhythm?.sales || {},
      rhythm,
      "sales",
    );
  }

  function resetUnavailable() {
    setInactivityLoading(false);

    [
      "painel-account-name",
      "painel-marketplace-label",
      "painel-account-status-label",
      "painel-plan-label",
      "painel-plataforma",
      "painel-coupon-costs",
      "painel-product-taxes",
      "painel-ticket",
      "painel-plataforma-pct",
      "painel-coupon-costs-pct",
      "painel-product-taxes-pct",
      "painel-margin-pct",
      "painel-finance-note",
      "painel-kpi-revenue-value",
      "painel-kpi-revenue-meta",
      "painel-kpi-orders-value",
      "painel-kpi-orders-meta",
      "painel-kpi-conversion-value",
      "painel-kpi-conversion-meta",
      "painel-kpi-margin-value",
      "painel-kpi-margin-meta",
      "painel-kpi-ads-value",
      "painel-kpi-ads-meta",
      "painel-kpi-ads-cost-value",
      "painel-kpi-ads-cost-meta",
      "painel-kpi-stock-value",
      "painel-kpi-stock-meta",
      "painel-inactivity-score",
      "painel-inactive-items",
      "painel-active-percent",
      "painel-inactivity-risk",
      "painel-inactive-percent",
      "painel-summary-sales",
      "painel-summary-cancelled",
      "painel-summary-revenue",
      "painel-ads-roas",
      "painel-ads-roas-delta",
      "painel-ads-roas-min",
      "painel-ads-cost",
      "painel-ads-revenue",
      "painel-ads-units",
      "painel-ads-prints",
      "painel-ads-ctr",
      "painel-conversion-rate",
      "painel-conversion-organic",
      "painel-conversion-ads",
      "painel-conversion-visits",
    ].forEach((id) => setText(id, "--"));

    setText("painel-summary-period", "Indisponivel");
    setText(
      "painel-score-helper",
      "Os dados do Painel nao puderam ser consolidados agora.",
    );
    setText(
      "painel-finance-note",
      "Preencha custo e aliquota nas telas financeiras do Mercado Livre para completar este indicador.",
    );
    renderRhythm({});

    renderImpactList({ seller: { metric_cards: {} } });
    const prioritySlot = $("painel-priority-list");
    if (prioritySlot) {
      prioritySlot.innerHTML = `<div class="painel-empty">Nao foi possivel calcular prioridades agora.</div>`;
    }
  }

  function setLoading(active, message) {
    state.loading = !!active;

    if (page) {
      page.classList.toggle("is-loading", state.loading);
      page.classList.toggle(
        "is-refreshing",
        state.loading && state.hasLoadedOnce,
      );
    }

    if (state.loading) {
      const firstMessage = message || state.loadingTexts[0];
      state.loadingIndex = 0;

      showLoadingOverlay(firstMessage);

      clearInterval(state.loadingTimer);
      state.loadingTimer = setInterval(() => {
        state.loadingIndex =
          (state.loadingIndex + 1) % state.loadingTexts.length;
        updateLoadingOverlay(state.loadingTexts[state.loadingIndex]);
      }, 2400);
      return;
    }

    clearInterval(state.loadingTimer);
    state.loadingTimer = null;
    hideLoadingOverlay();
  }

  function setActivePreset(preset) {
    state.preset = preset;
    tabs.forEach((tab) =>
      tab.classList.toggle("is-active", tab.dataset.preset === preset),
    );
  }

  function readSessionCacheStore() {
    try {
      const raw = window.sessionStorage?.getItem(SESSION_CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function writeSessionCacheStore(store) {
    try {
      window.sessionStorage?.setItem(
        SESSION_CACHE_KEY,
        JSON.stringify(store || {}),
      );
    } catch (_error) {
      // noop
    }
  }

  function makeScopedPresetKey(scope, preset) {
    return `${String(scope || "scope-unknown")}::${String(preset || "").trim()}`;
  }

  function getPayloadScope(payload) {
    return String(
      payload?.account?.key ||
        payload?.account?.seller_id ||
        payload?.account?.label ||
        state.accountScope ||
        "scope-unknown",
    ).trim();
  }

  async function ensureAccountScope() {
    if (state.accountScopeLoaded) return state.accountScope;

    try {
      const accountData = await fetchJson("/api/account/current", 8000);
      state.accountScope = String(
        accountData?.accountKey ||
          accountData?.current?.key ||
          accountData?.current?.id ||
          accountData?.current?.label ||
          "scope-unknown",
      ).trim();
    } catch (_error) {
      state.accountScope = "scope-unknown";
    }

    state.accountScopeLoaded = true;

    const store = readSessionCacheStore();
    Object.entries(store).forEach(([key, entry]) => {
      if (!key.startsWith(`${state.accountScope}::`)) return;
      if (Date.now() > Number(entry?.expiresAt || 0)) return;

      const preset = key.split("::").slice(1).join("::");
      if (!preset) return;

      state.cacheByPreset.set(preset, {
        payload: entry.payload,
        expiresAt: entry.expiresAt,
      });
    });

    return state.accountScope;
  }

  function persistPresetCacheToSession(scope, preset, payload, expiresAt) {
    const store = readSessionCacheStore();
    store[makeScopedPresetKey(scope, preset)] = {
      payload,
      expiresAt,
    };
    writeSessionCacheStore(store);
  }

  function clearPresetCache(preset) {
    state.cacheByPreset.delete(String(preset || "").trim());
    if (!state.accountScopeLoaded) return;

    const store = readSessionCacheStore();
    delete store[makeScopedPresetKey(state.accountScope, preset)];
    writeSessionCacheStore(store);
  }

  function getCachedPresetPayload(preset) {
    const cached = state.cacheByPreset.get(String(preset || "").trim());
    if (!cached) return null;

    if (Date.now() > Number(cached.expiresAt || 0)) {
      state.cacheByPreset.delete(String(preset || "").trim());
      return null;
    }

    return cached.payload || null;
  }

  function setCachedPresetPayload(preset, payload) {
    const ttlSec = Number(payload?.meta?.cache_ttl_sec || 0);
    const ttlMs = ttlSec > 0 ? ttlSec * 1000 : 1000 * 60 * 10;
    const expiresAt = Date.now() + ttlMs;

    state.cacheByPreset.set(String(preset || "").trim(), {
      payload,
      expiresAt,
    });

    const scope = getPayloadScope(payload);
    if (scope) {
      persistPresetCacheToSession(scope, preset, payload, expiresAt);
    }
  }

  function setScopedInactivityCache(scope, inactivity) {
    const safeScope = String(scope || "").trim();
    if (!safeScope || !inactivity || typeof inactivity !== "object") return;

    state.inactivityByScope.set(safeScope, inactivity);

    state.cacheByPreset.forEach((entry, preset) => {
      const payload = entry?.payload;
      if (!payload || getPayloadScope(payload) !== safeScope) return;

      const nextPayload = { ...payload, inactivity: { ...inactivity } };
      state.cacheByPreset.set(preset, { ...entry, payload: nextPayload });
    });

    const store = readSessionCacheStore();
    let changed = false;

    Object.entries(store).forEach(([key, entry]) => {
      if (!key.startsWith(`${safeScope}::`) || !entry?.payload) return;

      store[key] = {
        ...entry,
        payload: {
          ...entry.payload,
          inactivity: { ...inactivity },
        },
      };
      changed = true;
    });

    if (changed) writeSessionCacheStore(store);
  }

  async function fetchJson(path, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(mlUrl(path), {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });

      const rawText = await response.text();
      let data = null;

      if (rawText) {
        try {
          data = JSON.parse(rawText);
        } catch (_error) {
          if (!response.ok) {
            throw new Error(`Falha ao carregar ${path}`);
          }
          throw new Error(`Resposta invalida ao carregar ${path}`);
        }
      }

      if (!response.ok) {
        throw new Error(data?.error || `Falha ao carregar ${path}`);
      }

      return data || {};
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function renderImpactList(reputation = {}) {
    const cards = reputation?.seller?.metric_cards || {};
    const mapping = [
      { key: "claims", label: "Reclamacoes", tone: "claims" },
      { key: "mediations", label: "Em mediacao", tone: "mediations" },
      { key: "cancellations", label: "Cancelamentos", tone: "cancellations" },
      { key: "delayed", label: "Atrasos no envio", tone: "delayed" },
    ];
    const total = mapping.reduce((sum, { key }) => {
      const item = cards[key] || {};
      return sum + Number(item.count || 0);
    }, 0);
    const statusTone = total > 0 ? "warning" : "positive";
    const statusEl = $("painel-reputation-status");
    const card = $("painel-reputation-card");

    const html = mapping
      .map(({ key, label, tone }) => {
        const item = cards[key] || {};
        const count = Number(item.count || 0);
        const valueTone = count > 0 ? (key === "claims" ? "critical" : "warning") : "positive";
        return `
          <div class="painel-reputation-item" data-tone="${tone}">
            <span>${label}</span>
            <strong class="painel-reputation-value" data-tone="${valueTone}">${fmtNum(count)} · ${fmtPct(item.value || 0, 2)}</strong>
          </div>
        `;
      })
      .join("");

    setText("painel-reputation-total", fmtNum(total));
    if (statusEl) {
      statusEl.dataset.tone = statusTone;
      statusEl.textContent = total > 0 ? "Atencao" : "Estavel";
    }
    if (card) card.dataset.tone = statusTone;

    const slot = $("painel-impact-list");
    if (slot) {
      slot.innerHTML =
        html ||
        `<div class="painel-empty">Sem impactos consolidados no momento.</div>`;
    }
  }

  function setDeltaTone(id, value, text) {
    const el = $(id);
    if (!el) return;
    const n = Number(value || 0);
    el.dataset.tone = n >= 0 ? "positive" : "negative";
    el.textContent = text;
  }

  function formatAdsValue(value, type) {
    const n = Number(value || 0);
    if (type === "currency") {
      if (n >= 1000000) return `R$ ${fmtDecimal(n / 1000000, 1)}M`;
      if (n >= 1000) return `R$ ${fmtDecimal(n / 1000, 1)}k`;
      return fmtMoney(n);
    }
    if (type === "number") {
      if (n >= 1000000) return `${fmtDecimal(n / 1000000, 2)}M`;
      if (n >= 1000) return `${fmtDecimal(n / 1000, 1)}k`;
      return fmtNum(n);
    }
    if (type === "roas") return `${fmtDecimal(n, 2)}x`;
    if (type === "percent") return fmtPct(n, 2);
    return String(value ?? "");
  }

  function renderPointDelta(id, current, previous, suffix = "pp") {
    const delta = Number(current || 0) - Number(previous || 0);
    setDeltaTone(
      id,
      delta,
      `${delta >= 0 ? "+" : "-"}${fmtDecimal(Math.abs(delta), 1)}${suffix}`,
    );
  }

  function renderAds(ads = {}) {
    const previous = ads?.previous || {};
    const roasMinCell = $("painel-ads-roas-min-cell");
    const roas = Number(ads.roas || 0);
    const roasMin = Number(ads.roas_min || 0);
    const ctr = Number(ads.ctr || 0);

    setText("painel-ads-roas", formatAdsValue(roas, "roas"));
    renderPointDelta(
      "painel-ads-roas-delta",
      roas,
      previous.roas || 0,
      `x ${getComparisonInlineLabel()}`,
    );

    if (roasMinCell) roasMinCell.classList.toggle("is-alert", roasMin > 0 && roasMin < 3);
    setText("painel-ads-roas-min", formatAdsValue(roasMin, "roas"));
    if (roasMin > 0 && roasMin < 3) {
      if (roasMinCell) roasMinCell.dataset.tone = "warning";
    } else {
      if (roasMinCell) roasMinCell.removeAttribute("data-tone");
    }

    setText("painel-ads-cost", formatAdsValue(ads.cost, "currency"));
    setText("painel-ads-revenue", formatAdsValue(ads.amount, "currency"));
    setText("painel-ads-units", fmtNum(ads.units || 0));

    setText("painel-ads-prints", formatAdsValue(ads.prints, "number"));
    setText("painel-ads-ctr", formatAdsValue(ctr, "percent"));
  }

  async function renderStockRiskKpi() {
    const card = $("painel-kpi-stock-card");
    try {
      const data = await fetchJson("/api/estoque/alerta/risk-kpi", 12000);
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const total = Number(data?.total ?? rows.length ?? 0);
      const first = rows[0] || null;
      setText("painel-kpi-stock-value", fmtNum(total));
      if (first) {
        const sku = first.sku || first.mlb || "produto";
        const rupture = first.stockout_date
          ? `ruptura ${String(first.stockout_date).slice(0, 10).split("-").reverse().join("/")}`
          : "sem data";
        setText(
          "painel-kpi-stock-meta",
          `${sku}: ${fmtNum(first.current_stock || 0)} un. • ${rupture}`,
        );
      } else {
        setText("painel-kpi-stock-meta", "Sem risco salvo no monitoramento");
      }
      setTone("painel-kpi-stock-card", total > 0 ? "warning" : "positive");
    } catch (_error) {
      setText("painel-kpi-stock-value", "--");
      setText("painel-kpi-stock-meta", "Atualize a tela Anuncios > Estoque");
      if (card) card.dataset.tone = "neutral";
    }
  }

  function renderConversion(conversion = {}) {
    const totalVisits = Number(conversion?.total_visits_periodo || 0);
    const rate = Number(conversion?.conversao_atual || 0);

    setText("painel-conversion-rate", fmtPct(rate, 2));

    const organicRate = Number(conversion?.organic_conversion || 0);
    const adsRate = Number(conversion?.ads_conversion || 0);

    setText("painel-conversion-organic", fmtPct(organicRate, 2));
    setText("painel-conversion-ads", fmtPct(adsRate, 2));
    setText("painel-conversion-visits", fmtNum(totalVisits));
  }

  function renderPerformanceComparisons({ sales = {}, finance = {}, conversion = {}, ads = {} } = {}) {
    const currentSales = sales?.current || {};
    const previousSales = sales?.previous || {};
    const previousFinance = finance?.previous || {};
    const previousAds = ads?.previous || {};
    const hasFinanceBase = finance?.available === true && previousFinance?.available === true;
    const hasConversionBase = Number(conversion.visitas_periodo_anterior || 0) > 0;
    const hasAdsBase = [
      previousAds.cost,
      previousAds.amount,
      previousAds.units,
      previousAds.prints,
      previousAds.clicks,
    ].some((value) => Number(value || 0) > 0);

    const compare = (id, options) => renderComparison(id, options);
    compare("painel-summary-sales", {
      label: "Vendas",
      current: currentSales.orders,
      previous: previousSales.orders,
      format: (value) => fmtNum(value),
      showDelta: false,
    });
    compare("painel-summary-revenue", {
      label: "Faturamento",
      current: currentSales.revenue,
      previous: previousSales.revenue,
      format: (value) => fmtMoney(value),
    });
    compare("painel-summary-cancelled", {
      label: "Cancelamentos",
      current: currentSales.cancelled,
      previous: previousSales.cancelled,
      format: (value) => fmtNum(value),
      inverse: true,
    });
    compare("painel-ticket", {
      label: "Ticket medio",
      current: finance.ticket,
      previous: previousFinance.ticket,
      format: (value) => fmtMoney(value),
      hasBase: hasFinanceBase,
    });
    compare("painel-conversion-rate", {
      label: "Conversao geral",
      current: conversion.conversao_atual,
      previous: conversion.conversao_periodo_anterior,
      format: (value) => fmtPct(value, 2),
      mode: "points",
      digits: 2,
      hasBase: hasConversionBase,
    });
    compare("painel-conversion-visits", {
      label: "Visitas totais",
      current: conversion.total_visits_periodo,
      previous: conversion.visitas_periodo_anterior,
      format: (value) => fmtNum(value),
      hasBase: hasConversionBase,
    });
    compare("painel-conversion-organic", {
      label: "Conversao organica",
      current: conversion.organic_conversion,
      previous: conversion.organic_previous_conversion,
      format: (value) => fmtPct(value, 2),
      mode: "points",
      digits: 2,
      hasBase: hasConversionBase,
    });
    compare("painel-conversion-ads", {
      label: "Conversao paga",
      current: conversion.ads_conversion,
      previous: conversion.ads_previous_conversion,
      format: (value) => fmtPct(value, 2),
      mode: "points",
      digits: 2,
      hasBase: hasConversionBase,
    });

    compare("painel-margin-pct", {
      label: "Margem",
      current: finance.margin_pct,
      previous: previousFinance.margin_pct,
      format: (value) => fmtPct(value, 1),
      mode: "points",
      hasBase: hasFinanceBase,
      showDelta: false,
    });
    compare("painel-plataforma", {
      label: "Custo de plataforma",
      current: finance.plataforma,
      previous: previousFinance.plataforma,
      format: (value) => fmtMoney(value),
      inverse: true,
      hasBase: hasFinanceBase,
    });
    compare("painel-plataforma-pct", {
      label: "Plataforma sobre faturamento",
      current: finance.plataforma_pct,
      previous: previousFinance.plataforma_pct,
      format: (value) => fmtPct(value, 1),
      mode: "points",
      inverse: true,
      hasBase: hasFinanceBase,
    });
    compare("painel-coupon-costs", {
      label: "Cupons do vendedor",
      current: finance.coupon_cost,
      previous: previousFinance.coupon_cost,
      format: (value) => fmtMoney(value),
      inverse: true,
      hasBase: hasFinanceBase,
    });
    compare("painel-coupon-costs-pct", {
      label: "Cupons sobre faturamento",
      current: finance.coupon_cost_pct,
      previous: previousFinance.coupon_cost_pct,
      format: (value) => fmtPct(value, 1),
      mode: "points",
      inverse: true,
      hasBase: hasFinanceBase,
    });
    compare("painel-product-taxes", {
      label: "Produto e impostos",
      current: finance.product_and_taxes,
      previous: previousFinance.product_and_taxes,
      format: (value) => Number(value || 0) > 0 ? fmtMoney(value) : "Nao informado",
      inverse: true,
      hasBase: hasFinanceBase && (Number(finance.product_and_taxes || 0) > 0 || Number(previousFinance.product_and_taxes || 0) > 0),
    });
    compare("painel-product-taxes-pct", {
      label: "Produto e impostos sobre faturamento",
      current: finance.product_and_taxes_pct,
      previous: previousFinance.product_and_taxes_pct,
      format: (value) => Number(finance.product_and_taxes || 0) > 0 || Number(previousFinance.product_and_taxes || 0) > 0 ? fmtPct(value, 1) : "--",
      mode: "points",
      inverse: true,
      hasBase: hasFinanceBase && (Number(finance.product_and_taxes || 0) > 0 || Number(previousFinance.product_and_taxes || 0) > 0),
    });

    compare("painel-ads-roas", {
      label: "ROAS medio",
      current: ads.roas,
      previous: previousAds.roas,
      format: (value) => formatAdsValue(value, "roas"),
      mode: "points",
      showDelta: false,
      hasBase: hasAdsBase,
    });
    compare("painel-ads-cost", {
      label: "Investimento",
      current: ads.cost,
      previous: previousAds.cost,
      format: (value) => formatAdsValue(value, "currency"),
      inverse: true,
      hasBase: hasAdsBase,
    });
    compare("painel-ads-revenue", {
      label: "Receita via ADS",
      current: ads.amount,
      previous: previousAds.amount,
      format: (value) => formatAdsValue(value, "currency"),
      hasBase: hasAdsBase,
    });
    compare("painel-ads-units", {
      label: "Vendas via ADS",
      current: ads.units,
      previous: previousAds.units,
      format: (value) => fmtNum(value),
      hasBase: hasAdsBase,
    });
    compare("painel-ads-roas-min", {
      label: "Menor ROAS",
      current: ads.roas_min,
      previous: previousAds.roas_min,
      format: (value) => formatAdsValue(value, "roas"),
      mode: "points",
      hasBase: hasAdsBase,
    });
    compare("painel-ads-prints", {
      label: "Impressoes",
      current: ads.prints,
      previous: previousAds.prints,
      format: (value) => formatAdsValue(value, "number"),
      hasBase: hasAdsBase,
    });
    compare("painel-ads-ctr", {
      label: "CTR",
      current: ads.ctr,
      previous: previousAds.ctr,
      format: (value) => formatAdsValue(value, "percent"),
      mode: "points",
      digits: 2,
      hasBase: hasAdsBase,
    });
  }

  function priorityAction(type) {
    const map = {
      anuncios_sem_venda: { label: "Ver anuncios parados →", url: "/ml/filtro-anuncios" },
      ritmo: { label: "Ver projeção →", url: "/ml/projecao-mensal" },
      reputacao: { label: "Ver impactos →", url: "/ml/reputacao" },
      ads: { label: "Ver Product Ads →", url: "/ml/publicidade/product-ads" },
      margem: { label: "Completar custos →", url: "/ml/financeiro/margem-venda-mercado-livre" },
      geral: { label: "Explorar mercado →", url: "/ml/analise-mercado" },
    };
    return map[type] || map.geral;
  }

  function buildPriorities({ inactivity = {}, finance = {}, rhythm = {}, reputation = {}, ads = {}, sources = {}, partial = false }) {
    const priorities = [];
    const available = (key) => sources?.[key]?.available !== false;
    const sev = inactivitySeverity(inactivity);
    const inactive = Number(inactivity.inactive || 0);
    const total = Number(inactivity.total || 0);
    const revenueBase = Number(finance.faturamento || 0);

    if (available("inactivity_orders") && available("active_items") && total > 0 && sev.pct >= 35) {
      const action = priorityAction("anuncios_sem_venda");
      priorities.push({
        type: "anuncios_sem_venda",
        tone: sev.tone,
        title: "Alto volume de anuncios sem venda",
        detail: `${fmtNum(inactive)} de ${fmtNum(total)} anuncios sem venda nos ultimos 30 dias (${fmtPct(sev.pct, 1)}).`,
        impact: Number(inactivity.impacto_estimado_reais || revenueBase * (sev.pct / 100) * 0.1),
        actionLabel: action.label,
        actionUrl: action.url,
      });
    }

    const revenueRhythm = rhythm?.revenue || {};
    const rhythmStatus = String(revenueRhythm.status || "");
    if (available("orders_month_current") && rhythmStatus && rhythmStatus !== "ahead" && rhythmStatus !== "no_base") {
      const action = priorityAction("ritmo");
      priorities.push({
        type: "ritmo",
        tone: "critical",
        title: "Ritmo do mês abaixo do necessário",
        detail: `Faltam ${fmtMoneyNoCents(Math.abs(Number(revenueRhythm.difference || 0)))} para atingir, até hoje, o ritmo necessário para igualar o mês passado.`,
        impact: Number(revenueRhythm.impacto_estimado_reais || Math.abs(Number(revenueRhythm.difference || 0))),
        actionLabel: action.label,
        actionUrl: action.url,
      });
    }

    const cards = reputation?.seller?.metric_cards || {};
    const reputationItems = [
      { key: "claims", label: "reclamacoes" },
      { key: "cancellations", label: "cancelamentos" },
      { key: "delayed", label: "atrasos no envio" },
      { key: "mediations", label: "mediacoes" },
    ]
      .map((item) => ({ ...item, ...(cards[item.key] || {}) }))
      .sort((a, b) => Number(b.value || 0) - Number(a.value || 0));
    const topImpact = reputationItems[0] || {};
    if (available("reputation") && Number(topImpact.count || 0) > 0) {
      const action = priorityAction("reputacao");
      priorities.push({
        type: "reputacao",
        tone: Number(topImpact.value || 0) >= 0.7 ? "critical" : "warning",
        title: "Reputacao com ponto de atencao",
        detail: `${fmtNum(topImpact.count || 0)} ${topImpact.label || "impactos"} (${fmtPct(topImpact.value || 0, 2)}).`,
        impact: Number(topImpact.impacto_estimado_reais || revenueBase * (Number(topImpact.value || 0) / 100)),
        actionLabel: action.label,
        actionUrl: action.url,
      });
    }

    if (available("product_ads") && Number(ads.roas_min || 0) > 0 && Number(ads.roas_min || 0) < 3) {
      const action = priorityAction("ads");
      priorities.push({
        type: "ads",
        tone: "warning",
        title: "Campanhas com ROAS abaixo do ideal",
        detail: `Menor ROAS detectado: ${formatAdsValue(ads.roas_min, "roas")}.`,
        impact: Number(ads.impacto_estimado_reais || Number(ads.cost || 0) * 0.2),
        actionLabel: action.label,
        actionUrl: action.url,
      });
    }

    const marginPct = Number(finance.margin_pct || 0);
    if (available("orders_current") && priorities.length < 3 && marginPct >= 60) {
      const action = priorityAction("margem");
      priorities.push({
        type: "margem",
        tone: "positive",
        title: "Margem saudavel",
        detail: `Margem de contribuicao em ${fmtPct(marginPct, 1)} no periodo selecionado.`,
        impact: Number(finance.margin || 0),
        actionLabel: action.label,
        actionUrl: action.url,
      });
    }

    if (!priorities.length) {
      if (partial) {
        priorities.push({
          type: "geral",
          tone: "warning",
          title: "Painel carregado parcialmente",
          detail: "Algumas fontes estao temporariamente indisponiveis. Os demais blocos continuam validos e serao atualizados normalmente.",
          impact: 0,
          showImpact: false,
          actionLabel: "Tentar novamente →",
          actionUrl: "/ml/painel",
        });
      } else {
        const action = priorityAction("geral");
        priorities.push({
          type: "geral",
          tone: "positive",
          title: "Conta sem alerta critico no momento",
          detail: "Continue acompanhando ritmo, ads e reputacao para agir antes de perder performance.",
          impact: Number(finance.margin || 0),
          actionLabel: action.label,
          actionUrl: action.url,
        });
      }
    }

    return priorities.slice(0, 3);
  }

  function renderExecutiveSummary(payload = {}) {
    const finance = payload.finance || {};
    const inactivity = payload.inactivity || {};
    const rhythm = payload.rhythm || {};
    const reputation = payload.reputation || {};
    const ads = payload.ads || {};
    const priorities = buildPriorities({
      inactivity, finance, rhythm, reputation, ads,
      sources: payload?.meta?.sources || {},
      partial: !!payload?.meta?.partial,
    });
    const slot = $("painel-priority-list");
    if (slot) {
      slot.innerHTML = priorities
        .map(
          (item, index) => `
            <article class="painel-priority-item" data-tone="${item.tone}">
              <span class="painel-priority-item__index">${index + 1}</span>
              <div class="painel-priority-item__content">
                <strong class="painel-priority-item__title">${item.title}</strong>
                <span class="painel-priority-item__detail">${item.detail}</span>
                <a class="painel-priority-item__action" href="${item.actionUrl || "#"}">${item.actionLabel || "Ver recomendacoes →"}</a>
              </div>
              ${item.showImpact === false ? "" : `<span class="painel-priority-item__impact">
                <strong>${formatCurrency(item.impact || 0)}</strong>
                <span>impacto potencial</span>
              </span>`}
            </article>
          `,
        )
        .join("");
    }

  }

  async function hydrateInactivity(scope, { force = false } = {}) {
    const safeScope = String(scope || state.accountScope || "").trim();
    if (!safeScope) return;
    if (!force && state.inactivityByScope.has(safeScope)) return;
    if (!force && state.inactivityLoadingScope === safeScope) return;

    const requestId = ++state.inactivityRequestSeq;
    state.inactivityLoadingScope = safeScope;
    setInactivityLoading(true, "Atualizando score de inatividade...");

    clearInactivityWatchdog();
    state.inactivityWatchdogTimer = setTimeout(() => {
      if (requestId !== state.inactivityRequestSeq) return;
      if (state.inactivityLoadingScope !== safeScope) return;

      console.warn(
        "[Painel] Leitura de inatividade demorou mais que o esperado.",
      );
      state.inactivityLoadingScope = "";
      setInactivityLoading(false);
      setInactivityStatus("Leitura parcial exibida.");
    }, INACTIVITY_WATCHDOG_MS);

    try {
      const query = force ? "?refresh=1" : "";
      const payload = await fetchJson(
        `/api/painel/inactivity${query}`,
        INACTIVITY_TIMEOUT_MS,
      );
      if (requestId !== state.inactivityRequestSeq) return;

      const responseScope = getPayloadScope(payload) || safeScope;
      const inactivity = payload?.inactivity || {};

      if (!inactivity.partial) {
        setScopedInactivityCache(responseScope, inactivity);
      }

      if (responseScope === String(state.accountScope || "").trim()) {
        renderInactivity(inactivity);
        if (state.lastPayload) {
          state.lastPayload = { ...state.lastPayload, inactivity };
          renderExecutiveSummary(state.lastPayload);
        }
      }
    } catch (error) {
      console.warn("[Painel] Falha ao hidratar inatividade:", error);
      if (requestId === state.inactivityRequestSeq) {
        setInactivityStatus(
          error?.name === "AbortError"
            ? "Tempo limite excedido. Exibindo leitura parcial."
            : "Nao foi possivel atualizar a leitura agora.",
        );
      }
    } finally {
      if (requestId === state.inactivityRequestSeq) {
        state.inactivityLoadingScope = "";
        setInactivityLoading(false);
      }
    }
  }

  function setFinancePending() {
    setText("painel-kpi-margin-value", "Calculando...");
    setText("painel-kpi-margin-meta", "Conciliando custos por SKU");
    setText("painel-kpi-margin-meta-copy", "Aguardando resumo financeiro");
    setTone("painel-kpi-margin-card", "neutral");
    setText("painel-margin-pct", "Calculando...");
    setText("painel-product-taxes", "Calculando...");
    setText("painel-coupon-costs", "Calculando...");
    setText("painel-coupon-costs-pct", "--");
    setText("painel-product-taxes-pct", "--");
    setText(
      "painel-finance-note",
      "Calculando CMV, impostos, tarifas e cupons com a mesma regra da tela Margem de venda...",
    );
  }

  async function hydrateQuickFinance({ force = false } = {}) {
    const preset = String(state.preset || "today");
    const requestId = ++state.financeRequestSeq;
    state.financeLoadingPreset = preset;
    setFinancePending();

    try {
      const payload = await fetchJson(
        `/api/painel/finance-summary?preset=${encodeURIComponent(preset)}${force ? "&refresh=1" : ""}`,
        FINANCE_TIMEOUT_MS,
      );
      if (requestId !== state.financeRequestSeq || preset !== state.preset) return;
      if (!payload?.finance?.available) throw new Error(payload?.error || "Resumo financeiro indisponivel.");

      const base = state.lastPayload || {};
      const oldFinance = base.finance || {};
      const oldPrevious = oldFinance.previous || {};
      const fresh = payload.finance || {};
      const freshPrevious = fresh.previous || {};

      // Ads permanece separado da margem de contribuicao. Preservamos os campos
      // de publicidade que vieram do overview principal.
      const mergedFinance = {
        ...oldFinance,
        ...fresh,
        costs: oldFinance.costs,
        costs_pct: oldFinance.costs_pct,
        ads_revenue: oldFinance.ads_revenue,
        organic_revenue: oldFinance.organic_revenue,
        previous: {
          ...oldPrevious,
          ...freshPrevious,
          costs: oldPrevious.costs,
          costs_pct: oldPrevious.costs_pct,
          ads_revenue: oldPrevious.ads_revenue,
          organic_revenue: oldPrevious.organic_revenue,
        },
      };
      const nextPayload = {
        ...base,
        finance: mergedFinance,
        meta: {
          ...(base.meta || {}),
          sources: {
            ...(base.meta?.sources || {}),
            finance_quick: { available: true, pending: false, error: null },
          },
        },
      };
      state.lastPayload = nextPayload;
      renderPayload(nextPayload);

      const cached = state.cacheByPreset.get(preset);
      if (cached?.payload) {
        setCachedPresetPayload(preset, nextPayload);
      }
    } catch (error) {
      if (requestId !== state.financeRequestSeq || preset !== state.preset) return;
      console.warn("[Painel] Resumo financeiro rapido:", error);
      setText("painel-kpi-margin-value", "Indisponivel");
      setText("painel-kpi-margin-meta", "Custos nao conciliados agora");
      setText("painel-kpi-margin-meta-copy", "Use Atualizar para tentar novamente");
      setText("painel-margin-pct", "Indisponivel");
      setText("painel-product-taxes", "Indisponivel");
      setText(
        "painel-finance-note",
        "Nao foi possivel carregar o resumo financeiro agora. Os demais indicadores do Painel continuam validos.",
      );
    } finally {
      if (requestId === state.financeRequestSeq) state.financeLoadingPreset = "";
    }
  }

  function renderPayload(payload) {
    clearUnavailableStates();
    const account = payload?.account || {};
    const finance = payload?.finance || {};
    const quick = payload?.quick || {};
    const overview = payload?.overview || {};
    const payloadScope = getPayloadScope(payload);
    const inactivity =
      state.inactivityByScope.get(payloadScope) || payload?.inactivity || {};
    const reputation = payload?.reputation || {};
    const rawSales = payload?.sales_summary || payload?.sales || {};
    const previousFinance = finance?.previous || {};
    const sales = {
      ...rawSales,
      current: {
        ...(rawSales?.current || {}),
        orders: firstDefinedNumber(
          rawSales?.current?.orders,
          rawSales?.current?.orders_count,
          overview?.orders_total,
        ),
        cancelled: firstDefinedNumber(
          rawSales?.current?.cancelled,
          rawSales?.current?.cancelled_count,
        ),
        revenue: firstDefinedNumber(
          rawSales?.current?.revenue,
          rawSales?.current?.faturamento,
          finance?.faturamento,
          finance?.faturamento_comercial,
        ),
      },
      previous: {
        ...(rawSales?.previous || {}),
        orders: firstDefinedNumber(
          rawSales?.previous?.orders,
          rawSales?.previous?.orders_count,
          previousFinance?.orders,
        ),
        cancelled: firstDefinedNumber(
          rawSales?.previous?.cancelled,
          rawSales?.previous?.cancelled_count,
        ),
        revenue: firstDefinedNumber(
          rawSales?.previous?.revenue,
          rawSales?.previous?.faturamento,
          previousFinance?.faturamento,
        ),
      },
    };
    const conversion = payload?.conversion || payload?.conversion_summary || {};
    const ads = payload?.ads || payload?.product_ads || {};
    const rhythm = payload?.rhythm || {};
    const current = payload?.filters?.current || {};
    state.lastPayload = {
      ...payload,
      inactivity,
      finance,
      rhythm,
      reputation,
      ads,
    };

    const accountLabel = account.label || "Conta ativa";
    setText("painel-account-name", accountLabel);
    setText("painel-marketplace-label", account.marketplace || "Mercado Livre");
    setText("painel-account-status-label", account.status_label || "Conta ativa");
    setText("painel-plan-label", account.plan_label || account.plan || "Acesso Global");
    setText("painel-sync", quick.sync_label || "Atualizado agora");
    setText("painel-summary-period", current.label || "Hoje");

    setDeltaMeta(
      "painel-kpi-revenue-meta",
      sales?.current?.revenue || finance.faturamento || 0,
      sales?.previous?.revenue || 0,
    );
    setText("painel-kpi-revenue-value", fmtMoney(finance.faturamento || sales?.current?.revenue || 0));
    setText("painel-kpi-orders-value", fmtNum(sales?.current?.orders || overview.orders_total || 0));
    const ordersDelta = setDeltaMeta("painel-kpi-orders-meta", sales?.current?.orders || 0, sales?.previous?.orders || 0);
    setText("painel-kpi-orders-meta-copy", ordersDelta.text);
    setTone("painel-kpi-orders-meta-copy", ordersDelta.tone);
    setText("painel-kpi-conversion-value", fmtPct(conversion?.conversao_atual || 0, 2));
    const hasConversionBase = Number(conversion?.visitas_periodo_anterior || 0) > 0;
    setText(
      "painel-kpi-conversion-meta",
      hasConversionBase
        ? `${Number(conversion?.conversao_delta_pp || 0) >= 0 ? "+" : "-"}${fmtDecimal(Math.abs(Number(conversion?.conversao_delta_pp || 0)), 1)}pp ${getComparisonInlineLabel()}`
        : "Sem comparativo",
    );
    setTone(
      "painel-kpi-conversion-meta",
      hasConversionBase
        ? Number(conversion?.conversao_delta_pp || 0) >= 0
          ? "positive"
          : "negative"
        : "neutral",
    );
    const financeAvailable = finance?.available === true;
    const hasPreviousFinance = financeAvailable && finance?.previous?.available === true;
    const previousMarginPct = Number(finance?.previous?.margin_pct || 0);
    const marginDeltaPp = Number(finance.margin_pct || 0) - previousMarginPct;
    if (financeAvailable) {
      setText("painel-kpi-margin-value", fmtPct(finance.margin_pct, 1));
      setText("painel-kpi-margin-meta", `${fmtMoney(finance.margin || 0)} de contribuicao`);
      setText(
        "painel-kpi-margin-meta-copy",
        hasPreviousFinance
          ? `${fmtMoney(finance.margin || 0)} de contribuicao · ${marginDeltaPp >= 0 ? "+" : "-"}${fmtDecimal(Math.abs(marginDeltaPp), 1)} p.p. ${getComparisonInlineLabel()}`
          : `${fmtMoney(finance.margin || 0)} de contribuicao · sem comparativo`,
      );
      setTone("painel-kpi-margin-meta-copy", hasPreviousFinance ? (marginDeltaPp >= 0 ? "positive" : "negative") : "neutral");
      setTone("painel-kpi-margin-card", marginTone(finance.margin_pct));
    } else {
      setFinancePending();
    }
    const adsCost = Number(ads.cost || finance.costs || 0);
    const adsRevenue = Number(ads.amount || 0);
    const adsRoas = Number(ads.roas || (adsCost > 0 ? adsRevenue / adsCost : 0));
    const previousAds = ads?.previous || {};
    const hasAdsBase = [
      previousAds.cost,
      previousAds.amount,
      previousAds.units,
      previousAds.prints,
      previousAds.clicks,
    ].some((value) => Number(value || 0) > 0);
    setText("painel-kpi-ads-value", formatAdsValue(adsRoas, "roas"));
    setText("painel-kpi-ads-cost-value", formatAdsValue(adsCost, "currency"));
    const roasDelta = Number(adsRoas) - Number(previousAds.roas || 0);
    setText(
      "painel-kpi-ads-meta",
      hasAdsBase
        ? `${roasDelta >= 0 ? "+" : "-"}${fmtDecimal(Math.abs(roasDelta), 2)}x ${getComparisonInlineLabel()}`
        : "Sem comparativo",
    );
    setTone("painel-kpi-ads-meta", hasAdsBase ? (roasDelta >= 0 ? "positive" : "negative") : "neutral");
    const adsCostComparison = formatDeltaPct(adsCost, previousAds.cost || 0, { inverse: true, digits: 0 });
    setText("painel-kpi-ads-cost-meta", hasAdsBase ? adsCostComparison.text : "Sem comparativo");
    setTone("painel-kpi-ads-cost-meta", hasAdsBase ? adsCostComparison.tone : "neutral");

    renderComparison("painel-kpi-conversion-value", {
      label: "Conversao",
      current: conversion?.conversao_atual,
      previous: conversion?.conversao_periodo_anterior,
      format: (value) => fmtPct(value, 2),
      mode: "points",
      digits: 2,
      hasBase: hasConversionBase,
      showDelta: false,
    });
    renderComparison("painel-kpi-ads-value", {
      label: "ROAS",
      current: adsRoas,
      previous: previousAds.roas,
      format: (value) => formatAdsValue(value, "roas"),
      mode: "points",
      digits: 2,
      hasBase: hasAdsBase,
      showDelta: false,
    });
    renderComparison("painel-kpi-ads-cost-value", {
      label: "Investimento ADS",
      current: adsCost,
      previous: previousAds.cost,
      format: (value) => formatAdsValue(value, "currency"),
      inverse: true,
      hasBase: hasAdsBase,
      showDelta: false,
    });

    setText("painel-plataforma", fmtMoney(finance.plataforma || 0));
    setText("painel-coupon-costs", financeAvailable ? fmtMoney(finance.coupon_cost || 0) : "Calculando...");
    const hasProductTaxes = financeAvailable && Number(finance.product_and_taxes || 0) > 0;
    setText(
      "painel-product-taxes",
      financeAvailable
        ? hasProductTaxes ? fmtMoney(finance.product_and_taxes || 0) : "R$ 0,00"
        : "Calculando...",
    );
    setText("painel-ticket", fmtMoney(finance.ticket || 0));
    setText("painel-plataforma-pct", fmtPct(finance.plataforma_pct || 0, 1));
    setText("painel-coupon-costs-pct", financeAvailable ? fmtPct(finance.coupon_cost_pct || 0, 1) : "--");
    setText(
      "painel-product-taxes-pct",
      hasProductTaxes ? fmtPct(finance.product_and_taxes_pct || 0, 1) : "--",
    );
    setText("painel-margin-pct", financeAvailable ? fmtPct(finance.margin_pct, 1) : "Calculando...");
    setText(
      "painel-finance-note",
      finance.helper ||
        "Preencha custo e aliquota nas telas financeiras do Mercado Livre para completar este indicador.",
    );

    safeSection("inatividade", () => renderInactivity(inactivity));

    const shouldHydrateInactivity =
      payload?.inactivity?.partial === true &&
      !state.inactivityByScope.has(payloadScope);

    if (shouldHydrateInactivity) {
      hydrateInactivity(payloadScope).catch((error) =>
        console.warn("[Painel] Falha ao hidratar inatividade:", error),
      );
    } else {
      setInactivityLoading(false);
    }

    setText("painel-summary-sales", fmtNum(sales?.current?.orders || 0));
    setText("painel-summary-cancelled", fmtNum(sales?.current?.cancelled || 0));
    setText("painel-summary-revenue", fmtMoney(sales?.current?.revenue || 0));

    safeSection("conversão", () => renderConversion(conversion));

    setText(
      "painel-score-helper",
      reputation?.helper || "Sem alertas de exposição no momento.",
    );
    safeSection("reputação", () => renderImpactList(reputation));

    safeSection("Product Ads", () => renderAds(ads));
    safeSection("comparativos", () =>
      renderPerformanceComparisons({ sales, finance, conversion, ads }),
    );
    Promise.resolve(renderStockRiskKpi()).catch((error) =>
      console.warn("[Painel] Falha ao carregar risco de estoque:", error),
    );
    safeSection("ritmo mensal", () => renderRhythm(rhythm));
    safeSection("prioridades", () => renderExecutiveSummary(state.lastPayload));
    applySourceAvailability(payload);
  }

  async function render({ force = false, bypassClientCache = false } = {}) {
    await ensureAccountScope();

    if (force) {
      clearPresetCache(state.preset);
      state.inactivityByScope.delete(String(state.accountScope || "").trim());
    }

    const cachedPayload = !force && !bypassClientCache ? getCachedPresetPayload(state.preset) : null;
    if (cachedPayload) {
      renderPayload(cachedPayload);
      state.hasLoadedOnce = true;
      if (cachedPayload?.finance?.available !== true) {
        hydrateQuickFinance({ force: false }).catch(() => {});
      }
      return;
    }

    const requestId = ++state.requestSeq;

    setLoading(
      true,
      state.hasLoadedOnce
        ? "Atualizando os indicadores do Painel para o periodo selecionado."
        : "Consolidando operacao, financeiro e Product Ads da conta ativa.",
    );

    setText("painel-sync", "Atualizando...");

    try {
      const payload = await fetchJson(
        `/api/painel/overview?preset=${encodeURIComponent(state.preset)}${force ? "&refresh=1" : ""}`,
        OVERVIEW_TIMEOUT_MS,
      );

      if (requestId !== state.requestSeq) return;

      setCachedPresetPayload(state.preset, payload);
      renderPayload(payload);
      hydrateQuickFinance({ force }).catch(() => {});
    } catch (error) {
      if (requestId !== state.requestSeq) return;

      resetUnavailable();

      const slot = $("painel-impact-list");
      if (slot) {
        const msg =
          error?.name === "AbortError"
            ? "O Painel demorou mais do que o esperado para responder. Tente atualizar novamente."
            : error.message;

        slot.innerHTML = `<div class="painel-empty">Nao foi possivel consolidar o Painel agora: ${msg}</div>`;
      }

      setText(
        "painel-score-helper",
        "Os alertas de exposicao nao puderam ser carregados agora.",
      );
      setText(
        "painel-sync",
        error?.name === "AbortError"
          ? "Tempo limite excedido"
          : "Falha ao consolidar dados",
      );
    } finally {
      if (requestId !== state.requestSeq) return;
      state.hasLoadedOnce = true;
      setLoading(false);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    setInactivityLoading(false);

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const preset = tab.dataset.preset || "today";
        if (preset === state.preset) return;
        state.financeRequestSeq += 1;
        setActivePreset(preset);
        render();
      });
    });

    document.querySelectorAll("[data-rhythm-tab]").forEach((tab) => {
      tab.addEventListener("click", () => {
        const key = tab.dataset.rhythmTab;
        document
          .querySelectorAll("[data-rhythm-tab]")
          .forEach((item) => item.classList.toggle("active", item === tab));
        document
          .querySelectorAll("[data-rhythm-content]")
          .forEach((content) =>
            content.classList.toggle(
              "active",
              content.dataset.rhythmContent === key,
            ),
          );
      });
    });

    $("painel-refresh")?.addEventListener("click", () =>
      render({ force: true }),
    );
    setActivePreset(state.preset);
    // Na entrada da tela buscamos o payload novamente (o backend ainda pode
    // responder do cache servidor). Isso evita reaproveitar payloads parciais
    // de versões anteriores e garante feedback visual de carregamento.
    render({ bypassClientCache: true });
  });
})();
