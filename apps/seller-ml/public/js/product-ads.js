// =============================================================
// Base path helper (supports deployments under /ml)
// =============================================================
(function initBasePath(){
  if (typeof window === 'undefined') return;
  if (window.__ML_BASE_PATH != null) return;
  const p = window.location && window.location.pathname ? window.location.pathname : '';
  window.__ML_BASE_PATH = (p === '/ml' || p.startsWith('/ml/')) ? '/ml' : '';
})();

function withBase(path) {
  const base = (typeof window !== 'undefined' && window.__ML_BASE_PATH) ? window.__ML_BASE_PATH : '';
  if (!path || typeof path !== 'string') return path;
  if (!base) return path;
  if (path === base || path.startsWith(base + '/')) return path;
  if (path.startsWith('/')) return base + path;
  return path;
}

// public/js/product-ads.js
(() => {
  console.log(" product-ads.js carregado");

  // ==========================================
  // Helpers
  // ==========================================
  const qs = (sel, el = document) => el.querySelector(sel);
  const qsa = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  const esc = (s) =>
    s == null
      ? ""
      : String(s).replace(
          /[&<>"']/g,
          (c) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#039;",
            }[c])
        );

  const cleanCampaignLabel = (value) => {
    const raw = String(value || "");
    const cleaned = raw
      .replace(/\s*[\(\[][^\)\]]*-\s*ADS\s*[\)\]]/gi, "")
      .replace(/\s{2,}/g, " ")
      .replace(/\s*[-–—]\s*$/g, "")
      .trim();
    return cleaned || raw.trim();
  };

  const fmtMoney = (v) => {
    const n = Number(v);
    if (!isFinite(n)) return "-";
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  };

  const fmtNumber = (v, d = 0) => {
    const n = Number(v);
    if (!isFinite(n)) return "-";
    return n.toLocaleString("pt-BR", {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  };

  const fmtPct = (v, d = 2) => {
    const n = Number(v);
    if (!isFinite(n)) return "-";
    return `${n.toFixed(d).replace(".", ",")}%`;
  };

  const fmtRatioX = (v, d = 2) => {
    const n = Number(v);
    if (!isFinite(n)) return "-";
    return `${fmtNumber(n, d)}x`;
  };

  const todayISO = () => new Date().toISOString().slice(0, 10);

  const addDays = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  const firstDayOfMonthISO = () => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  };

  function isSameMonth(fromISO, toISO) {
    if (!fromISO || !toISO) return false;
    const a = String(fromISO).slice(0, 7);
    const b = String(toISO).slice(0, 7);
    return a === b;
  }

  function dayOfMonth(isoLike) {
    const s = String(isoLike || "");
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return s;
    return String(parseInt(m[3], 10)); // "1".."31"
  }

  function dayMonth(isoLike) {
    const s = String(isoLike || "");
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return s;
    return `${m[3]}/${m[2]}`;
  }

  function parseIsoDate(isoLike) {
    const m = String(isoLike || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return null;
    }
    return new Date(Date.UTC(year, month, day));
  }

  function toIsoDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    )
      .toISOString()
      .slice(0, 10);
  }

  function shiftIsoDate(isoLike, deltaDays) {
    const base = parseIsoDate(isoLike);
    if (!base) return "";
    base.setUTCDate(base.getUTCDate() + Number(deltaDays || 0));
    return toIsoDate(base);
  }

  function buildDateSpan(fromIso, toIso) {
    const start = parseIsoDate(fromIso);
    const end = parseIsoDate(toIso);
    if (!start || !end || start > end) return [];

    const days = [];
    const cursor = new Date(start.getTime());
    while (cursor <= end) {
      days.push(toIsoDate(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  }

  function buildPreviousRange(fromIso, toIso) {
    return buildComparisonRange(fromIso, toIso, state.compareMode || "previous_month");
  }

  function shiftIsoCalendar(isoLike, { months = 0, years = 0 } = {}) {
    const base = parseIsoDate(isoLike);
    if (!base) return "";
    const originalDay = base.getUTCDate();
    const targetYear = base.getUTCFullYear() + Number(years || 0);
    const targetMonth = base.getUTCMonth() + Number(months || 0);
    const firstTarget = new Date(Date.UTC(targetYear, targetMonth, 1));
    const lastDay = new Date(
      Date.UTC(firstTarget.getUTCFullYear(), firstTarget.getUTCMonth() + 1, 0),
    ).getUTCDate();
    firstTarget.setUTCDate(Math.min(originalDay, lastDay));
    return toIsoDate(firstTarget);
  }

  function buildComparisonRange(fromIso, toIso, mode = "previous_month") {
    const currentDays = buildDateSpan(fromIso, toIso);
    if (!currentDays.length) return null;

    const previousFrom =
      mode === "previous_year"
        ? shiftIsoCalendar(fromIso, { years: -1 })
        : shiftIsoCalendar(fromIso, { months: -1 });
    const previousTo =
      mode === "previous_year"
        ? shiftIsoCalendar(toIso, { years: -1 })
        : shiftIsoCalendar(toIso, { months: -1 });
    if (!previousFrom || !previousTo) return null;

    return {
      from: previousFrom,
      to: previousTo,
      totalDays: currentDays.length,
      mode,
    };
  }

  const PERIOD_PRESETS = [
    { days: 7, label: "Ultimos 7 dias" },
    { days: 15, label: "Ultimos 15 dias" },
    { days: 30, label: "Ultimos 30 dias" },
    { days: 60, label: "Ultimos 60 dias" },
    { days: 90, label: "Ultimos 90 dias" },
  ];

  function dateRangeForLastDays(days) {
    const totalDays = Math.max(1, Number(days || 30));
    const to = todayISO();
    const from = shiftIsoDate(to, -(totalDays - 1)) || addDays(-(totalDays - 1));
    return { from, to };
  }

  function formatShortDateBr(isoLike) {
    const date = parseIsoDate(isoLike);
    if (!date) return String(isoLike || "");
    return new Intl.DateTimeFormat("pt-BR", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(date).replace(/\sde\s/g, " ");
  }

  function formatPeriodRange(from, to) {
    if (!from || !to) return "-";
    return `${formatShortDateBr(from)} - ${formatShortDateBr(to)}`;
  }

  function daysBetweenInclusive(from, to) {
    const start = parseIsoDate(from);
    const end = parseIsoDate(to);
    if (!start || !end || start > end) return 0;
    return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  }

  function daysInMonth(isoLike = todayISO()) {
    const date = parseIsoDate(isoLike);
    if (!date) return 30;
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
    ).getUTCDate();
  }

  function elapsedDaysInMonth(isoLike = todayISO()) {
    const date = parseIsoDate(isoLike);
    if (!date) return 1;
    return Math.max(1, date.getUTCDate());
  }

  function toFiniteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function mapSeriesByDate(series) {
    const map = new Map();
    (Array.isArray(series) ? series : []).forEach((row) => {
      const key = String(row?.date || "").slice(0, 10);
      if (!key) return;
      map.set(key, row);
    });
    return map;
  }

  function formatDateBr(isoLike) {
    const m = String(isoLike || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(isoLike || "");
    return `${m[3]}/${m[2]}/${m[1]}`;
  }

  function formatDateTimeBr(value) {
    if (!value) return "";
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return formatDateBr(raw);

    const date = new Date(raw);
    if (!Number.isFinite(date.getTime())) return raw;

    const hasTime = /T\d{2}:\d{2}| \d{2}:\d{2}/.test(raw);
    const formatter = new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      ...(hasTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    });

    return formatter.format(date).replace(",", "");
  }

  function isoMax(a, b) {
    if (!a) return b || "";
    if (!b) return a || "";
    return a > b ? a : b;
  }

  function isoMin(a, b) {
    if (!a) return b || "";
    if (!b) return a || "";
    return a < b ? a : b;
  }

  function weekStartMondayIso(isoLike) {
    const d = parseIsoDate(isoLike);
    if (!d) return "";
    const dow = d.getUTCDay(); // 0=domingo
    const shift = dow === 0 ? -6 : 1 - dow;
    d.setUTCDate(d.getUTCDate() + shift);
    return toIsoDate(d);
  }

  function aggregateSeriesWeekly(series = []) {
    const from = String(state.date_from || "");
    const to = String(state.date_to || "");
    const map = new Map();

    (Array.isArray(series) ? series : []).forEach((row) => {
      const dateIso = String(row?.date || "").slice(0, 10);
      if (!dateIso) return;
      const weekStart = weekStartMondayIso(dateIso);
      if (!weekStart) return;
      const weekEnd = shiftIsoDate(weekStart, 6);

      const acc = map.get(weekStart) || {
        date: weekStart,
        period_start: weekStart,
        period_end: weekEnd,
        clicks: 0,
        prints: 0,
        cost: 0,
        total_amount: 0,
        units_quantity: 0,
      };

      acc.clicks += Number(row?.clicks || 0);
      acc.prints += Number(row?.prints || 0);
      acc.cost += Number(row?.cost || 0);
      acc.total_amount += Number(row?.total_amount || 0);
      acc.units_quantity += Number(row?.units_quantity || 0);
      map.set(weekStart, acc);
    });

    return Array.from(map.values())
      .sort((a, b) => String(a.period_start).localeCompare(String(b.period_start)))
      .map((row) => {
        const clicks = Number(row.clicks || 0);
        const prints = Number(row.prints || 0);
        const cost = Number(row.cost || 0);
        const amount = Number(row.total_amount || 0);
        const start = isoMax(String(row.period_start || ""), from);
        const end = isoMin(String(row.period_end || ""), to);
        const startLabel = dayMonth(start || row.period_start);
        const endLabel = dayMonth(end || row.period_end);
        const periodLabel = startLabel === endLabel ? startLabel : `${startLabel} - ${endLabel}`;

        return {
          ...row,
          period_label: periodLabel,
          ctr: prints > 0 ? (clicks / prints) * 100 : 0,
          cpc: clicks > 0 ? cost / clicks : 0,
          roas: cost > 0 ? amount / cost : 0,
          acos: amount > 0 ? (cost / amount) * 100 : 0,
        };
      });
  }

  function getDateRange() {
    const inpFrom = qs("#dateFrom");
    const inpTo = qs("#dateTo");
    const fallbackRange = dateRangeForLastDays(30);

    let from = inpFrom?.value || fallbackRange.from;
    let to = inpTo?.value || fallbackRange.to;

    if (from > to) {
      const tmp = from;
      from = to;
      to = tmp;
    }

    if (inpFrom) inpFrom.value = from;
    if (inpTo) inpTo.value = to;

    return { from, to };
  }

  function updatePeriodMenuRanges() {
    PERIOD_PRESETS.forEach((preset) => {
      const label = qs(`[data-period-range="${preset.days}"]`);
      if (!label) return;
      const range = dateRangeForLastDays(preset.days);
      label.textContent = formatPeriodRange(range.from, range.to);
    });
  }

  function syncPeriodSelector(from, to) {
    updatePeriodMenuRanges();

    const totalDays = daysBetweenInclusive(from, to);
    const matchedPreset = PERIOD_PRESETS.find(
      (preset) => preset.days === totalDays && to === todayISO(),
    );
    const labelEl = qs("#periodDropdownLabel");
    if (labelEl) {
      labelEl.textContent = matchedPreset ? matchedPreset.label : "Personalizado";
    }

    qsa("[data-period-days]").forEach((btn) => {
      const isActive =
        matchedPreset && Number(btn.getAttribute("data-period-days")) === matchedPreset.days;
      btn.classList.toggle("is-active", !!isActive);
    });
  }

  function compareModeLabel(mode = state.compareMode) {
    return mode === "previous_year" ? "Ano anterior" : "Periodo anterior";
  }

  function compareModeShortLabel(mode = state.compareMode) {
    return mode === "previous_year" ? "ano anterior" : "mes anterior";
  }

  function syncCompareSelector(from, to) {
    const mode = state.compareMode === "previous_year" ? "previous_year" : "previous_month";
    const labelEl = qs("#compareDropdownLabel");
    if (labelEl) labelEl.textContent = compareModeLabel(mode);

    const previousRange = buildComparisonRange(from, to, "previous_month");
    const yearRange = buildComparisonRange(from, to, "previous_year");
    const previousRangeEl = qs("#compareRangePrevious");
    const yearRangeEl = qs("#compareRangeYear");
    if (previousRangeEl && previousRange) {
      previousRangeEl.textContent = formatPeriodRange(previousRange.from, previousRange.to);
    }
    if (yearRangeEl && yearRange) {
      yearRangeEl.textContent = formatPeriodRange(yearRange.from, yearRange.to);
    }

    qsa("[data-compare-mode]").forEach((btn) => {
      const active = String(btn.getAttribute("data-compare-mode") || "") === mode;
      btn.classList.toggle("is-active", active);
    });
  }

  function setDateRangeInputs(from, to) {
    const inpFrom = qs("#dateFrom");
    const inpTo = qs("#dateTo");
    if (inpFrom) inpFrom.value = from || "";
    if (inpTo) inpTo.value = to || "";
    syncPeriodSelector(from, to);
    syncCompareSelector(from, to);
  }

  function setLoadingTable(tbody, msg = "Carregando...") {
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="99" class="muted">${esc(
      msg
    )}</td></tr>`;
  }

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  const setHtml = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = value;
  };

  const setTextAny = (ids, value) => {
    (ids || []).forEach((id) => setText(id, value));
  };

  // ==========================================
  // Estado
  // ==========================================
  const state = {
    date_from: null,
    date_to: null,
    focusMode: false,
    pendingFocusCampaignId: null,
    previousKpiSummary: null,
    currentRangeSummary: null,

    // ranking + itens
    campaigns: [],
    campaignSort: { key: "criticality", dir: "desc" },
    itemsByCampaign: new Map(), // campaign_id -> { date_from, date_to, items }
    selectedCampaignId: null,
    selectedRowEl: null,
    itemsPage: 1,
    itemsPerPage: 20,
    itemAnalysisFilter: { key: "all", label: "Todos", targetMlb: null },

    // daily chart/table (premium)
    dailySeries: [],
    dailySeriesPrevious: [],
    dailyPreviousRange: null,
    dailyGranularity: "daily",
    chart: null,
    metric: "total_amount",
    chartScope: "overall",
    chartCompareEnabled: true,
    compareMode: "previous_month",
    activeTab: "overview",
    campaignTab: "campaign-overview",
    globalAds: {
      items: [],
      page: 1,
      limit: 50,
      total: 0,
      loading: false,
      loadedRangeKey: "",
    },

    // wizard criar campanha
    wizard: {
      mode: "create",
      targetCampaignId: null,
      targetCampaignName: "",
      open: false,
      step: 1,
      loading: false,
      creating: false,
      loadToken: 0,
      page: 1,
      limit: 20,
      total: 0,
      query: "",
      status: "all",
      items: [],
      selected: new Map(), // item_id -> row
      salesRange: { from: null, to: null },
    },

    editCampaign: {
      open: false,
      saving: false,
      campaignId: null,
    },

    focusFieldEdit: {
      open: false,
      field: null,
      campaignId: null,
      saving: false,
      statusSaving: false,
    },

    statusConfirm: {
      open: false,
      campaignId: null,
      nextStatus: "active",
      showInlineFeedback: false,
      saving: false,
    },
  };

  const uiDefaults = {
    premiumTitle: "Performance do periodo",
    premiumSubtitle: "Resultado primeiro, explicacao depois: KPIs principais e eficiencia de midia.",
  };

  const CHART_COMPARE_STORAGE_KEY = "ml.publicidade.chart.compare_prev";
  const COMPARE_MODE_STORAGE_KEY = "ml.publicidade.compare_mode";

  function readChartComparePreference() {
    try {
      const raw = String(window.localStorage.getItem(CHART_COMPARE_STORAGE_KEY) || "").trim();
      if (!raw) return true;
      return !["0", "false", "off", "no"].includes(raw.toLowerCase());
    } catch {
      return true;
    }
  }

  function writeChartComparePreference(enabled) {
    try {
      window.localStorage.setItem(
        CHART_COMPARE_STORAGE_KEY,
        enabled ? "1" : "0",
      );
    } catch {}
  }

  function readCompareModePreference() {
    try {
      const raw = String(window.localStorage.getItem(COMPARE_MODE_STORAGE_KEY) || "").trim();
      return raw === "previous_year" ? "previous_year" : "previous_month";
    } catch {
      return "previous_month";
    }
  }

  function writeCompareModePreference(mode) {
    try {
      window.localStorage.setItem(
        COMPARE_MODE_STORAGE_KEY,
        mode === "previous_year" ? "previous_year" : "previous_month",
      );
    } catch {}
  }

  function syncBodyScrollLock() {
    const lock =
      !!wizard.open ||
      !!state.editCampaign.open ||
      !!state.focusFieldEdit.open ||
      !!state.statusConfirm.open;
    document.body.style.overflow = lock ? "hidden" : "";
  }

  // ==========================================
  // DOM hooks (ranking / itens)
  // ==========================================
  const $campBody = () => qs("#tbodyCampaigns");
  const $itemsBody = () => qs("#tbodyItems");
  const $btnExport = () => qs("#btnExportCsv");
  const $pagination = () => qs("#adsPagination");
  const MLB_FILTER_LABELS = {
    all: "Todos",
    sugador: "Sugadores de verba",
    clique_sem_venda: "Clique sem venda",
    ctr_baixo: "CTR baixo",
    cpc_alto: "CPC alto",
    oportunidade: "Oportunidades",
    saudavel: "Saudaveis",
    monitorar: "Monitorar",
  };

  function syncPeriodLabels(from, to) {
    const rangeLabel = formatPeriodRange(from, to);
    setText("rankingPeriod", rangeLabel);
    setText("pillRange", "Receita");
    syncPeriodSelector(from, to);
    syncCompareSelector(from, to);

    const premiumPeriod = qs("#premiumPeriod");
    if (premiumPeriod) {
      premiumPeriod.textContent = "";
      premiumPeriod.hidden = true;
    }
  }

  function campaignIdOf(campaign) {
    if (!campaign || typeof campaign !== "object") return "";
    return String(
      campaign.id ??
        campaign.campaign_id ??
        campaign.campaignId ??
        campaign.advertising_campaign_id ??
        ""
    );
  }

  function getCampaignById(campaignId) {
    const id = String(campaignId || "");
    if (!id) return null;
    return (
      (state.campaigns || []).find((campaign) => campaignIdOf(campaign) === id) || null
    );
  }

  function getSelectedCampaign() {
    return getCampaignById(state.selectedCampaignId);
  }

  function isCampaignActiveStatus(statusRaw) {
    const s = String(statusRaw || "").toLowerCase();
    return s === "active" || s === "enabled" || s === "on";
  }

  function campaignStatusOf(campaign) {
    if (!campaign || typeof campaign !== "object") return "";
    return (
      campaign.status ??
      campaign.state ??
      campaign.status_id ??
      campaign.campaign_status ??
      campaign.campaignStatus ??
      campaign.advertising_status ??
      ""
    );
  }

  function isActiveCampaign(campaign) {
    if (!campaign || typeof campaign !== "object") return false;
    const status = campaignStatusOf(campaign);
    if (status) return isCampaignActiveStatus(status);
    return campaign.active === true || campaign.enabled === true;
  }

  function filterActiveCampaigns(campaigns = []) {
    return (Array.isArray(campaigns) ? campaigns : []).filter(isActiveCampaign);
  }

  function isCampaignPausedStatus(statusRaw) {
    const s = String(statusRaw || "").toLowerCase();
    return s === "paused" || s === "disabled" || s === "off";
  }

  function normalizePublicidadePath(pathname) {
    const rawPath = String(pathname || "");
    const base = String(window.__ML_BASE_PATH || "");
    if (!rawPath) return "/";
    if (!base) return rawPath;

    const lowerBase = base.toLowerCase();
    const lowerPath = rawPath.toLowerCase();

    if (lowerPath === lowerBase) return "/";
    if (lowerPath.startsWith(`${lowerBase}/`)) {
      return rawPath.slice(base.length) || "/";
    }
    return rawPath;
  }

  function publicidadeOverviewPath() {
    return withBase("/publicidade/product-ads");
  }

  function publicidadeCampaignPath(campaignId) {
    const id = String(campaignId || "").trim();
    if (!id) return publicidadeOverviewPath();
    return withBase(`/publicidade/product-ads/campanhas/${encodeURIComponent(id)}`);
  }

  function readCampaignIdFromPath(pathname) {
    const normalizedPath = normalizePublicidadePath(pathname);
    const routeMatch = normalizedPath.match(
      /^\/publicidade\/(?:product-ads\/campanhas|campanha)\/([^/?#]+)/i
    );
    if (!routeMatch || !routeMatch[1]) return null;
    const routeId = decodeURIComponent(routeMatch[1]).trim();
    return routeId || null;
  }

  function isDedicatedCampaignRoute(pathname) {
    return !!readCampaignIdFromPath(pathname || window.location.pathname);
  }

  function updateCampaignParamInUrl(campaignId, opts = {}) {
    try {
      const url = new URL(window.location.href);
      const id = campaignId ? String(campaignId).trim() : "";
      url.pathname = id ? publicidadeCampaignPath(id) : publicidadeOverviewPath();
      url.searchParams.delete("campaign");
      const next = `${url.pathname}${url.search}${url.hash}`;
      const historyMethod = opts?.replace === false ? "pushState" : "replaceState";
      if (typeof window.history?.[historyMethod] === "function") {
        window.history[historyMethod]({}, "", next);
      }
    } catch (_) {}
  }

  function asFiniteNumber(value) {
    const n = Number(value);
    return isFinite(n) ? n : null;
  }

  function firstFiniteNumber(values = []) {
    for (const value of values) {
      const n = asFiniteNumber(value);
      if (n != null) return n;
    }
    return null;
  }

  function campaignRoasTargetValue(campaign) {
    return firstFiniteNumber([
      campaign?.roas_target,
      campaign?.goal,
      campaign?.target_roas,
      campaign?.targetRoas,
    ]);
  }

  function campaignBudgetValue(campaign) {
    return firstFiniteNumber([
      campaign?.daily_budget,
      campaign?.dailyBudget,
      campaign?.budget,
      campaign?.budget_amount,
      campaign?.budgetAmount,
      campaign?.average_daily_budget,
      campaign?.averageDailyBudget,
      campaign?.daily_budget_amount,
      campaign?.dailyBudgetAmount,
      campaign?.budget?.amount,
      campaign?.budget?.value,
      campaign?.budget?.daily_budget,
      campaign?.budget?.dailyBudget,
      campaign?.daily_budget?.amount,
      campaign?.daily_budget?.value,
      campaign?.average_daily_budget?.amount,
      campaign?.average_daily_budget?.value,
    ]);
  }

  function campaignLastUpdatedValue(campaign) {
    return (
      campaign?.last_updated ||
      campaign?.lastUpdated ||
      campaign?.updated_at ||
      campaign?.updatedAt ||
      null
    );
  }

  function calculateActiveDailyBudget(campaigns = []) {
    let total = 0;
    let count = 0;

    for (const campaign of filterActiveCampaigns(campaigns)) {
      const budget = campaignBudgetValue(campaign);
      if (budget == null || budget <= 0) continue;
      total += budget;
      count += 1;
    }

    return { total, count };
  }

  function campaignSponsoredCountValue(campaign) {
    return firstFiniteNumber([
      campaign?.sponsored_items_count,
      campaign?.sponsoredItemsCount,
      campaign?.items_count,
      campaign?.itemsCount,
      campaign?.advertised_items_count,
      campaign?.advertisedItemsCount,
      campaign?.ads_count,
      campaign?.adsCount,
      campaign?.adgroups_count,
      campaign?.adgroupsCount,
      campaign?.ad_groups_count,
      campaign?.adGroupsCount,
    ]);
  }

  function campaignRoasCurrentValue(campaign) {
    const m = campaign?.metrics || {};
    const directRoas = firstFiniteNumber([m.roas, campaign?.roas]);
    if (directRoas != null) return directRoas;

    const amount = firstFiniteNumber([m.total_amount]);
    const cost = firstFiniteNumber([m.cost]);
    if (amount != null && cost != null && cost > 0) return amount / cost;
    return null;
  }

  function getCampaignDiagnosis(campaign) {
    const statusRaw = String(campaignStatusOf(campaign) || "").toLowerCase();
    const roasCurrent = campaignRoasCurrentValue(campaign);
    const roasTarget = campaignRoasTargetValue(campaign);
    const m = campaign?.metrics || {};
    const cost = Number(m.cost || 0);
    const amount = Number(m.total_amount || 0);
    const units = Number(m.units_quantity || 0);

    if (isCampaignPausedStatus(statusRaw)) {
      return { label: "Inativa", tone: "neutral" };
    }

    if (cost > 0 && units <= 0 && amount <= 0) {
      return { label: "Critico", tone: "bad" };
    }

    if (roasCurrent == null || roasTarget == null || roasTarget <= 0) {
      return { label: "Atencao", tone: "warn" };
    }

    if (roasCurrent >= roasTarget) {
      return { label: "Saudavel", tone: "good" };
    }
    if (roasCurrent >= roasTarget * 0.7) {
      return { label: "Atencao", tone: "warn" };
    }
    return { label: "Critico", tone: "bad" };
  }

  function getCampaignDecision(campaign) {
    const diagnosis = getCampaignDiagnosis(campaign);
    const m = campaign?.metrics || {};
    const cost = Number(m.cost || 0);
    const amount = Number(m.total_amount || 0);
    const units = Number(m.units_quantity || 0);
    const roasCurrent = campaignRoasCurrentValue(campaign);
    const roasTarget = campaignRoasTargetValue(campaign);
    const ctr = firstFiniteNumber([m.ctr]);

    if (isCampaignPausedStatus(campaign?.status)) {
      return {
        title: "Reativar",
        reason: "Campanha inativa no momento",
        tone: "neutral",
        kind: "activate",
      };
    }
    if (cost > 0 && units <= 0 && amount <= 0) {
      return {
        title: "Pausar agora",
        reason: "Investimento sem venda no periodo",
        tone: "bad",
        kind: "pause",
      };
    }
    if (diagnosis.tone === "bad") {
      return {
        title: "Revisar urgente",
        reason: "ROAS critico, baixo retorno",
        tone: "bad",
        kind: "review",
      };
    }
    if (diagnosis.tone === "warn") {
      return {
        title: "Revisar",
        reason: "ROAS abaixo do objetivo",
        tone: "warn",
        kind: "review",
      };
    }
    if (roasCurrent != null && roasTarget != null && roasCurrent >= roasTarget * 1.2) {
      return {
        title: "Escalar",
        reason: "ROAS acima da meta com margem",
        tone: "good",
        kind: "scale",
      };
    }
    if (ctr != null && ctr < 0.35) {
      return {
        title: "Otimizar",
        reason: "CTR abaixo do ideal",
        tone: "warn",
        kind: "optimize",
      };
    }
    return { title: "Monitorar", reason: "Campanha dentro do esperado", tone: "good", kind: "monitor" };
  }

  function campaignDiagnosisDetail(campaign) {
    const m = campaign?.metrics || {};
    const cost = Number(m.cost || 0);
    const amount = Number(m.total_amount || 0);
    const units = Number(m.units_quantity || 0);
    const roasCurrent = campaignRoasCurrentValue(campaign);
    const roasTarget = campaignRoasTargetValue(campaign);
    const cpc = firstFiniteNumber([m.cpc]);
    const ctr = firstFiniteNumber([m.ctr]);

    if (isCampaignPausedStatus(campaign?.status)) {
      return "Campanha inativa no periodo.";
    }

    if (cost > 0 && units <= 0 && amount <= 0) {
      return "0 vendas no periodo - gasto sem retorno.";
    }

    if (roasCurrent != null && roasTarget != null && roasTarget > 0) {
      if (roasCurrent >= roasTarget) {
        return "ROAS acima da meta, operacao saudavel.";
      }
      const delta = ((roasTarget - roasCurrent) / roasTarget) * 100;
      if (delta >= 30) {
        return `ROAS ${fmtPct(delta, 0)} abaixo do obj.${cpc != null ? ` CPC ${fmtMoney(cpc)}.` : ""}`;
      }
    }

    if (ctr != null && ctr < 0.35) {
      return "CTR baixo, revisar titulo/imagem/criativos.";
    }

    return "Monitorar tendencia e ajustar lances.";
  }

  function calculateCampaignDecisionSummary(campaigns = []) {
    const list = Array.isArray(campaigns) ? campaigns : [];
    const total = list.length;
    let critical = 0;
    let warn = 0;
    let healthy = 0;
    let roasGoal = 0;
    let scale = 0;
    let waste = 0;

    for (const campaign of list) {
      const diagnosis = getCampaignDiagnosis(campaign);
      const decision = getCampaignDecision(campaign);
      const m = campaign?.metrics || {};
      const cost = Number(m.cost || 0);
      const amount = Number(m.total_amount || 0);
      const units = Number(m.units_quantity || 0);
      const roasCurrent = campaignRoasCurrentValue(campaign);
      const roasTarget = campaignRoasTargetValue(campaign);

      if (diagnosis.tone === "bad") critical += 1;
      else if (diagnosis.tone === "warn") warn += 1;
      else if (diagnosis.tone === "good") healthy += 1;

      if (roasCurrent != null && roasTarget != null && roasTarget > 0 && roasCurrent >= roasTarget) {
        roasGoal += 1;
      }
      if (decision.title === "Escalar") scale += 1;
      if (cost > 0 && units <= 0 && amount <= 0) waste += cost;
    }

    return { total, critical, warn, healthy, roasGoal, scale, waste };
  }

  function syncDecisionSections() {
    const list = filterActiveCampaigns(state.campaigns || []);
    const summary = calculateCampaignDecisionSummary(list);
    const roasPct = summary.total > 0 ? Math.round((summary.roasGoal / summary.total) * 100) : 0;

    setText("campaignSummaryTotal", summary.total ? fmtNumber(summary.total) : "-");
    setText("campaignSummaryCritical", summary.total ? `${fmtNumber(summary.critical)} criticas` : "-");
    setText("campaignSummaryHealthy", summary.total ? `${fmtNumber(summary.healthy)} saudaveis` : "-");
    setText("campaignSummaryRisk", summary.total ? fmtMoney(summary.waste) : "-");

    setHtml(
      "healthDiagnosisCount",
      summary.total
        ? `
          <span class="ads-diagnosis-chip is-critical"><strong>${esc(fmtNumber(summary.critical))}</strong><small>criticas</small></span>
          <span class="ads-diagnosis-chip is-warn"><strong>${esc(fmtNumber(summary.warn))}</strong><small>atencao</small></span>
          <span class="ads-diagnosis-chip is-good"><strong>${esc(fmtNumber(summary.healthy))}</strong><small>saudaveis</small></span>
        `
        : `
          <span class="ads-diagnosis-chip is-critical"><strong>-</strong><small>criticas</small></span>
          <span class="ads-diagnosis-chip is-warn"><strong>-</strong><small>atencao</small></span>
          <span class="ads-diagnosis-chip is-good"><strong>-</strong><small>saudaveis</small></span>
        `,
    );
    setText("healthRoasGoalPct", summary.total ? `${roasPct}%` : "-");
    setText(
      "healthRoasGoalText",
      summary.total
        ? `${summary.roasGoal} de ${summary.total} campanhas batem a meta`
        : "campanhas batendo a meta"
    );
    setText("healthWasteValue", summary.total ? fmtMoney(summary.waste) : "-");
    setText("healthScaleCount", summary.total ? `${summary.scale} campanha${summary.scale === 1 ? "" : "s"}` : "-");

    const statusEl = qs("#accountHealthStatus");
    const textEl = qs("#accountHealthText");
    const mainEl = qs("#accountHealthMain");
    const tone =
      !summary.total ? "neutral" :
      summary.critical >= 2 || summary.waste > 0 ? "warn" :
      roasPct >= 70 ? "good" :
      "warn";
    const status =
      !summary.total ? "Sem dados" :
      tone === "good" ? "Saudavel" :
      summary.critical >= 3 ? "Critico" :
      "Atencao";

    if (statusEl) statusEl.textContent = status;
    if (textEl) {
      textEl.textContent = !summary.total
        ? "Atualize o painel para calcular a saude das campanhas do periodo."
        : `Apenas ${roasPct}% das campanhas estao dentro da meta de ROAS. ${summary.critical} campanha${summary.critical === 1 ? "" : "s"} exigem acao prioritaria.`;
    }
    if (mainEl) {
      mainEl.classList.remove("is-good", "is-warn", "is-bad", "is-neutral");
      mainEl.classList.add(`is-${tone}`);
    }

    renderPriorityCards(list);
  }

  function renderPriorityCards(campaigns = []) {
    const wrap = qs("#adsPrioritiesGrid");
    if (!wrap) return;

    const list = Array.isArray(campaigns) ? campaigns : [];
    if (!list.length) {
      wrap.innerHTML = `
        <article class="ads-priority">
          <small>Sem dados</small>
          <h3>Atualize o painel</h3>
          <p>As prioridades serao calculadas com base em ROAS, investimento, vendas e CTR.</p>
        </article>
      `;
      return;
    }

    const sortedByWaste = [...list].sort((a, b) => {
      const ma = a.metrics || {};
      const mb = b.metrics || {};
      const wa = Number(ma.cost || 0) > 0 && Number(ma.units_quantity || 0) <= 0 && Number(ma.total_amount || 0) <= 0 ? Number(ma.cost || 0) : -1;
      const wb = Number(mb.cost || 0) > 0 && Number(mb.units_quantity || 0) <= 0 && Number(mb.total_amount || 0) <= 0 ? Number(mb.cost || 0) : -1;
      return wb - wa;
    });
    const sortedByScale = [...list].sort((a, b) => {
      const ra = campaignRoasCurrentValue(a) || 0;
      const rb = campaignRoasCurrentValue(b) || 0;
      return rb - ra;
    });
    const sortedByCtr = [...list].sort((a, b) => Number((a.metrics || {}).ctr || 999) - Number((b.metrics || {}).ctr || 999));

    const problem = sortedByWaste[0] || list[0];
    const opportunity = sortedByScale[0] || list[0];
    const bottleneck = sortedByCtr[0] || list[0];

    const cards = [
      {
        tone: "is-bad",
        label: "Maior problema",
        title: `${cleanCampaignLabel(problem?.name) || campaignIdOf(problem) || "Campanha"} sem retorno`,
        text: `${fmtMoney((problem?.metrics || {}).cost || 0)} investidos. Revisar ou pausar antes de ampliar verba.`,
      },
      {
        tone: "is-good",
        label: "Maior oportunidade",
        title: `${cleanCampaignLabel(opportunity?.name) || campaignIdOf(opportunity) || "Campanha"} pronta para escalar`,
        text: `ROAS ${fmtRatioX(campaignRoasCurrentValue(opportunity) || 0, 2)}. Avaliar aumento gradual de orcamento.`,
      },
      {
        tone: "is-warn",
        label: "Principal gargalo",
        title: `${cleanCampaignLabel(bottleneck?.name) || campaignIdOf(bottleneck) || "Campanha"} com CTR baixo`,
        text: `CTR ${(bottleneck?.metrics || {}).ctr != null ? fmtPct((bottleneck.metrics || {}).ctr, 2) : "sem dados"}. Revisar imagens, titulo e posicionamento.`,
      },
    ];

    wrap.innerHTML = cards
      .map((card) => `
        <article class="ads-priority ${card.tone}">
          <small>${esc(card.label)}</small>
          <h3>${esc(card.title)}</h3>
          <p>${esc(card.text)}</p>
        </article>
      `)
      .join("");
  }

  function setFocusTone(el, tone) {
    if (!el) return;
    el.classList.remove("is-good", "is-warn", "is-bad", "is-neutral");
    el.classList.add(
      tone === "good" ? "is-good" :
      tone === "warn" ? "is-warn" :
      tone === "bad" ? "is-bad" :
      "is-neutral"
    );
  }

  function setFocusInlineFeedback(message = "", tone = "neutral") {
    const feedback = qs("#focusCampaignInlineFeedback");
    if (!feedback) return;
    feedback.textContent = message || "";
    feedback.classList.remove("is-error", "is-success");
    if (tone === "error") feedback.classList.add("is-error");
    if (tone === "success") feedback.classList.add("is-success");
  }

  function setFocusFieldModalMessage(message = "", tone = "neutral") {
    const el = qs("#focusFieldModalMessage");
    if (!el) return;
    el.textContent = message || "";
    el.classList.remove("is-error", "is-success");
    if (tone === "error") el.classList.add("is-error");
    if (tone === "success") el.classList.add("is-success");
  }

  function setStatusConfirmMessage(message = "", tone = "neutral") {
    const el = qs("#campaignStatusConfirmMessage");
    if (!el) return;
    el.textContent = message || "";
    el.classList.remove("is-error", "is-success");
    if (tone === "error") el.classList.add("is-error");
    if (tone === "success") el.classList.add("is-success");
  }

  function showAdsToast(message, tone = "success") {
    if (!message) return;
    let wrap = qs("#adsToastStack");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "adsToastStack";
      wrap.className = "ads-toast-stack";
      document.body.appendChild(wrap);
    }

    const toast = document.createElement("div");
    toast.className = `ads-toast ${tone === "error" ? "is-error" : "is-success"}`;
    toast.textContent = message;
    wrap.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add("is-leaving");
      window.setTimeout(() => toast.remove(), 220);
    }, 3200);
  }

  function focusFieldModalConfig(field, campaign) {
    const key = field === "roas" ? "roas" : "budget";
    const budget = campaignBudgetValue(campaign);
    const roasTarget = campaignRoasTargetValue(campaign);

    if (key === "budget") {
      const budgetValue = budget != null && isFinite(Number(budget)) ? Number(budget) : null;
      const monthlyLimit =
        budgetValue != null && budgetValue > 0
          ? fmtMoney(budgetValue * 30)
          : "-";

      return {
        field: "budget",
        title: "Altere seu orcamento",
        label: "Orcamento medio diario",
        value: budgetValue != null ? String(budgetValue) : "",
        min: "1",
        step: "1",
        prefix: "R$",
        showPrefix: true,
        hint:
          budgetValue != null && budgetValue > 0
            ? `O consumo por mes nao ultrapassara ${monthlyLimit}.`
            : "Informe um orcamento diario maior que zero.",
      };
    }

    const roasValue =
      roasTarget != null && isFinite(Number(roasTarget)) ? Number(roasTarget) : null;

    return {
      field: "roas",
      title: "Altere seu ROAS objetivo",
      label: "ROAS objetivo",
      value: roasValue != null ? String(roasValue) : "",
      min: "0.1",
      step: "0.1",
      prefix: "",
      showPrefix: false,
      hint: "Defina o retorno minimo esperado por real investido na campanha.",
    };
  }

  function closeFocusFieldModal(force = false) {
    if (state.focusFieldEdit.saving && !force) return;
    const modal = qs("#focusFieldModal");
    if (!modal) return;

    state.focusFieldEdit.open = false;
    state.focusFieldEdit.field = null;
    state.focusFieldEdit.campaignId = null;
    state.focusFieldEdit.saving = false;

    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");

    syncBodyScrollLock();
    setFocusFieldModalMessage("");
  }

  function syncFocusFieldModal() {
    const modal = qs("#focusFieldModal");
    if (!modal || !state.focusFieldEdit.open) return;

    const campaign = getCampaignById(state.focusFieldEdit.campaignId);
    if (!campaign) {
      closeFocusFieldModal(true);
      return;
    }

    const cfg = focusFieldModalConfig(state.focusFieldEdit.field, campaign);
    const titleEl = qs("#focusFieldModalTitle");
    const labelEl = qs("#focusFieldModalLabel");
    const prefixEl = qs("#focusFieldModalPrefix");
    const inputEl = qs("#focusFieldModalInput");
    const hintEl = qs("#focusFieldModalHint");
    const saveBtn = qs("#focusFieldModalSaveBtn");
    const cancelBtn = qs("#focusFieldModalCancelBtn");
    const closeBtn = qs("#focusFieldModalCloseBtn");

    if (titleEl) titleEl.textContent = cfg.title;
    if (labelEl) labelEl.textContent = cfg.label;
    if (hintEl) hintEl.textContent = cfg.hint;
    if (prefixEl) {
      prefixEl.textContent = cfg.prefix;
      prefixEl.hidden = !cfg.showPrefix;
    }

    if (inputEl) {
      if (!state.focusFieldEdit.saving) {
        inputEl.value = cfg.value;
      }
      inputEl.min = cfg.min;
      inputEl.step = cfg.step;
      inputEl.disabled = !!state.focusFieldEdit.saving;
    }

    if (saveBtn) saveBtn.disabled = !!state.focusFieldEdit.saving;
    if (cancelBtn) cancelBtn.disabled = !!state.focusFieldEdit.saving;
    if (closeBtn) closeBtn.disabled = !!state.focusFieldEdit.saving;
  }

  function openFocusFieldModal(field) {
    return openFocusFieldModalForCampaign(field, state.selectedCampaignId);
  }

  function openFocusFieldModalForCampaign(field, campaignId) {
    if (state.focusFieldEdit.saving || state.focusFieldEdit.statusSaving) return;
    const targetCampaignId = String(campaignId || "").trim();
    const campaign = getCampaignById(targetCampaignId);
    const resolvedCampaignId = campaignIdOf(campaign);
    const modal = qs("#focusFieldModal");
    if (!campaign || !resolvedCampaignId || !modal) return;

    state.focusFieldEdit.open = true;
    state.focusFieldEdit.field = field === "roas" ? "roas" : "budget";
    state.focusFieldEdit.campaignId = resolvedCampaignId;
    state.focusFieldEdit.saving = false;

    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    syncBodyScrollLock();
    setFocusFieldModalMessage("");
    setFocusInlineFeedback("");
    syncFocusFieldModal();

    const inputEl = qs("#focusFieldModalInput");
    inputEl?.focus();
    inputEl?.select?.();
  }

  function updateFocusFieldModalHintFromInput() {
    if (!state.focusFieldEdit.open || state.focusFieldEdit.field !== "budget") return;
    const hintEl = qs("#focusFieldModalHint");
    const inputEl = qs("#focusFieldModalInput");
    if (!hintEl || !inputEl) return;

    const n = Number(String(inputEl.value || "").trim().replace(",", "."));
    if (!isFinite(n) || n <= 0) {
      hintEl.textContent = "Informe um orcamento diario maior que zero.";
      return;
    }

    hintEl.textContent = `O consumo por mes nao ultrapassara ${fmtMoney(n * 30)}.`;
  }

  function syncCampaignFocusHeader(campaign = getSelectedCampaign()) {
    const name = qs("#focusCampaignName");
    const toggleBtn = qs("#focusCampaignToggle");
    const stateBadge = qs("#focusCampaignStateBadge");
    const diagnosisEl = qs("#focusCampaignDiagnosis");
    const budgetEl = qs("#focusCampaignBudget");
    const roasTargetEl = qs("#focusCampaignRoasTarget");
    const sponsoredCountEl = qs("#focusCampaignSponsoredCount");
    const budgetQualityEl = qs("#focusBudgetQuality");
    const roasQualityEl = qs("#focusRoasQuality");
    const adsQualityEl = qs("#focusAdsQuality");
    if (!name) return;

    if (!campaign) {
      name.textContent = "Campanha selecionada";
      if (toggleBtn) {
        toggleBtn.disabled = true;
        toggleBtn.setAttribute("aria-checked", "false");
        toggleBtn.classList.remove("is-active", "is-paused");
        qsa(".ads-campaign-focus__toggle-text", toggleBtn).forEach((el) => {
          el.textContent = "";
          el.setAttribute("aria-hidden", "true");
          el.style.display = "none";
        });
      }
      if (stateBadge) stateBadge.textContent = "-";
      if (diagnosisEl) diagnosisEl.textContent = "Sem dados";
      if (budgetEl) budgetEl.textContent = "-";
      if (roasTargetEl) roasTargetEl.textContent = "-";
      if (sponsoredCountEl) sponsoredCountEl.textContent = "-";
      if (budgetQualityEl) budgetQualityEl.textContent = "-";
      if (roasQualityEl) roasQualityEl.textContent = "-";
      if (adsQualityEl) adsQualityEl.textContent = "-";
      setFocusTone(stateBadge, "neutral");
      setFocusTone(diagnosisEl, "neutral");
      setFocusTone(budgetQualityEl, "neutral");
      setFocusTone(roasQualityEl, "neutral");
      setFocusTone(adsQualityEl, "neutral");
      if (state.focusFieldEdit.open) {
        closeFocusFieldModal();
      }
      setFocusInlineFeedback("");
      return;
    }

    const campaignLabel = cleanCampaignLabel(campaign.name) || campaignIdOf(campaign) || "Campanha selecionada";
    const statusRaw = String(campaign.status || "unknown").toLowerCase();
    const isActive = isCampaignActiveStatus(statusRaw);
    const isPaused = isCampaignPausedStatus(statusRaw);
    const statusText =
      isActive
        ? "ATIVA"
        : isPaused
        ? "PAUSADA"
        : String(campaign.status || "DESCONHECIDO").toUpperCase();

    const diagnosis = getCampaignDiagnosis(campaign);
    const budget = campaignBudgetValue(campaign);
    const roasTarget = campaignRoasTargetValue(campaign);
    const sponsoredCount = campaignSponsoredCountValue(campaign);

    name.textContent = campaignLabel;
    if (toggleBtn) {
      toggleBtn.disabled =
        state.focusFieldEdit.saving ||
        state.focusFieldEdit.statusSaving ||
        state.statusConfirm.open ||
        state.statusConfirm.saving;
      toggleBtn.setAttribute("aria-checked", isActive ? "true" : "false");
      toggleBtn.classList.remove("is-active", "is-paused");
      if (isActive) toggleBtn.classList.add("is-active");
      else if (isPaused) toggleBtn.classList.add("is-paused");
        qsa(".ads-campaign-focus__toggle-text", toggleBtn).forEach((el) => {
          el.textContent = "";
          el.setAttribute("aria-hidden", "true");
          el.style.display = "none";
        });
    }

    if (stateBadge) {
      stateBadge.textContent = statusText;
      setFocusTone(
        stateBadge,
        isActive
          ? "good"
          : isPaused
          ? "bad"
          : "neutral"
      );
    }

    if (diagnosisEl) {
      diagnosisEl.textContent = diagnosis.label;
      setFocusTone(diagnosisEl, diagnosis.tone);
    }

    if (budgetEl) budgetEl.textContent = budget != null ? fmtMoney(budget) : "-";
    if (roasTargetEl) roasTargetEl.textContent = roasTarget != null ? fmtRatioX(roasTarget, 2) : "-";
    if (sponsoredCountEl) sponsoredCountEl.textContent = sponsoredCount != null ? fmtNumber(sponsoredCount) : "-";

    if (budgetQualityEl) {
      budgetQualityEl.textContent = budget != null && budget > 0 ? "BOM" : "REVER";
      setFocusTone(budgetQualityEl, budget != null && budget > 0 ? "good" : "warn");
    }
    if (roasQualityEl) {
      roasQualityEl.textContent = roasTarget != null && roasTarget > 0 ? "BOM" : "REVER";
      setFocusTone(roasQualityEl, roasTarget != null && roasTarget > 0 ? "good" : "warn");
    }
    if (adsQualityEl) {
      adsQualityEl.textContent = sponsoredCount != null && sponsoredCount > 0 ? "BOM" : "ATENCAO";
      setFocusTone(adsQualityEl, sponsoredCount != null && sponsoredCount > 0 ? "good" : "warn");
    }
  }

  function syncWorkspaceTabs() {
    const focusOn = !!state.focusMode;
    const activeTab = state.activeTab || "overview";
    const campaignTab = state.campaignTab || "campaign-overview";

    const workspaceTabs = qs("#adsWorkspaceTabs");
    const campaignTabs = qs("#campaignWorkspaceTabs");
    const focusHeader = qs("#campaignFocusHeader");
    const overview = qs("#adsOverviewSection");
    const signals = qs("#adsOverviewSignals");
    const ranking = qs("#adsRankingSection");
    const globalAds = qs("#adsGlobalAdsSection");
    const evolution = qs("#adsEvolutionSection");
    const detail = qs("#adsDetailSection");
    const metricField = qs("[data-graph-control='1']");
    const compareControl = qs(".ads-compare-control");
    const periodDivider = qs(".ads-period-divider");
    const showCompare = focusOn
      ? campaignTab === "campaign-overview" || campaignTab === "campaign-evolution"
      : activeTab === "overview";

    if (compareControl) compareControl.hidden = !showCompare;
    if (periodDivider) periodDivider.hidden = !showCompare;
    if (workspaceTabs) workspaceTabs.hidden = focusOn;
    if (campaignTabs) campaignTabs.hidden = !focusOn;
    if (focusHeader) focusHeader.hidden = !focusOn;
    document.body.classList.toggle("ads-campaign-workspace", focusOn);

    qsa("[data-ads-tab]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-ads-tab") === activeTab);
    });
    qsa("[data-campaign-tab]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-campaign-tab") === campaignTab);
    });

    if (!focusOn) {
      if (overview) overview.hidden = activeTab !== "overview";
      if (signals) signals.hidden = activeTab !== "overview";
      if (evolution) evolution.hidden = activeTab !== "overview";
      if (ranking) ranking.hidden = activeTab !== "campaigns";
      if (globalAds) globalAds.hidden = activeTab !== "ads";
      if (detail) detail.hidden = true;
      if (metricField) metricField.hidden = activeTab !== "overview";
      syncCampaignFocusHeader(null);
    } else {
      if (overview) overview.hidden = campaignTab !== "campaign-overview";
      if (signals) signals.hidden = true;
      if (ranking) ranking.hidden = true;
      if (globalAds) globalAds.hidden = true;
      if (detail) detail.hidden = campaignTab !== "campaign-ads";
      if (evolution) evolution.hidden = campaignTab !== "campaign-evolution";
      if (metricField) metricField.hidden = campaignTab !== "campaign-evolution";
      syncCampaignFocusHeader(getSelectedCampaign() || null);
    }
  }

  async function setWorkspaceTab(tab) {
    const allowed = new Set(["overview", "campaigns", "ads"]);
    state.activeTab = allowed.has(tab) ? tab : "overview";
    syncWorkspaceTabs();
    if (state.activeTab === "ads") await carregarGlobalAds();
    if (state.activeTab === "overview" && !state.dailySeries.length) {
      await carregarMetricasDiarias();
    }
  }

  async function setCampaignTab(tab) {
    const allowed = new Set(["campaign-overview", "campaign-ads", "campaign-evolution"]);
    state.campaignTab = allowed.has(tab) ? tab : "campaign-overview";
    syncWorkspaceTabs();
    if (state.campaignTab === "campaign-ads" && state.selectedCampaignId) {
      await carregarItensCampanha(state.selectedCampaignId);
    }
    if (state.campaignTab === "campaign-evolution" && state.selectedCampaignId) {
      state.chartScope = "campaign";
      syncChartHeader();
      await carregarMetricasDiarias({ campaignId: state.selectedCampaignId });
    }
  }

  function syncCampaignFocusMode() {
    const focusOn = !!state.focusMode;
    const premiumTitle = qs("#premiumTitle");
    const premiumSubtitle = qs("#premiumSubtitle");

    if (!focusOn) {
      if (premiumTitle) premiumTitle.textContent = uiDefaults.premiumTitle;
      if (premiumSubtitle) premiumSubtitle.textContent = uiDefaults.premiumSubtitle;
      if (!state.pendingFocusCampaignId) updateCampaignParamInUrl(null);
    } else {
      if (premiumTitle) premiumTitle.textContent = "Performance da campanha";
      if (premiumSubtitle) premiumSubtitle.textContent = "Retorno, investimento e eficiencia da campanha no periodo selecionado.";
      updateCampaignParamInUrl(state.selectedCampaignId || null);
    }
    syncWorkspaceTabs();
  }

  async function openCampaignWorkspace(campaignId, opts = {}) {
    const id = String(campaignId || "");
    if (!id) return;

    if (opts.navigate === true && !isDedicatedCampaignRoute()) {
      window.location.assign(publicidadeCampaignPath(id));
      return;
    }

    state.focusMode = true;
    state.campaignTab = "campaign-overview";
    selecionarCampanha(id, { rowEl: opts.rowEl || null, scroll: false });
    syncCampaignFocusMode();
    atualizarResumoGeral();

    state.chartScope = "campaign";
    syncCampaignActions();
    syncChartHeader();
    await carregarMetricasDiarias({ campaignId: id });

    if (!opts.skipScroll) {
      const anchor = qs("#campaignFocusHeader") || qs("#campaignChartCard");
      anchor?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }
  }

  async function closeCampaignWorkspace() {
    if (isDedicatedCampaignRoute()) {
      window.location.assign(publicidadeOverviewPath());
      return;
    }

    state.focusMode = false;
    state.activeTab = "campaigns";
    syncCampaignFocusMode();
    atualizarResumoGeral();

    state.chartScope = "overall";
    syncCampaignActions();
    syncChartHeader();
    await carregarMetricasDiarias();

    qs("#adsRankingSection")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  function syncCampaignActions() {
    const hasCampaign = !!getSelectedCampaign();
    const btnExport = $btnExport();
    const btnAddItems = qs("#btnOpenAddItems");
    const btnShowChart = qs("#btnShowCampaignChart");
    const btnBackToOverview = qs("#btnBackToOverview");

    if (btnExport) btnExport.disabled = !hasCampaign;
    if (btnAddItems) btnAddItems.disabled = !hasCampaign;
    if (btnShowChart) btnShowChart.disabled = !hasCampaign;
    if (btnShowChart) {
      btnShowChart.classList.toggle(
        "is-active",
        state.chartScope === "campaign" && hasCampaign
      );
    }
    if (btnBackToOverview) {
      btnBackToOverview.hidden = state.focusMode || state.chartScope !== "campaign";
    }
  }

  function syncItemsHeader(campaign) {
    const title = qs("#itemsTitle");
    const subtitle = qs("#itemsSubtitle");
    if (!title || !subtitle) return;

    if (!campaign) {
      title.textContent = "Itens patrocinados";
      subtitle.textContent =
        "Abra uma campanha para visualizar os anuncios patrocinados e agir na operacao.";
      return;
    }

    title.textContent = "Itens patrocinados";
    subtitle.textContent =
      "Detalhe operacional com qualidade, eficiencia e retorno dos anuncios no periodo selecionado.";
  }

  function syncChartCompareToggle() {
    const input = qs("#chartComparePrev");
    if (!input) return;
    input.checked = !!state.chartCompareEnabled;
    input.setAttribute("aria-checked", state.chartCompareEnabled ? "true" : "false");
  }

  function syncChartMetricTabs() {
    const tabsWrap = qs(".ads-chart-tabs");
    if (tabsWrap) {
      const palette = chartPalette(state.metric || "total_amount");
      tabsWrap.style.setProperty("--metric-accent", palette?.line || "#3483fa");
    }
    qsa("[data-chart-metric]").forEach((btn) => {
      const metric = String(btn.getAttribute("data-chart-metric") || "");
      const active = metric === state.metric;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function syncDailyGranularityButtons() {
    const granularity = state.dailyGranularity === "weekly" ? "weekly" : "daily";
    qsa("[data-daily-granularity]").forEach((btn) => {
      const value = String(btn.getAttribute("data-daily-granularity") || "daily");
      const active = value === granularity;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    const periodHeader = qs("#dailyPeriodHeader");
    if (periodHeader) periodHeader.textContent = granularity === "weekly" ? "Semana" : "Dia";
  }

  function syncChartHeader() {
    const hint = qs("#chartHint");
    const period = qs("#premiumPeriod");
    const badge = qs("#chartScopeBadge");
    const chartCard = qs("#campaignChartCard");
    const campaign = getSelectedCampaign();
    const isCampaignScope = state.chartScope === "campaign" && !!campaign;

    if (!hint || !period) return;

    const hasPreviousSeries =
      Array.isArray(state.dailySeriesPrevious) && state.dailySeriesPrevious.length > 0;
    const compareLabel = compareModeShortLabel();
    const compareStatusSuffix = state.chartCompareEnabled
      ? hasPreviousSeries
        ? ` | linha tracejada = ${compareLabel}`
        : ` | ${compareLabel} sem dados`
      : " | comparativo desativado";

    if (isCampaignScope) {
      hint.textContent = `Grafico diario da campanha selecionada${compareStatusSuffix}`;
      period.textContent = `Periodo: ${state.date_from || "-"} a ${state.date_to || "-"}`;
      if (badge) badge.textContent = `Campanha ativa`;
    } else {
      hint.textContent = `X = dias do mes | Y = valores${compareStatusSuffix}`;
      period.textContent = `Periodo: ${state.date_from || "-"} a ${state.date_to || "-"}`;
      if (badge) badge.textContent = "Visao geral";
    }

    if (chartCard) {
      chartCard.classList.toggle("is-campaign-scope", isCampaignScope);
    }
    syncChartCompareToggle();
    syncChartMetricTabs();
    syncDailyGranularityButtons();
  }

  // ==========================================
  // UI helpers: pills + selecao de linha (ranking)
  // ==========================================
  function pillStatus(statusRaw) {
    const s = String(statusRaw || "").toLowerCase();
    const label = statusRaw ? String(statusRaw) : "-";

    if (s === "active" || s === "enabled" || s === "on") {
      return `<span class="pill pill--active">* ${esc(label)}</span>`;
    }
    if (s === "paused" || s === "disabled" || s === "off") {
      return `<span class="pill pill--paused">* ${esc(label)}</span>`;
    }
    return `<span class="pill">${esc(label)}</span>`;
  }

  function pillStrategy(strategyRaw) {
    const s = String(strategyRaw || "").toLowerCase();
    const label = strategyRaw ? String(strategyRaw) : "-";

    if (s.includes("profit"))
      return `<span class="pill pill--profit">${esc(label)}</span>`;
    if (s.includes("increase"))
      return `<span class="pill pill--inc">${esc(label)}</span>`;
    return `<span class="pill">${esc(label)}</span>`;
  }

  function tableEditIconSvg() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 17.2V21h3.8l11-11-3.8-3.8-11 11zm17.7-10.2a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8 1.7-1.9z"></path>
      </svg>
    `;
  }

  function setSelectedCampaignRow(trEl) {
    const tbody = $campBody();
    if (!tbody || !trEl) return;

    qsa(
      'tr[data-camp-id].is-selected, tr[data-camp-id][aria-selected="true"]',
      tbody
    ).forEach((tr) => {
      tr.classList.remove("is-selected");
      tr.removeAttribute("aria-selected");
      tr.tabIndex = -1;
    });

    trEl.classList.add("is-selected");
    trEl.setAttribute("aria-selected", "true");
    trEl.tabIndex = 0;

    state.selectedRowEl = trEl;
  }

  // ==========================================
  // KPIs (premium) - baseado nas campaigns
  // ==========================================
  function buildKpiSummaryFromCampaigns(list = []) {
    let clicks = 0;
    let prints = 0;
    let cost = 0;
    let units = 0;
    let amount = 0;
    let tacosSalesBase = 0;

    for (const c of Array.isArray(list) ? list : []) {
      const m = c.metrics || {};
      const campaignCost = Number(m.cost || 0);
      const campaignTacos = Number(m.tacos);
      clicks += Number(m.clicks || 0);
      prints += Number(m.prints || 0);
      cost += campaignCost;
      units += Number(m.units_quantity || 0);
      amount += Number(m.total_amount || 0);
      if (Number.isFinite(campaignTacos) && campaignTacos > 0 && campaignCost > 0) {
        tacosSalesBase += campaignCost / (campaignTacos / 100);
      }
    }

    const ctr = prints > 0 ? (clicks / prints) * 100 : 0;
    const acos = amount > 0 ? (cost / amount) * 100 : 0;
    const roas = cost > 0 ? amount / cost : 0;
    const cpc = clicks > 0 ? cost / clicks : 0;
    const tacos = tacosSalesBase > 0 ? (cost / tacosSalesBase) * 100 : null;

    return { clicks, prints, cost, units, amount, ctr, acos, roas, cpc, tacos };
  }

  function normalizeKpiSummary(summary = {}) {
    const clicks = Number(summary.clicks || 0);
    const prints = Number(summary.prints || 0);
    const cost = Number(summary.cost || 0);
    const amount = Number(summary.amount ?? summary.total_amount ?? 0);
    const units = Number(summary.units ?? summary.units_quantity ?? 0);
    const ctr = summary.ctr != null ? Number(summary.ctr || 0) : prints > 0 ? (clicks / prints) * 100 : 0;
    const acos = summary.acos != null ? Number(summary.acos || 0) : amount > 0 ? (cost / amount) * 100 : 0;
    const roas = summary.roas != null ? Number(summary.roas || 0) : cost > 0 ? amount / cost : 0;
    const cpc = summary.cpc != null ? Number(summary.cpc || 0) : clicks > 0 ? cost / clicks : 0;
    const tacos = summary.tacos != null && Number.isFinite(Number(summary.tacos))
      ? Number(summary.tacos)
      : null;
    return { clicks, prints, cost, units, amount, ctr, acos, roas, cpc, tacos };
  }

  function percentageDelta(current, previous) {
    const cur = Number(current);
    const prev = Number(previous);
    if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
    return ((cur - prev) / Math.abs(prev)) * 100;
  }

  function setKpiDeltaFoot(id, current, previous, opts = {}) {
    const el = qs(`#${id}`);
    if (!el) return;

    const delta = percentageDelta(current, previous);
    if (delta == null) {
      el.textContent = opts.fallback || "Sem comparativo anterior";
      el.classList.remove("is-up", "is-down", "is-neutral");
      return;
    }

    const lowerIsGood = !!opts.lowerIsGood;
    const isUp = delta > 0;
    const isDown = delta < 0;
    const good = lowerIsGood ? isDown : isUp;
    const bad = lowerIsGood ? isUp : isDown;
    const tone = Math.abs(delta) < 0.05 ? "is-neutral" : good ? "is-up" : bad ? "is-down" : "is-neutral";
    const arrow = isUp ? "&uarr;" : isDown ? "&darr;" : "";
    const signal = delta > 0 ? "+" : "";
    const label = opts.label || "vs anterior";

    el.classList.remove("is-up", "is-down", "is-neutral");
    el.classList.add(tone);
    el.innerHTML = `<span class="kpi-delta-arrow">${arrow}</span> ${signal}${fmtPct(delta, 1)} ${esc(label)}`;
  }

  function syncKpiComparison(currentSummary) {
    const previous = state.previousKpiSummary;
    if (!previous) {
      [
        ["kpiRevenueFoot", "Total do periodo"],
        ["kpiCostFoot", "Total do periodo"],
        ["kpiRoasFoot", "Media do periodo"],
        ["kpiAcosFoot", "Media do periodo"],
        ["kpiTacosFoot", "Media do periodo"],
        ["kpiAdSalesFoot", "Somatorio"],
        ["kpiClicksFoot", "Somatorio"],
        ["kpiPrintsFoot", "Somatorio"],
        ["kpiCtrFoot", "Media do periodo"],
        ["kpiCpcFoot", "Media do periodo"],
      ].forEach(([id, text]) => {
        const el = qs(`#${id}`);
        if (!el) return;
        el.classList.remove("is-up", "is-down", "is-neutral");
        el.textContent = text;
      });
      return;
    }

    const label = `vs ${compareModeShortLabel()}`;
    setKpiDeltaFoot("kpiRevenueFoot", currentSummary.amount, previous.amount, { label });
    setKpiDeltaFoot("kpiCostFoot", currentSummary.cost, previous.cost, { label });
    setKpiDeltaFoot("kpiRoasFoot", currentSummary.roas, previous.roas, { label });
    setKpiDeltaFoot("kpiAcosFoot", currentSummary.acos, previous.acos, { label, lowerIsGood: true });
    setKpiDeltaFoot("kpiTacosFoot", currentSummary.tacos, previous.tacos, { label, lowerIsGood: true, fallback: `Sem dados no ${compareModeShortLabel()}` });
    setKpiDeltaFoot("kpiAdSalesFoot", currentSummary.units, previous.units, { label });
    setKpiDeltaFoot("kpiClicksFoot", currentSummary.clicks, previous.clicks, { label });
    setKpiDeltaFoot("kpiPrintsFoot", currentSummary.prints, previous.prints, { label });
    setKpiDeltaFoot("kpiCtrFoot", currentSummary.ctr, previous.ctr, { label });
    setKpiDeltaFoot("kpiCpcFoot", currentSummary.cpc, previous.cpc, { label, lowerIsGood: true });
  }

  function syncBudgetProjection() {
    const campaigns = state.campaigns || [];
    const { total: dailyBudgetTotal, count: budgetCampaignsCount } =
      calculateActiveDailyBudget(campaigns);
    const rangeSummary = state.currentRangeSummary;
    const from = state.date_from || null;
    const to = state.date_to || null;
    const elapsedDays =
      from && to ? Math.max(1, daysBetweenInclusive(from, to)) : null;
    const projectedDays = elapsedDays;
    const rangeCost =
      rangeSummary && Number.isFinite(Number(rangeSummary.cost))
        ? Number(rangeSummary.cost)
        : null;
    const avgDailyInvestment =
      rangeCost != null && elapsedDays > 0 ? rangeCost / elapsedDays : null;
    const projectedInvestment =
      avgDailyInvestment != null && projectedDays != null
        ? avgDailyInvestment * projectedDays
        : null;

    setText(
      "budgetProjectionRange",
      from && to
        ? `${formatPeriodRange(from, to)} (${elapsedDays}/${projectedDays} dias)`
        : "Periodo nao definido",
    );
    setText("budgetDailyTotal", dailyBudgetTotal > 0 ? fmtMoney(dailyBudgetTotal) : "-");
    setText(
      "budgetDailyTotalFoot",
      budgetCampaignsCount > 0
        ? `${fmtNumber(budgetCampaignsCount)} campanha${budgetCampaignsCount === 1 ? "" : "s"} com verba ativa`
        : "Sem orcamento ativo identificado",
    );
    setText(
      "budgetAvgDailyInvestment",
      avgDailyInvestment != null ? fmtMoney(avgDailyInvestment) : "-",
    );
    setText(
      "budgetAvgDailyInvestmentFoot",
      rangeCost != null
        ? `${fmtMoney(rangeCost)} investidos no periodo`
        : "Sem investimento no periodo selecionado",
    );
    setText(
      "budgetMonthlyProjection",
      projectedInvestment != null ? fmtMoney(projectedInvestment) : "-",
    );
    setText(
      "budgetMonthlyProjectionFoot",
      projectedInvestment != null
        ? `Ritmo medio do periodo em ${fmtNumber(projectedDays)} dia${projectedDays === 1 ? "" : "s"}`
        : "Atualize o painel para projetar",
    );
  }

  function atualizarResumoGeral() {
    const list = state.campaigns || [];
    const focusCampaign = state.focusMode ? getSelectedCampaign() : null;

    const normalizedCurrent = focusCampaign
      ? normalizeKpiSummary(focusCampaign.metrics || {})
      : buildKpiSummaryFromCampaigns(list);
    const clicks = normalizedCurrent.clicks;
    const prints = normalizedCurrent.prints;
    const cost = normalizedCurrent.cost;
    const units = normalizedCurrent.units;
    const amount = normalizedCurrent.amount;
    const ctr = normalizedCurrent.ctr;
    const acos = normalizedCurrent.acos;
    const roas = normalizedCurrent.roas;
    const cpc = normalizedCurrent.cpc;

    // novos ids (premium)
    setText("kpiRevenue", fmtMoney(amount));
    setText("kpiCost", fmtMoney(cost));
    setText("kpiRoas", fmtRatioX(roas || 0, 2));
    setText("kpiAcos", fmtPct(acos, 2));
    setText("kpiTacos", normalizedCurrent.tacos != null ? fmtPct(normalizedCurrent.tacos, 2) : "-");
    setText("kpiAdSales", fmtNumber(units));
    setText("kpiClicks", fmtNumber(clicks));
    setText("kpiPrints", fmtNumber(prints));
    setText("kpiCtr", fmtPct(ctr, 2));
    setText("kpiCpc", cpc ? fmtMoney(cpc) : "-");

    // compat (se ainda existirem ids antigos na pagina - nao atrapalha)
    setTextAny(["sumCost"], fmtMoney(cost));
    setTextAny(["sumClicks"], fmtNumber(clicks));
    setTextAny(["sumPrints"], fmtNumber(prints));
    setTextAny(["avgCtr"], fmtPct(ctr));
    setTextAny(["avgAcos"], fmtPct(acos));
    setTextAny(["avgRoas"], fmtRatioX(roas || 0, 2));
    setTextAny(["sumUnits"], fmtNumber(units));
    setTextAny(["sumAmount"], fmtMoney(amount));

    syncKpiComparison(normalizedCurrent);
    syncBudgetProjection();
    syncDecisionSections();
  }

  // ==========================================
  // Fetch - campanhas (ranking)
  // ==========================================
  async function carregarResumoRangeViaCampanhas(from, to) {
    const url = withBase(
      `/api/publicidade/product-ads/campaigns?date_from=${encodeURIComponent(
        from
      )}&date_to=${encodeURIComponent(to)}`
    );

    try {
      const r = await fetch(url, { credentials: "same-origin" });
      const txt = await r.text().catch(() => "");
      if (!r.ok) return null;
      const data = txt ? JSON.parse(txt) : {};
      const campaigns = Array.isArray(data.campaigns) ? data.campaigns : [];
      const summary = buildKpiSummaryFromCampaigns(campaigns);
      return normalizeKpiSummary(summary);
    } catch {
      return null;
    }
  }

  async function carregarResumoPeriodoAnterior(from, to) {
    const previousRange = buildPreviousRange(from, to);
    if (!previousRange) return null;

    const summaryUrl = withBase(
      `/api/publicidade/product-ads/summary?date_from=${encodeURIComponent(
        previousRange.from
      )}&date_to=${encodeURIComponent(previousRange.to)}`
    );

    try {
      const r = await fetch(summaryUrl, { credentials: "same-origin" });
      const txt = await r.text().catch(() => "");
      if (r.ok) {
        const data = txt ? JSON.parse(txt) : {};
        const summary = data.summary || data;
        return normalizeKpiSummary(summary || {});
      }
      console.warn(
        "Sem resumo consolidado do periodo anterior (fallback em campanhas):",
        r.status,
        txt
      );
    } catch (err) {
      console.warn(
        "Falha no resumo consolidado do periodo anterior (fallback em campanhas):",
        err?.message || err
      );
    }

    return carregarResumoRangeViaCampanhas(previousRange.from, previousRange.to);
  }

  async function carregarResumoPeriodoAtual(campaignsFallback = []) {
    const from = state.date_from || null;
    const to = state.date_to || null;
    if (!from || !to) return null;

    const summaryUrl = withBase(
      `/api/publicidade/product-ads/summary?date_from=${encodeURIComponent(
        from
      )}&date_to=${encodeURIComponent(to)}`
    );

    try {
      const r = await fetch(summaryUrl, { credentials: "same-origin" });
      const txt = await r.text().catch(() => "");
      if (r.ok) {
        const data = txt ? JSON.parse(txt) : {};
        const summary = data.summary || data;
        return normalizeKpiSummary(summary || {});
      }
      console.warn("Sem resumo do periodo atual para projecao:", r.status, txt);
    } catch (err) {
      console.warn("Falha no resumo do periodo atual para projecao:", err?.message || err);
    }

    return buildKpiSummaryFromCampaigns(campaignsFallback);
  }

  async function carregarCampanhas() {
    const tbody = $campBody();
    const itemsBody = $itemsBody();
    const { from, to } = getDateRange();
    state.date_from = from;
    state.date_to = to;
    state.currentRangeSummary = null;
    state.globalAds.loadedRangeKey = "";

    syncPeriodLabels(from, to);
    syncBudgetProjection();
    setLoadingTable(tbody, `Carregando campanhas de ${from} ate ${to}...`);

    const url = withBase(
      `/api/publicidade/product-ads/campaigns?date_from=${encodeURIComponent(
        from
      )}&date_to=${encodeURIComponent(to)}`
    );

    try {
      const r = await fetch(url, { credentials: "same-origin" });
      const txt = await r.text().catch(() => "");

      if (!r.ok) {
        console.error("Erro ao carregar campanhas:", r.status, txt);
        if (tbody) {
          tbody.innerHTML = `<tr><td colspan="99" class="muted">Falha ao carregar campanhas (HTTP ${r.status}).</td></tr>`;
        }
        state.campaigns = [];
        state.previousKpiSummary = null;
        state.currentRangeSummary = null;
        state.selectedCampaignId = null;
        atualizarResumoGeral();
        syncCampaignActions();
        return;
      }

      const data = txt ? JSON.parse(txt) : {};
      const rawCampaigns = Array.isArray(data.campaigns) ? data.campaigns : [];
      const campaigns = rawCampaigns;
      state.campaigns = campaigns;
      const [previousKpiSummary, currentRangeSummary] = await Promise.all([
        carregarResumoPeriodoAnterior(from, to),
        carregarResumoPeriodoAtual(campaigns),
      ]);
      state.previousKpiSummary = previousKpiSummary;
      state.currentRangeSummary = currentRangeSummary;

      if (!campaigns.length) {
        state.selectedCampaignId = null;
        renderCampanhas();
        atualizarResumoGeral();
        syncCampaignActions();
        syncItemsHeader(null);

        if (itemsBody) {
          itemsBody.innerHTML = `<tr><td colspan="7" class="muted">Nenhuma campanha encontrada no periodo.</td></tr>`;
        }

        if (state.focusMode) {
          state.focusMode = false;
          syncCampaignFocusMode();
        }

        const btn = $btnExport();
        if (btn) btn.disabled = true;
        return;
      }

      if (state.pendingFocusCampaignId) {
        const pendingId = String(state.pendingFocusCampaignId);
        const pendingCampaign = campaigns.find(
          (campaign) => campaignIdOf(campaign) === pendingId
        );
        state.pendingFocusCampaignId = null;

        if (pendingCampaign) {
          state.selectedCampaignId = campaignIdOf(pendingCampaign);
          renderCampanhas();
          atualizarResumoGeral();
          syncCampaignActions();
          await openCampaignWorkspace(state.selectedCampaignId, {
            skipScroll: true,
          });
          return;
        }

        state.focusMode = false;
        updateCampaignParamInUrl(null);
      }

      if (!state.focusMode) {
        syncCampaignFocusMode();
        state.selectedCampaignId = null;
        state.selectedRowEl = null;
        renderCampanhas();
        atualizarResumoGeral();
        syncCampaignActions();
        syncItemsHeader(null);

        const pag = $pagination();
        if (pag) pag.innerHTML = "";
        if (itemsBody) {
          itemsBody.innerHTML = `<tr><td colspan="7" class="muted">Abra uma campanha para visualizar os itens.</td></tr>`;
        }
        return;
      }

      const hasSelected = campaigns.some(
        (c) => campaignIdOf(c) === String(state.selectedCampaignId)
      );
      if (!hasSelected) {
        state.selectedCampaignId = campaignIdOf(campaigns[0]) || null;
      }

      renderCampanhas();
      atualizarResumoGeral();
      syncCampaignActions();

      if (!state.selectedCampaignId) {
        syncItemsHeader(null);
        return;
      }

      const tbodyNow = $campBody();
      const tr = tbodyNow?.querySelector(
        `tr[data-camp-id="${CSS.escape(String(state.selectedCampaignId))}"]`
      );
      if (tr) setSelectedCampaignRow(tr);
      carregarItensCampanha(String(state.selectedCampaignId));
    } catch (e) {
      console.error("Erro inesperado ao buscar campanhas:", e);
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="99" class="muted">Erro ao buscar campanhas (ver console).</td></tr>`;
      }
      syncCampaignActions();
    }
  }

  function campaignSortValue(campaign, key) {
    const m = campaign?.metrics || {};
    if (key === "roas") return campaignRoasCurrentValue(campaign) ?? -Infinity;
    if (key === "acos") {
      const cost = Number(m.cost || 0);
      const amount = Number(m.total_amount || 0);
      return m.acos != null ? Number(m.acos) : amount > 0 ? (cost / amount) * 100 : 0;
    }
    if (key === "cost") return Number(m.cost || 0);
    if (key === "sales") return Number(m.units_quantity || 0);
    if (key === "criticality") {
      const diagnosis = getCampaignDiagnosis(campaign);
      if (diagnosis.tone === "bad") return 3;
      if (diagnosis.tone === "warn") return 2;
      if (diagnosis.tone === "neutral") return 1;
      return 0;
    }
    return 0;
  }

  function sortedCampaignsForRender(list = []) {
    const sort = state.campaignSort || { key: "criticality", dir: "desc" };
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = campaignSortValue(a, sort.key);
      const vb = campaignSortValue(b, sort.key);
      if (va === vb) return String(a?.name || "").localeCompare(String(b?.name || ""));
      return va > vb ? dir : -dir;
    });
  }

  function campaignHealthFilterKey(campaign) {
    const diagnosis = getCampaignDiagnosis(campaign);
    if (diagnosis.tone === "bad") return "critical";
    if (diagnosis.tone === "warn") return "attention";
    return "healthy";
  }

  function filteredCampaignsForRender() {
    const query = String(qs("#campaignSearchInput")?.value || "").trim().toLowerCase();
    const statusFilter = String(qs("#campaignStatusFilter")?.value || "all");
    const healthFilter = String(qs("#campaignHealthFilter")?.value || "all");
    return (state.campaigns || []).filter((campaign) => {
      if (query && !String(campaign?.name || campaignIdOf(campaign)).toLowerCase().includes(query)) return false;
      if (statusFilter === "active" && !isActiveCampaign(campaign)) return false;
      if (statusFilter === "paused" && !isCampaignPausedStatus(campaignStatusOf(campaign))) return false;
      if (healthFilter !== "all" && campaignHealthFilterKey(campaign) !== healthFilter) return false;
      return true;
    });
  }

  function renderCampanhas() {
    const tbody = $campBody();
    if (!tbody) return;
    const source = state.campaigns || [];
    const list = filteredCampaignsForRender();
    if (!source.length) {
      tbody.innerHTML = `<tr><td colspan="10" class="muted">Nenhuma campanha encontrada no periodo selecionado.</td></tr>`;
      return;
    }
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="10" class="muted">Nenhuma campanha corresponde aos filtros atuais.</td></tr>`;
      return;
    }

    tbody.innerHTML = sortedCampaignsForRender(list).map((c) => {
      const campaignId = campaignIdOf(c);
      if (!campaignId) return "";
      const m = c.metrics || {};
      const cost = Number(m.cost || 0);
      const totalAmount = Number(m.total_amount || 0);
      const units = Number(m.units_quantity || 0);
      const roas = Number.isFinite(Number(m.roas)) ? Number(m.roas) : (cost > 0 ? totalAmount / cost : 0);
      const acos = Number.isFinite(Number(m.acos)) ? Number(m.acos) : (totalAmount > 0 ? cost / totalAmount * 100 : 0);
      const target = campaignRoasTargetValue(c);
      const budget = campaignBudgetValue(c);
      const diagnosis = getCampaignDiagnosis(c);
      const active = isActiveCampaign(c);
      const paused = isCampaignPausedStatus(campaignStatusOf(c));
      const countRaw = campaignSponsoredCountValue(c);
      const count = countRaw != null && Number.isFinite(Number(countRaw)) ? Number(countRaw) : null;
      const subline = count != null ? `${fmtNumber(count)} anuncios patrocinados` : "Anuncios patrocinados";
      const selected = String(state.selectedCampaignId || "") === campaignId;
      const diagnosisClass = diagnosis.tone === "good" ? "good" : diagnosis.tone === "warn" ? "warn" : diagnosis.tone === "bad" ? "bad" : "";

      return `<tr data-camp-id="${esc(campaignId)}" tabindex="${selected ? "0" : "-1"}" aria-selected="${selected ? "true" : "false"}" class="${selected ? "is-selected" : ""}">
        <td class="sticky-col ads-campaign-cell ads-campaign-cell--name">
          <div class="camp-name"><span class="camp-title">${esc(cleanCampaignLabel(c.name) || campaignId)}</span><span class="camp-sub__line">${esc(subline)}</span></div>
        </td>
        <td class="ads-campaign-cell ads-campaign-cell--status">
          <div class="ads-table-status-cell ads-table-status-cell--toggle">
            <button type="button" class="ads-campaign-row-toggle ${active ? "is-active" : paused ? "is-paused" : ""}" data-campaign-action="toggle-status" data-campaign-id="${esc(campaignId)}" data-next-status="${active ? "paused" : "active"}" role="switch" aria-checked="${active ? "true" : "false"}" aria-label="${active ? "Pausar" : "Ativar"} campanha"><span class="ads-campaign-row-toggle__track"><span class="ads-campaign-row-toggle__thumb"></span></span></button>
            <span class="ads-table-status-text ${active ? "on" : ""}">${active ? "Ativa" : paused ? "Pausada" : esc(String(c.status || "-"))}</span>
          </div>
        </td>
        <td class="num ads-campaign-cell">${budget != null ? fmtMoney(budget) : "-"}</td>
        <td class="num ads-campaign-cell">${fmtRatioX(roas, 2)}</td>
        <td class="num ads-campaign-cell">${target != null ? fmtRatioX(target, 2) : "-"}</td>
        <td class="num ads-campaign-cell">${fmtPct(acos, 2)}</td>
        <td class="num ads-campaign-cell">${fmtNumber(units)}</td>
        <td class="num ads-campaign-cell">${fmtMoney(cost)}</td>
        <td class="ads-campaign-cell"><span class="pill ${diagnosisClass ? `pill--${diagnosisClass}` : ""}">${esc(diagnosis.label)}</span></td>
        <td class="ads-campaign-cell ads-campaign-cell--action"><div class="ads-action-cell"><button type="button" class="ads-action-link" data-campaign-action="open" data-campaign-id="${esc(campaignId)}">Abrir</button><button type="button" class="ads-action-link ads-action-link--edit" data-campaign-action="edit" data-campaign-id="${esc(campaignId)}">Editar</button></div></td>
      </tr>`;
    }).join("");

    const table = qs("#tblCampaigns");
    if (table && !table.dataset.sortBound) {
      table.dataset.sortBound = "1";
      table.addEventListener("click", (ev) => {
        const th = ev.target.closest("th[data-campaign-sort]");
        if (!th) return;
        const key = th.getAttribute("data-campaign-sort");
        if (!key) return;
        const current = state.campaignSort || {};
        state.campaignSort = { key, dir: current.key === key && current.dir === "desc" ? "asc" : "desc" };
        renderCampanhas();
      });
    }

    tbody.onclick = (ev) => {
      const actionBtn = ev.target.closest("[data-campaign-action]");
      if (actionBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const campaignId = actionBtn.getAttribute("data-campaign-id");
        const action = actionBtn.getAttribute("data-campaign-action");
        if (!campaignId) return;
        if (action === "edit") return openCampaignEditModal(campaignId);
        if (action === "toggle-status") {
          return openCampaignEditModal(campaignId);
        }
        return openCampaignWorkspace(campaignId, { navigate: true });
      }
      const tr = ev.target.closest("tr[data-camp-id]");
      if (!tr) return;
      openCampaignWorkspace(tr.getAttribute("data-camp-id"), { rowEl: tr, navigate: true });
    };

    tbody.onkeydown = (ev) => {
      const tr = ev.target.closest("tr[data-camp-id]");
      if (!tr) return;
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        openCampaignWorkspace(tr.getAttribute("data-camp-id"), { rowEl: tr, navigate: true });
      }
    };

    if (state.selectedCampaignId) {
      const tr = tbody.querySelector(`tr[data-camp-id="${CSS.escape(String(state.selectedCampaignId))}"]`);
      if (tr) setSelectedCampaignRow(tr);
    }
  }

  function globalAdsAnalysisContext(items = []) {
    const cpcRows = items.filter((it) => itemClicks(it) > 0);
    const avgCpc = cpcRows.length ? cpcRows.reduce((sum, it) => sum + itemCpc(it), 0) / cpcRows.length : 0;
    const sortedPrints = items.map(itemPrints).sort((a, b) => a - b);
    const medianPrints = sortedPrints.length ? sortedPrints[Math.floor(sortedPrints.length / 2)] : 0;
    return { avgCpc, highPrints: Math.max(250, medianPrints), roasTarget: 6 };
  }

  function globalAdCampaignName(row) {
    const id = String(row?.campaign_id || "");
    return getCampaignById(id)?.name || id || "-";
  }

  function renderGlobalAds() {
    const tbody = qs("#tbodyGlobalAds");
    const pagination = qs("#globalAdsPagination");
    if (!tbody) return;
    const all = state.globalAds.items || [];
    const query = String(qs("#globalAdsSearchInput")?.value || "").trim().toLowerCase();
    const campaignFilter = String(qs("#globalAdsCampaignFilter")?.value || "all");
    const diagnosisFilter = String(qs("#globalAdsDiagnosisFilter")?.value || "all");
    const context = globalAdsAnalysisContext(all);
    const filtered = all.filter((row) => {
      const searchable = `${row?.title || ""} ${row?.item_id || ""} ${row?.ad_group_id || ""}`.toLowerCase();
      if (query && !searchable.includes(query)) return false;
      if (campaignFilter !== "all" && String(row?.campaign_id || "") !== campaignFilter) return false;
      if (diagnosisFilter !== "all" && !analyzeMlbItem(row, context).tags.includes(diagnosisFilter)) return false;
      return true;
    });

    const perPage = Math.max(1, Number(state.globalAds.limit || 50));
    const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
    state.globalAds.page = Math.min(Math.max(1, Number(state.globalAds.page || 1)), totalPages);
    const startIndex = (state.globalAds.page - 1) * perPage;
    const rows = filtered.slice(startIndex, startIndex + perPage);
    const sourceTotal = Number(state.globalAds.total || all.length);
    setText(
      "globalAdsCount",
      `${fmtNumber(filtered.length)} exibidos · ${fmtNumber(sourceTotal)} no Product Ads`
    );

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="muted">Nenhum anuncio corresponde aos filtros atuais.</td></tr>`;
    } else {
      tbody.innerHTML = rows.map((row) => {
        const analysis = analyzeMlbItem(row, context);
        const m = row.metrics || {};
        const thumb = row.thumbnail
          ? `<img class="ads-global-ad-thumb" src="${esc(row.thumbnail)}" alt="" loading="lazy">`
          : `<span class="ads-global-ad-thumb ads-global-ad-thumb--empty"></span>`;
        return `<tr>
          <td class="sticky-col"><div class="ads-global-ad-cell">${thumb}<div><strong>${esc(row.title || row.item_id || row.ad_group_id || "Anuncio")}</strong><small>${esc(row.item_id || row.ad_group_id || "-")}</small></div></div></td>
          <td>${esc(globalAdCampaignName(row))}</td>
          <td class="num">${fmtMoney(itemCost(row))}</td>
          <td class="num">${fmtNumber(itemUnits(row))}</td>
          <td class="num">${fmtRatioX(itemRoas(row), 2)}</td>
          <td class="num">${fmtPct(Number(m.acos || 0), 2)}</td>
          <td class="num">${fmtNumber(itemClicks(row))}</td>
          <td><span class="pill pill--${analysis.tone === "bad" ? "bad" : analysis.tone === "warn" ? "warn" : "good"}">${esc(analysis.label)}</span></td>
        </tr>`;
      }).join("");
    }

    if (pagination) {
      if (filtered.length <= perPage) {
        pagination.innerHTML = "";
      } else {
        pagination.innerHTML = `
          <button type="button" data-global-page="prev" ${state.globalAds.page <= 1 ? "disabled" : ""}>Anterior</button>
          <button type="button" disabled class="ads-pagination__label">Pagina ${state.globalAds.page} de ${totalPages}</button>
          <button type="button" data-global-page="next" ${state.globalAds.page >= totalPages ? "disabled" : ""}>Proxima</button>
        `;
        pagination.onclick = (ev) => {
          const btn = ev.target.closest("[data-global-page]");
          if (!btn || btn.disabled) return;
          const action = btn.getAttribute("data-global-page");
          if (action === "prev" && state.globalAds.page > 1) state.globalAds.page -= 1;
          if (action === "next" && state.globalAds.page < totalPages) state.globalAds.page += 1;
          renderGlobalAds();
          qs("#adsGlobalAdsSection")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        };
      }
    }
  }

  function syncGlobalCampaignFilter() {
    const select = qs("#globalAdsCampaignFilter");
    if (!select) return;
    const current = String(select.value || "all");
    select.innerHTML = `<option value="all">Todas</option>` + (state.campaigns || []).map((c) => `<option value="${esc(campaignIdOf(c))}">${esc(cleanCampaignLabel(c.name) || campaignIdOf(c))}</option>`).join("");
    if ([...select.options].some((o) => o.value === current)) select.value = current;
  }

  async function carregarGlobalAds({ force = false } = {}) {
    if (state.globalAds.loading) return;
    const from = state.date_from || addDays(-30);
    const to = state.date_to || todayISO();
    const rangeKey = `${from}:${to}`;
    if (!force && state.globalAds.loadedRangeKey === rangeKey && state.globalAds.items.length) {
      syncGlobalCampaignFilter();
      renderGlobalAds();
      return;
    }
    const tbody = qs("#tbodyGlobalAds");
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="muted">Carregando anuncios patrocinados...</td></tr>`;
    state.globalAds.loading = true;
    try {
      const url = withBase(`/api/publicidade/product-ads/ad-groups?date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(to)}&all=1&limit=800`);
      const r = await fetch(url, { credentials: "same-origin" });
      const txt = await r.text().catch(() => "");
      if (!r.ok) throw new Error(`HTTP ${r.status} ${txt}`);
      const data = txt ? JSON.parse(txt) : {};
      state.globalAds.items = Array.isArray(data.ads) ? data.ads : [];
      state.globalAds.total = Number(data?.paging?.total || state.globalAds.items.length);
      state.globalAds.page = 1;
      state.globalAds.loadedRangeKey = rangeKey;
      syncGlobalCampaignFilter();
      renderGlobalAds();
    } catch (err) {
      console.error("Falha ao carregar Ad Groups:", err);
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="muted">Nao foi possivel carregar os anuncios patrocinados.</td></tr>`;
    } finally {
      state.globalAds.loading = false;
    }
  }

  // ==========================================
  // Selecao de campanha (ranking -> itens)
  // ==========================================
  function selecionarCampanha(campaignId, opts = {}) {
    const id = String(campaignId || "");
    if (!id) return;

    if (String(state.selectedCampaignId || "") !== id) {
      state.itemAnalysisFilter = { key: "all", label: "Todos", targetMlb: null };
    }
    state.selectedCampaignId = id;
    state.itemsPage = 1;

    const tbody = $campBody();
    const rowEl =
      opts.rowEl ||
      tbody?.querySelector(`tr[data-camp-id="${CSS.escape(id)}"]`) ||
      null;

    if (rowEl) {
      setSelectedCampaignRow(rowEl);
      if (opts.scroll !== false)
        rowEl.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }

    const currentCampaign = (state.campaigns || []).find(
      (campaign) => campaignIdOf(campaign) === id,
    );
    syncItemsHeader(currentCampaign || null);
    if (state.focusMode) {
      syncCampaignFocusMode();
      atualizarResumoGeral();
    }
    syncCampaignActions();

    if (!state.focusMode || state.campaignTab === "campaign-ads") {
      carregarItensCampanha(id);
    }
  }

  // ==========================================
  // Fetch - itens da campanha
  // ==========================================
  async function carregarItensCampanha(campaignId) {
    const tbody = $itemsBody();
    const pag = $pagination();
    if (pag) pag.innerHTML = "";
    if (!tbody) return;

    if (!campaignId) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted">Selecione uma campanha.</td></tr>`;
      renderMlbAnalysis([]);
      return;
    }

    const from = state.date_from || addDays(-30);
    const to = state.date_to || todayISO();

    const cached = state.itemsByCampaign.get(String(campaignId));
    if (cached && cached.date_from === from && cached.date_to === to) {
      renderMlbAnalysis(cached.items);
      renderItens(cached.items);
      return;
    }

    setLoadingTable(tbody, "Carregando itens da campanha...");

    const url = withBase(
      `/api/publicidade/product-ads/campaigns/${encodeURIComponent(
        campaignId
      )}/items` +
      `?date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(
        to
      )}`,
    );

    try {
      const r = await fetch(url, { credentials: "same-origin" });
      const txt = await r.text().catch(() => "");

      if (!r.ok) {
        console.error("Erro ao carregar itens da campanha:", r.status, txt);
        tbody.innerHTML = `<tr><td colspan="7" class="muted">Falha ao carregar itens (HTTP ${r.status}).</td></tr>`;
        renderMlbAnalysis([]);
        return;
      }

      const data = txt ? JSON.parse(txt) : {};
      const items = Array.isArray(data.items) ? data.items : [];

      state.itemsByCampaign.set(String(campaignId), {
        date_from: from,
        date_to: to,
        items,
      });

      state.itemsPage = 1;
      renderMlbAnalysis(items);
      renderItens(items);
    } catch (e) {
      console.error("Erro inesperado ao buscar itens da campanha:", e);
      tbody.innerHTML = `<tr><td colspan="7" class="muted">Erro ao buscar itens (ver console).</td></tr>`;
      renderMlbAnalysis([]);
    }
  }

  // ==========================================
  // Itens (paginacao + render)
  // ==========================================
  function renderItensPagination(totalItems) {
    const container = $pagination();
    if (!container) return;

    const perPage = state.itemsPerPage;
    const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
    const current = Math.min(Math.max(1, state.itemsPage), totalPages);

    container.innerHTML = `
      <button data-page="prev" ${current === 1 ? "disabled" : ""}><</button>
      <button disabled class="ads-pagination__label">Pagina ${current} de ${totalPages}</button>
      <button data-page="next" ${
        current === totalPages ? "disabled" : ""
      }>></button>
    `;

    container.onclick = (ev) => {
      const btn = ev.target.closest("[data-page]");
      if (!btn) return;

      const type = btn.getAttribute("data-page");
      if (type === "prev" && state.itemsPage > 1) state.itemsPage -= 1;
      else if (type === "next" && state.itemsPage < totalPages)
        state.itemsPage += 1;
      else return;

      const campId = state.selectedCampaignId;
      if (!campId) return;
      const cached = state.itemsByCampaign.get(String(campId));
      if (!cached) return;
      renderItens(cached.items);
    };
  }

  function detectQuality(it) {
    const raw =
      it.publication_quality ??
      it.quality ??
      it.listing_quality ??
      it.health ??
      null;
    if (raw == null) return { cls: "quality-badge--na", label: "N/D" };

    const n = Number(raw);
    if (isFinite(n)) {
      if (n >= 80)
        return { cls: "quality-badge--good", label: String(Math.round(n)) };
      if (n >= 50)
        return { cls: "quality-badge--medium", label: String(Math.round(n)) };
      return { cls: "quality-badge--na", label: String(Math.round(n)) };
    }

    const s = String(raw).toLowerCase();
    if (s.includes("good") || s.includes("high") || s.includes("excel"))
      return { cls: "quality-badge--good", label: "Boa" };
    if (s.includes("med") || s.includes("mid"))
      return { cls: "quality-badge--medium", label: "Media" };
    return { cls: "quality-badge--na", label: esc(String(raw)).slice(0, 6) };
  }

  function itemMlb(it = {}) {
    return String(it.item_id || it.itemId || it.id || "-").trim() || "-";
  }

  function itemMetrics(it = {}) {
    return it.metrics && typeof it.metrics === "object" ? it.metrics : {};
  }

  function itemCost(it = {}) {
    return Number(itemMetrics(it).cost || 0);
  }

  function itemRevenue(it = {}) {
    const m = itemMetrics(it);
    const total = Number(m.total_amount || 0);
    if (total > 0) return total;
    return Number(m.direct_amount || 0) + Number(m.indirect_amount || 0);
  }

  function itemUnits(it = {}) {
    const m = itemMetrics(it);
    if (m.units_quantity != null) return Number(m.units_quantity || 0);
    return Number(m.direct_units_quantity || 0) + Number(m.indirect_units_quantity || 0);
  }

  function itemClicks(it = {}) {
    return Number(itemMetrics(it).clicks || 0);
  }

  function itemPrints(it = {}) {
    return Number(itemMetrics(it).prints || 0);
  }

  function itemCtr(it = {}) {
    const m = itemMetrics(it);
    if (m.ctr != null && Number.isFinite(Number(m.ctr))) return Number(m.ctr);
    const prints = itemPrints(it);
    return prints > 0 ? (itemClicks(it) / prints) * 100 : 0;
  }

  function itemCpc(it = {}) {
    const m = itemMetrics(it);
    if (m.cpc != null && Number.isFinite(Number(m.cpc))) return Number(m.cpc);
    const clicks = itemClicks(it);
    return clicks > 0 ? itemCost(it) / clicks : 0;
  }

  function itemRoas(it = {}) {
    const m = itemMetrics(it);
    if (m.roas != null && Number.isFinite(Number(m.roas))) return Number(m.roas);
    const cost = itemCost(it);
    return cost > 0 ? itemRevenue(it) / cost : 0;
  }

  function mlbAnalysisContext(items = []) {
    const active = (items || []).filter((it) => itemCost(it) > 0 || itemClicks(it) > 0 || itemRevenue(it) > 0);
    const totalCpcBase = active.filter((it) => itemClicks(it) > 0);
    const avgCpc = totalCpcBase.length
      ? totalCpcBase.reduce((sum, it) => sum + itemCpc(it), 0) / totalCpcBase.length
      : 0;
    const sortedPrints = active.map(itemPrints).sort((a, b) => a - b);
    const medianPrints = sortedPrints.length ? sortedPrints[Math.floor(sortedPrints.length / 2)] : 0;
    const selectedCampaign = getSelectedCampaign();
    return {
      avgCpc,
      highPrints: Math.max(250, medianPrints),
      roasTarget: campaignRoasTargetValue(selectedCampaign) || 6,
    };
  }

  function analyzeMlbItem(it = {}, context = {}) {
    const cost = itemCost(it);
    const revenue = itemRevenue(it);
    const units = itemUnits(it);
    const clicks = itemClicks(it);
    const prints = itemPrints(it);
    const ctr = itemCtr(it);
    const cpc = itemCpc(it);
    const roas = itemRoas(it);
    const tags = new Set();

    if (cost >= 20 && units <= 0 && revenue <= 0) tags.add("sugador");
    if (clicks >= 5 && units <= 0 && revenue <= 0) tags.add("clique_sem_venda");
    if (prints >= (context.highPrints || 250) && ctr > 0 && ctr < 0.6) tags.add("ctr_baixo");
    if (cpc > 0 && cost >= 10 && context.avgCpc > 0 && cpc >= context.avgCpc * 1.35 && revenue <= 0) tags.add("cpc_alto");
    if (cost > 0 && units > 0 && roas >= Math.max(4, Number(context.roasTarget || 6))) tags.add("oportunidade");
    if (!tags.size && cost > 0 && units > 0 && roas > 0) tags.add("saudavel");
    if (!tags.size) tags.add("monitorar");

    const priority = ["sugador", "clique_sem_venda", "cpc_alto", "ctr_baixo", "oportunidade", "saudavel", "monitorar"];
    const key = priority.find((candidate) => tags.has(candidate)) || "monitorar";
    const tone =
      key === "sugador" || key === "clique_sem_venda" ? "bad" :
      key === "cpc_alto" || key === "ctr_baixo" || key === "monitorar" ? "warn" :
      "good";
    return {
      key,
      tone,
      tags: Array.from(tags),
      label: MLB_FILTER_LABELS[key] || "Monitorar",
      cost,
      revenue,
      units,
      clicks,
      prints,
      ctr,
      cpc,
      roas,
      mlb: itemMlb(it),
    };
  }

  function buildMlbAnalysis(items = []) {
    const context = mlbAnalysisContext(items);
    const rows = (items || []).map((item) => ({
      item,
      analysis: analyzeMlbItem(item, context),
    }));
    const count = (key) => rows.filter((row) => row.analysis.tags.includes(key)).length;
    const sumCost = (key) => rows
      .filter((row) => row.analysis.tags.includes(key))
      .reduce((sum, row) => sum + row.analysis.cost, 0);
    const topBy = (key, metric) => rows
      .filter((row) => row.analysis.tags.includes(key))
      .sort((a, b) => Number(b.analysis[metric] || 0) - Number(a.analysis[metric] || 0))[0] || null;

    const insights = [];
    const sugador = topBy("sugador", "cost");
    if (sugador) {
      insights.push({
        key: "sugador",
        tone: "bad",
        mlb: sugador.analysis.mlb,
        label: "Sugador",
        title: `${sugador.analysis.mlb} virou sugador`,
        text: `Investiu ${fmtMoney(sugador.analysis.cost)} e nao gerou vendas no periodo.`,
      });
    }
    const clickNoSale = topBy("clique_sem_venda", "clicks");
    if (clickNoSale) {
      insights.push({
        key: "clique_sem_venda",
        tone: "bad",
        mlb: clickNoSale.analysis.mlb,
        label: "Clique sem venda",
        title: `${clickNoSale.analysis.mlb} tem clique e nao vende`,
        text: `${fmtNumber(clickNoSale.analysis.clicks)} cliques sem venda atribuida. Revisar preco, imagem e oferta.`,
      });
    }
    const ctrLow = topBy("ctr_baixo", "prints");
    if (ctrLow) {
      insights.push({
        key: "ctr_baixo",
        tone: "warn",
        mlb: ctrLow.analysis.mlb,
        label: "CTR baixo",
        title: `${ctrLow.analysis.mlb} nao atrai clique`,
        text: `${fmtNumber(ctrLow.analysis.prints)} impressoes com CTR ${fmtPct(ctrLow.analysis.ctr, 2)}.`,
      });
    }
    const cpcHigh = topBy("cpc_alto", "cpc");
    if (cpcHigh) {
      insights.push({
        key: "cpc_alto",
        tone: "warn",
        mlb: cpcHigh.analysis.mlb,
        label: "CPC alto",
        title: `${cpcHigh.analysis.mlb} esta caro por clique`,
        text: `CPC ${fmtMoney(cpcHigh.analysis.cpc)} acima da media da campanha.`,
      });
    }
    const opportunity = topBy("oportunidade", "roas");
    if (opportunity) {
      insights.push({
        key: "oportunidade",
        tone: "good",
        mlb: opportunity.analysis.mlb,
        label: "Oportunidade",
        title: `${opportunity.analysis.mlb} pode escalar`,
        text: `ROAS ${fmtRatioX(opportunity.analysis.roas, 2)} com ${fmtMoney(opportunity.analysis.revenue)} em vendas ads.`,
      });
    }

    return {
      context,
      rows,
      summary: {
        total: rows.length,
        sugador: count("sugador"),
        clickNoSale: count("clique_sem_venda"),
        ctrLow: count("ctr_baixo"),
        cpcHigh: count("cpc_alto"),
        opportunity: count("oportunidade"),
        healthy: count("saudavel"),
        waste: sumCost("sugador"),
      },
      insights,
    };
  }

  function syncMlbFilterControls() {
    const filter = state.itemAnalysisFilter || { key: "all", label: "Todos" };
    qsa("[data-mlb-filter]").forEach((button) => {
      const key = button.getAttribute("data-mlb-filter") || "all";
      button.classList.toggle("is-active", key === filter.key);
    });
    const chip = qs("#itemsActiveFilter");
    const label = qs("#itemsActiveFilterLabel");
    const active = filter.key && filter.key !== "all";
    if (chip) chip.hidden = !active;
    if (label) label.textContent = active ? `Filtro: ${filter.label || MLB_FILTER_LABELS[filter.key] || filter.key}` : "Filtro: Todos";
  }

  function filterItemsByAnalysis(items = []) {
    const filter = state.itemAnalysisFilter || { key: "all" };
    if (!filter.key || filter.key === "all") return items || [];
    const context = mlbAnalysisContext(items);
    return (items || []).filter((item) => {
      const analysis = analyzeMlbItem(item, context);
      return analysis.tags.includes(filter.key);
    });
  }

  function applyMlbAnalysisFilter(key = "all", targetMlb = null) {
    const cached = state.itemsByCampaign.get(String(state.selectedCampaignId || ""));
    state.itemAnalysisFilter = {
      key,
      label: MLB_FILTER_LABELS[key] || "Filtro",
      targetMlb: targetMlb || null,
    };
    state.itemsPage = 1;
    if (targetMlb && cached?.items?.length) {
      const filtered = filterItemsByAnalysis(cached.items);
      const index = filtered.findIndex((item) => itemMlb(item) === targetMlb);
      if (index >= 0) state.itemsPage = Math.floor(index / state.itemsPerPage) + 1;
    }
    renderMlbAnalysis(cached?.items || []);
    renderItens(cached?.items || []);
    if (targetMlb) {
      setTimeout(() => highlightMlbRow(targetMlb), 80);
    }
  }

  function highlightMlbRow(mlb) {
    const row = qs(`tr[data-item-id="${CSS.escape(String(mlb || ""))}"]`);
    if (!row) return;
    row.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "nearest" });
    row.classList.add("is-mlb-highlight");
    setTimeout(() => row.classList.remove("is-mlb-highlight"), 2600);
  }

  function renderMlbAnalysis(items = []) {
    const summaryEl = qs("#mlbAnalysisSummary");
    const insightsEl = qs("#mlbAnalysisInsights");
    const filtersEl = qs("#mlbAnalysisFilters");
    const clearBtn = qs("#btnClearItemsFilter");
    const analysis = buildMlbAnalysis(items);
    syncMlbFilterControls();

    if (summaryEl) {
      const cards = [
        { key: "sugador", tone: "bad", label: "Sugadores", value: analysis.summary.sugador, detail: `${fmtMoney(analysis.summary.waste)} sem venda` },
        { key: "clique_sem_venda", tone: "bad", label: "Cliques sem venda", value: analysis.summary.clickNoSale, detail: "clique pago sem conversao" },
        { key: "ctr_baixo", tone: "warn", label: "CTR baixo", value: analysis.summary.ctrLow, detail: "muita impressao e pouco clique" },
        { key: "cpc_alto", tone: "warn", label: "CPC alto", value: analysis.summary.cpcHigh, detail: "clique caro sem retorno" },
        { key: "oportunidade", tone: "good", label: "Oportunidades", value: analysis.summary.opportunity, detail: "ROAS acima da meta" },
        { key: "saudavel", tone: "good", label: "Saudaveis", value: analysis.summary.healthy, detail: "com venda e retorno" },
      ];
      summaryEl.innerHTML = cards.map((card) => `
        <button type="button" class="ads-mlb-summary-card is-${card.tone}" data-mlb-filter="${esc(card.key)}">
          <strong>${esc(fmtNumber(card.value))}</strong>
          <span>${esc(card.label)}</span>
          <small>${esc(card.detail)}</small>
        </button>
      `).join("");
    }

    if (insightsEl) {
      if (!analysis.insights.length) {
        insightsEl.innerHTML = `
          <article class="ads-mlb-insight is-good">
            <small>Sem alerta critico</small>
            <h3>Nenhum MLB sugador encontrado</h3>
            <p>Os anuncios carregados nao bateram os limites de desperdicio definidos para o periodo.</p>
          </article>
        `;
      } else {
        insightsEl.innerHTML = analysis.insights.slice(0, 5).map((insight) => `
          <button type="button" class="ads-mlb-insight is-${esc(insight.tone)}" data-mlb-filter="${esc(insight.key)}" data-mlb-target="${esc(insight.mlb)}">
            <small>${esc(insight.label)}</small>
            <h3>${esc(insight.title)}</h3>
            <p>${esc(insight.text)}</p>
          </button>
        `).join("");
      }
    }

    syncMlbFilterControls();

    const handleFilterClick = (ev) => {
      const trigger = ev.target.closest("[data-mlb-filter]");
      if (!trigger) return;
      ev.preventDefault();
      const key = trigger.getAttribute("data-mlb-filter") || "all";
      const target = trigger.getAttribute("data-mlb-target") || null;
      applyMlbAnalysisFilter(key, target);
    };
    if (filtersEl) filtersEl.onclick = handleFilterClick;
    if (summaryEl) summaryEl.onclick = handleFilterClick;
    if (insightsEl) insightsEl.onclick = handleFilterClick;
    if (clearBtn) clearBtn.onclick = () => applyMlbAnalysisFilter("all", null);
  }

  function renderItens(items) {
    const tbody = $itemsBody();
    if (!tbody) return;
    syncMlbFilterControls();

    if (!items || !items.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted">Nenhum item com metricas para esta campanha no periodo.</td></tr>`;
      renderItensPagination(0);
      return;
    }

    const filteredItems = filterItemsByAnalysis(items);
    if (!filteredItems.length) {
      const filter = state.itemAnalysisFilter || {};
      tbody.innerHTML = `<tr><td colspan="7" class="muted">Nenhum MLB encontrado para o filtro ${esc(filter.label || "selecionado")}.</td></tr>`;
      renderItensPagination(0);
      return;
    }

    const context = mlbAnalysisContext(items);
    const perPage = state.itemsPerPage;
    const total = filteredItems.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const page = Math.min(Math.max(1, state.itemsPage), totalPages);
    state.itemsPage = page;

    const start = (page - 1) * perPage;
    const end = start + perPage;
    const pageItems = filteredItems.slice(start, end);

    const rows = pageItems
      .map((it) => {
        const m = it.metrics || {};
        const analysis = analyzeMlbItem(it, context);

        const prints = Number(m.prints ?? 0);
        const clicks = Number(m.clicks ?? 0);

        const ctrVal =
          m.ctr != null
            ? fmtPct(m.ctr)
            : prints > 0
            ? fmtPct((clicks / prints) * 100)
            : "-";

        const cpcVal =
          m.cpc != null
            ? fmtMoney(m.cpc)
            : it.cpc != null
            ? fmtMoney(it.cpc)
            : "-";

        const roasVal = m.roas != null ? fmtRatioX(m.roas, 2) : "-";

        const unitsQ = Number(m.units_quantity ?? 0);
        const convRateText =
          m.conversion_rate != null
            ? fmtPct(Number(m.conversion_rate) * 100)
            : clicks > 0 && unitsQ >= 0
            ? fmtPct((unitsQ / clicks) * 100)
            : "-";

        const vendasPublicidadeVal =
          m.total_amount != null ? fmtMoney(m.total_amount) : "-";

        const investimentoVal = m.cost != null ? fmtMoney(m.cost) : "-";

        const statusRaw = it.status || it.item_status || "-";
        const statusClass =
          String(statusRaw).toLowerCase() === "active"
            ? "is-active"
            : String(statusRaw).toLowerCase() === "paused"
            ? "is-paused"
            : "";

        const q = detectQuality(it);

        const title = it.title || it.name || "-";
        const sku = it.sku || it.seller_sku || "-";
        const mlb = it.item_id || it.itemId || "-";
        const actionItemId = String(
          it.item_id ??
            it.itemId ??
            it.ad_id ??
            it.adId ??
            it.advertising_id ??
            it.advertisingId ??
            it.id ??
            ""
        ).trim();

        const firstLetter = String(title).trim().charAt(0).toUpperCase() || "P";

        const thumbHtml = it.thumbnail
          ? `<img class="ads-item-thumb__img" src="${esc(it.thumbnail)}" alt="${esc(
              title
            )}" loading="lazy">`
          : `<span class="ads-item-thumb__fallback">${esc(firstLetter)}</span>`;
        const canPause = String(statusRaw).toLowerCase() === "active";
        const diagnosisClass =
          analysis.tone === "bad" ? "is-bad" :
          analysis.tone === "good" ? "is-good" :
          "is-warn";
        const detailTitle = [
          `Impressoes: ${fmtNumber(prints)}`,
          `CPC: ${cpcVal}`,
          `Conversao: ${convRateText}`,
          `ACOS: ${m.acos != null ? fmtPct(m.acos) : "-"}`,
          `TACOS: ${m.tacos != null ? fmtPct(m.tacos) : "-"}`,
          `Vendas diretas: ${m.direct_amount != null ? fmtMoney(m.direct_amount) : "-"}`,
          `Vendas assistidas: ${m.indirect_amount != null ? fmtMoney(m.indirect_amount) : "-"}`,
        ].join(" | ");

        return `
        <tr class="ads-item-row" data-item-id="${esc(mlb)}" data-item-diagnosis="${esc(analysis.key)}">
          <td class="sticky-col">
            <div class="ads-item-product">
              <div class="ads-item-thumb">${thumbHtml}</div>
              <div class="ads-item-info">
                <div class="ads-item-title" title="${esc(title)}">${esc(
          title
        )}</div>
                <div class="ads-item-meta">
                  <span>SKU: ${esc(sku)}</span>
                  <span>MLB: ${esc(mlb)}</span>
                  <span class="ads-item-status ${statusClass}">${esc(
          statusRaw
        )}</span>
                  <span class="quality-badge ${q.cls}" title="Qualidade da publicacao">${esc(q.label)}</span>
                </div>
              </div>
            </div>
          </td>

          <td>
            <span class="ads-mlb-diagnosis ${diagnosisClass}" title="${esc(detailTitle)}">${esc(analysis.label)}</span>
          </td>
          <td class="num">${investimentoVal}</td>
          <td class="num">
            <strong>${vendasPublicidadeVal}</strong>
            <small class="ads-cell-sub">${fmtNumber(unitsQ)} venda${unitsQ === 1 ? "" : "s"}</small>
          </td>
          <td class="num">${roasVal}</td>
          <td class="num">
            <strong>${fmtNumber(clicks)}</strong>
            <small class="ads-cell-sub">CTR ${ctrVal}</small>
          </td>
          <td>
            <div class="ads-inline-actions">
              <button type="button" class="ads-inline-btn ads-inline-btn--danger" data-item-action="remove" data-item-id="${esc(actionItemId)}" data-item-label="${esc(mlb || actionItemId || "-")}">Remover</button>
              <button type="button" class="ads-inline-btn ads-inline-btn--ghost" data-item-action="toggle" data-item-id="${esc(actionItemId)}" data-item-label="${esc(mlb || actionItemId || "-")}" data-next-status="${canPause ? "paused" : "active"}">${canPause ? "Pausar" : "Ativar"}</button>
            </div>
          </td>
        </tr>
      `;
      })
      .join("");

    tbody.innerHTML = rows;
    tbody.onclick = (ev) => {
      const btn = ev.target.closest("[data-item-action]");
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const itemId = btn.getAttribute("data-item-id");
      const itemLabel = btn.getAttribute("data-item-label") || itemId;
      const action = btn.getAttribute("data-item-action");
      if (!itemId || !action) return;
      if (action === "remove") {
        removeCampaignItem(itemId, itemLabel);
        return;
      }
      if (action === "toggle") {
        const nextStatus = btn.getAttribute("data-next-status") || "paused";
        updateCampaignItemStatus(itemId, nextStatus, itemLabel);
      }
    };
    renderItensPagination(total);
  }

  // ==========================================
  // Daily series (premium): grafico + tabela diaria
  // ==========================================
  function getMetricSelected() {
    const sel = qs("#metric");
    const v = sel?.value || state.metric || "total_amount";
    state.metric = v;
    return v;
  }

  function metricLabel(metric) {
    switch (metric) {
      case "cost":
        return "Investimento";
      case "clicks":
        return "Cliques";
      case "prints":
        return "Impressoes";
      case "roas":
        return "ROAS";
      case "ctr":
        return "CTR";
      case "total_amount":
      default:
        return "Faturamento";
    }
  }

  function formatValueForMetric(metric, v) {
    const n = Number(v);
    if (!isFinite(n)) return "-";
    if (metric === "total_amount" || metric === "cost") return fmtMoney(n);
    if (metric === "roas") return fmtRatioX(n, 2);
    if (metric === "ctr") return fmtPct(n, 2);
    return fmtNumber(n);
  }

  function isAdsDarkTheme() {
    return document.body?.classList?.contains("theme-dark") === true;
  }

  function chartPalette(metric) {
    switch (metric) {
      case "cost":
        return {
          line: "#d97706",
          point: "#f59e0b",
          compare: "rgba(217,119,6,0.52)",
          fillTop: "rgba(245,158,11,0.24)",
          fillMid: "rgba(245,158,11,0.10)",
          fillBottom: "rgba(245,158,11,0.02)",
          backdropTop: "rgba(245,158,11,0.10)",
          backdropMid: "rgba(245,158,11,0.05)",
        };
      case "roas":
        return {
          line: "#16a34a",
          point: "#22c55e",
          compare: "rgba(22,163,74,0.52)",
          fillTop: "rgba(34,197,94,0.24)",
          fillMid: "rgba(34,197,94,0.10)",
          fillBottom: "rgba(34,197,94,0.02)",
          backdropTop: "rgba(34,197,94,0.09)",
          backdropMid: "rgba(34,197,94,0.045)",
        };
      case "ctr":
        return {
          line: "#4f46e5",
          point: "#6366f1",
          compare: "rgba(79,70,229,0.48)",
          fillTop: "rgba(99,102,241,0.22)",
          fillMid: "rgba(99,102,241,0.10)",
          fillBottom: "rgba(99,102,241,0.02)",
          backdropTop: "rgba(99,102,241,0.08)",
          backdropMid: "rgba(99,102,241,0.04)",
        };
      case "total_amount":
      default:
        return {
          line: "#3483fa",
          point: "#60a5fa",
          compare: "rgba(52,131,250,0.52)",
          fillTop: "rgba(52,131,250,0.25)",
          fillMid: "rgba(52,131,250,0.11)",
          fillBottom: "rgba(52,131,250,0.02)",
          backdropTop: "rgba(52,131,250,0.10)",
          backdropMid: "rgba(56,189,248,0.06)",
        };
    }
  }

  function metricValueFromDailyRow(row, metric) {
    const direct = row?.[metric];
    if (direct != null && Number.isFinite(Number(direct))) return Number(direct);
    const prints = Number(row?.prints || 0);
    const clicks = Number(row?.clicks || 0);
    const cost = Number(row?.cost || 0);
    const amount = Number(row?.total_amount || 0);
    if (metric === "ctr") return prints > 0 ? (clicks / prints) * 100 : 0;
    if (metric === "roas") return cost > 0 ? amount / cost : 0;
    return toFiniteNumber(direct);
  }

  // Plugin: escreve o valor em pontos estrategicos para evitar poluicao visual.
  const pointValueLabelsPlugin = {
    id: "pointValueLabels",
    afterDatasetsDraw(chart, args, pluginOptions) {
      if (pluginOptions?.enabled === false) return;
      const { ctx, chartArea } = chart;
      const datasetIndex = Number(pluginOptions?.datasetIndex ?? 0);
      const meta = chart.getDatasetMeta(datasetIndex);
      if (
        !chartArea ||
        !meta ||
        meta.hidden ||
        !Array.isArray(meta.data) ||
        !meta.data.length
      ) {
        return;
      }

      const metric = pluginOptions?.metric || "total_amount";
      const formatter = pluginOptions?.formatter || ((val) => String(val));
      const maxLabels = Math.max(4, Number(pluginOptions?.maxLabels || 10));
      const stride = Math.max(1, Math.ceil(meta.data.length / maxLabels));
      const values = (chart.data?.datasets?.[datasetIndex]?.data || []).map((v) =>
        Number(v),
      );
      const validValues = values.filter((v) => Number.isFinite(v));
      const maxVal = validValues.length ? Math.max(...validValues) : null;
      const minVal = validValues.length ? Math.min(...validValues) : null;
      const maxIdx =
        maxVal == null ? -1 : values.findIndex((v) => Number.isFinite(v) && v === maxVal);
      const minIdx =
        minVal == null ? -1 : values.findIndex((v) => Number.isFinite(v) && v === minVal);
      const important = new Set([0, meta.data.length - 1, maxIdx, minIdx]);

      ctx.save();
      ctx.font = "700 11px Segoe UI, Tahoma, sans-serif";
      ctx.fillStyle = isAdsDarkTheme() ? "rgba(226,232,240,.88)" : "rgba(30,41,59,.85)";
      ctx.textAlign = "center";

      meta.data.forEach((pt, i) => {
        if (!pt || typeof pt.x !== "number" || typeof pt.y !== "number") return;
        if (!important.has(i) && i % stride !== 0) return;
        const raw = chart.data?.datasets?.[datasetIndex]?.data?.[i];
        if (!Number.isFinite(Number(raw))) return;
        if (Number(raw) === 0 && !important.has(i)) return;
        const label = formatter(raw, metric);
        if (!label || label === "-") return;

        const textWidth = ctx.measureText(label).width || 0;
        const sidePad = 6;
        const topPad = 4;
        const bottomPad = 4;
        const textHalf = textWidth / 2;

        let x = pt.x;
        if (x - textHalf < chartArea.left + sidePad) {
          x = chartArea.left + sidePad + textHalf;
        }
        if (x + textHalf > chartArea.right - sidePad) {
          x = chartArea.right - sidePad - textHalf;
        }

        let y = pt.y - 10;
        let placeBelow = false;
        if (y < chartArea.top + topPad + 2) {
          placeBelow = true;
          y = Math.min(chartArea.bottom - bottomPad, pt.y + 8);
        }

        ctx.textBaseline = placeBelow ? "top" : "bottom";
        ctx.fillText(label, x, y);
      });

      ctx.restore();
    },
  };

  // Plugin: fundo com atmosfera leve azul no plot area (mantendo paleta).
  const adsChartBackdropPlugin = {
    id: "adsChartBackdrop",
    beforeDraw(chart, args, pluginOptions) {
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const palette = chartPalette(pluginOptions?.metric || "total_amount");

      const { left, top, right, bottom, width, height } = chartArea;
      const grad = ctx.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, palette.backdropTop);
      grad.addColorStop(0.45, palette.backdropMid);
      grad.addColorStop(1, isAdsDarkTheme() ? "rgba(2,6,23,0.01)" : "rgba(255,255,255,0.01)");

      ctx.save();
      ctx.fillStyle = grad;
      ctx.fillRect(left, top, width, height);

      const columns = Math.max(4, Number(pluginOptions?.columns || 8));
      ctx.strokeStyle = isAdsDarkTheme() ? "rgba(148,163,184,0.12)" : "rgba(148,163,184,0.10)";
      ctx.lineWidth = 1;
      for (let i = 1; i < columns; i += 1) {
        const x = left + (width * i) / columns;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
      }

      const halo = ctx.createRadialGradient(
        right - width * 0.15,
        top + height * 0.1,
        10,
        right - width * 0.15,
        top + height * 0.1,
        Math.max(width, height) * 0.55,
      );
      halo.addColorStop(0, palette.fillTop);
      halo.addColorStop(1, isAdsDarkTheme() ? "rgba(2,6,23,0)" : "rgba(255,255,255,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(left, top, width, height);
      ctx.restore();
    },
  };

  async function showCampaignChart(campaignId = state.selectedCampaignId) {
    let targetCampaignId = String(campaignId || "");
    if (!targetCampaignId) {
      targetCampaignId = campaignIdOf((state.campaigns || [])[0] || null);
    }
    if (!targetCampaignId) return;
    await openCampaignWorkspace(targetCampaignId, { skipScroll: true });

    const chartCard = qs("#campaignChartCard");
    chartCard?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  async function showOverviewChart() {
    state.chartScope = "overall";
    syncCampaignActions();
    syncChartHeader();
    await carregarMetricasDiarias();

    const chartCard = qs("#campaignChartCard");
    chartCard?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  async function carregarMetricasDiarias(opts = {}) {
    const canvas = document.getElementById("adsMetricsChart");
    if (!canvas) return;

    const { from, to } = getDateRange();
    state.date_from = from;
    state.date_to = to;
    const campaignIdRaw =
      opts?.campaignId ||
      (state.chartScope === "campaign" ? state.selectedCampaignId : null);
    const campaignId = campaignIdRaw ? String(campaignIdRaw) : null;
    const previousRange = buildPreviousRange(from, to);

    syncPeriodLabels(from, to);
    syncChartHeader();

    const buildDailyMetricsUrl = (dateFrom, dateTo) =>
      campaignId
        ? withBase(
            `/api/publicidade/product-ads/campaigns/${encodeURIComponent(
              campaignId,
            )}/metrics/daily?date_from=${encodeURIComponent(
              dateFrom,
            )}&date_to=${encodeURIComponent(dateTo)}`,
          )
        : withBase(
            `/api/publicidade/product-ads/metrics/daily?date_from=${encodeURIComponent(
              dateFrom,
            )}&date_to=${encodeURIComponent(dateTo)}`,
          );

    const url = buildDailyMetricsUrl(from, to);
    const previousUrl = previousRange
      ? buildDailyMetricsUrl(previousRange.from, previousRange.to)
      : null;

    const fetchMetricsJson = async (targetUrl) => {
      const response = await fetch(targetUrl, { credentials: "same-origin" });
      const text = await response.text().catch(() => "");
      let payload = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = {};
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        text,
        payload,
      };
    };

    try {
      const [currentRes, previousRes] = await Promise.all([
        fetchMetricsJson(url),
        previousUrl ? fetchMetricsJson(previousUrl) : Promise.resolve(null),
      ]);

      if (!currentRes.ok) {
        console.error(
          "Erro ao carregar metricas diarias:",
          currentRes.status,
          currentRes.text,
        );
        state.dailySeries = [];
        state.dailySeriesPrevious = [];
        state.dailyPreviousRange = previousRange;
        renderDailyTable([]);
        atualizarGrafico([], getMetricSelected());
        syncChartHeader();
        return;
      }

      const currentData = currentRes.payload || {};
      const series = Array.isArray(currentData.results || currentData.series)
        ? currentData.results || currentData.series
        : [];
      const previousData = previousRes?.payload || {};
      const previousSeries = previousRes?.ok
        ? Array.isArray(previousData.results || previousData.series)
          ? previousData.results || previousData.series
          : []
        : [];

      if (previousRes && !previousRes.ok) {
        console.warn(
          "Sem comparativo do periodo anterior:",
          previousRes.status,
          previousRes.text,
        );
      }

      state.dailySeries = series;
      state.dailySeriesPrevious = previousSeries;
      state.dailyPreviousRange = previousRange;
      renderDailyTable(series);
      atualizarGrafico(series, getMetricSelected());
      syncChartHeader();
    } catch (e) {
      console.error("Erro inesperado ao carregar metricas diarias:", e);
      state.dailySeries = [];
      state.dailySeriesPrevious = [];
      state.dailyPreviousRange = previousRange;
      renderDailyTable([]);
      atualizarGrafico([], getMetricSelected());
      syncChartHeader();
    }
  }

  function renderDailyTable(series) {
    const tbody = qs("#tbodyDaily");
    const countEl = qs("#tableCount");
    const granularity = state.dailyGranularity === "weekly" ? "weekly" : "daily";
    const sameMonth = isSameMonth(state.date_from, state.date_to);
    if (!tbody) return;

    let rowsData = [];
    if (granularity === "weekly") {
      rowsData = aggregateSeriesWeekly(series);
    } else {
      rowsData = (Array.isArray(series) ? series : [])
        .map((row) => {
          const dateIso = String(row?.date || "").slice(0, 10);
          return {
            ...row,
            date: dateIso,
            period_label: sameMonth ? dayOfMonth(dateIso) : dayMonth(dateIso),
          };
        })
        .filter((row) => !!row.date)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    }

    if (!rowsData.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted">Sem dados no periodo.</td></tr>`;
      if (countEl)
        countEl.textContent = granularity === "weekly" ? "0 semanas" : "0 dias";
      return;
    }

    if (countEl) {
      const suffix =
        granularity === "weekly"
          ? rowsData.length === 1
            ? "semana"
            : "semanas"
          : rowsData.length === 1
          ? "dia"
          : "dias";
      countEl.textContent = `${rowsData.length} ${suffix}`;
    }

    const rows = rowsData
      .map((row) => {
        const prints = Number(row.prints || 0);
        const clicks = Number(row.clicks || 0);
        const cost = Number(row.cost || 0);
        const amount = Number(row.total_amount || 0);

        const ctr =
          row.ctr != null && Number.isFinite(Number(row.ctr))
            ? Number(row.ctr)
            : prints > 0
            ? (clicks / prints) * 100
            : 0;
        const roas =
          row.roas != null && Number.isFinite(Number(row.roas))
            ? Number(row.roas)
            : cost > 0
            ? amount / cost
            : 0;
        const acos =
          row.acos != null && Number.isFinite(Number(row.acos))
            ? Number(row.acos)
            : amount > 0
            ? (cost / amount) * 100
            : 0;
        const periodLabel =
          row.period_label ||
          (sameMonth ? dayOfMonth(row.date) : dayMonth(row.date));

        return `
          <tr>
            <td>${esc(periodLabel)}</td>
            <td class="num">${fmtMoney(amount)}</td>
            <td class="num">${fmtMoney(cost)}</td>
            <td class="num">${fmtNumber(clicks)}</td>
            <td class="num">${fmtPct(ctr, 2)}</td>
            <td class="num">${fmtRatioX(roas || 0, 2)}</td>
            <td class="num">${fmtPct(acos, 2)}</td>
          </tr>
        `;
      })
      .join("");

    tbody.innerHTML = rows;
  }

  function atualizarGrafico(series, metric) {
    const canvas = document.getElementById("adsMetricsChart");
    if (!canvas) return;

    if (typeof Chart === "undefined") {
      console.warn("Chart.js nao carregado - grafico nao sera exibido.");
      return;
    }

    const ctx = canvas.getContext("2d");
    const label = metricLabel(metric);
    const palette = chartPalette(metric);
    const sameMonth = isSameMonth(state.date_from, state.date_to);
    const valueFormatter = (raw, m) => formatValueForMetric(m, raw);
    const darkTheme = isAdsDarkTheme();
    const chartText = darkTheme ? "#a9b9cf" : "#64748b";
    const chartTitle = darkTheme ? "#dce6f3" : "#334155";
    const chartGrid = darkTheme ? "rgba(148,163,184,0.12)" : "rgba(148,163,184,0.16)";
    const pointOutline = darkTheme ? "#0d192c" : "#ffffff";
    const compareOutline = darkTheme ? "#172844" : "#dbeafe";
    const tickFmt = (v) => {
      if (metric === "total_amount" || metric === "cost") return fmtMoney(v);
      if (metric === "roas") return fmtRatioX(v, 1);
      if (metric === "ctr") return fmtPct(v, 2);
      return Number(v).toLocaleString("pt-BR");
    };

    let currentDates = buildDateSpan(state.date_from, state.date_to);
    if (!currentDates.length) {
      currentDates = (series || [])
        .map((row) => String(row?.date || "").slice(0, 10))
        .filter(Boolean);
    }

    const labels = currentDates.map((iso) => (sameMonth ? dayOfMonth(iso) : dayMonth(iso)));
    const currentByDate = mapSeriesByDate(series || []);
    const currentData = currentDates.map((iso) =>
      metricValueFromDailyRow(currentByDate.get(iso), metric),
    );

    const previousRange = state.dailyPreviousRange;
    const previousRawSeries = Array.isArray(state.dailySeriesPrevious)
      ? state.dailySeriesPrevious
      : [];
    let previousDates = [];
    let previousData = [];

    if (previousRange && previousRawSeries.length) {
      previousDates = buildDateSpan(previousRange.from, previousRange.to);
      const previousByDate = mapSeriesByDate(previousRawSeries);
      previousData = previousDates.map((iso) =>
        metricValueFromDailyRow(previousByDate.get(iso), metric),
      );

      if (previousData.length > currentData.length) {
        const diff = previousData.length - currentData.length;
        previousData = previousData.slice(diff);
        previousDates = previousDates.slice(diff);
      } else if (previousData.length < currentData.length) {
        const diff = currentData.length - previousData.length;
        previousData = Array(diff).fill(null).concat(previousData);
        previousDates = Array(diff).fill("").concat(previousDates);
      }
    }

    const currentDataset = {
      label,
      data: currentData,
      metaDates: currentDates,
      isComparison: false,
      borderColor: palette.line,
      borderWidth: 3.2,
      tension: 0.42,
      cubicInterpolationMode: "monotone",
      spanGaps: true,
      fill: "origin",
      pointRadius: 3,
      pointHoverRadius: 6,
      pointBackgroundColor: palette.point,
      pointBorderColor: pointOutline,
      pointBorderWidth: 1.5,
      pointHoverBorderWidth: 2,
      backgroundColor(context) {
        const { chart } = context;
        const { ctx: chartCtx, chartArea } = chart;
        if (!chartArea) return "rgba(59,130,246,0.20)";
        const gradient = chartCtx.createLinearGradient(
          0,
          chartArea.top,
          0,
          chartArea.bottom,
        );
        gradient.addColorStop(0, palette.fillTop);
        gradient.addColorStop(0.55, palette.fillMid);
        gradient.addColorStop(1, palette.fillBottom);
        return gradient;
      },
    };

    const datasets = [currentDataset];

    if (state.chartCompareEnabled && previousData.length) {
      datasets.push({
        label: `${label} (${compareModeShortLabel()})`,
        data: previousData,
        metaDates: previousDates,
        isComparison: true,
        borderColor: palette.compare,
        borderWidth: 2,
        borderDash: [7, 6],
        tension: 0.42,
        cubicInterpolationMode: "monotone",
        spanGaps: true,
        fill: false,
        pointRadius: 2,
        pointHoverRadius: 4,
        pointBackgroundColor: palette.compare,
        pointBorderColor: compareOutline,
        pointBorderWidth: 1.2,
      });
    }

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: 14, right: 14, left: 8, bottom: 6 } },
      elements: {
        line: { capBezierPoints: true },
      },
      plugins: {
        legend: {
          display: false,
          position: "bottom",
          labels: {
            usePointStyle: true,
            boxWidth: 10,
            boxHeight: 10,
            color: chartTitle,
            font: { weight: "700" },
          },
        },
        tooltip: {
          backgroundColor: "rgba(15,23,42,0.92)",
          borderColor: "rgba(148,163,184,0.35)",
          borderWidth: 1,
          titleColor: "#f8fafc",
          bodyColor: "#e2e8f0",
          displayColors: true,
          callbacks: {
            title(items) {
              const index = items?.[0]?.dataIndex ?? 0;
              const currentDate = currentDates[index];
              return currentDate ? `Dia ${formatDateBr(currentDate)}` : "Dia";
            },
            label(context) {
              const val = context.parsed?.y;
              return `${context.dataset.label}: ${valueFormatter(val, metric)}`;
            },
            afterLabel(context) {
              const refDate = context.dataset?.metaDates?.[context.dataIndex];
              if (!refDate) return "";
              if (context.dataset?.isComparison) return `Referencia: ${formatDateBr(refDate)}`;
              return `Data: ${formatDateBr(refDate)}`;
            },
          },
        },
        pointValueLabels: {
          enabled: false,
          metric,
          datasetIndex: 0,
          maxLabels: 11,
          formatter: (raw) => valueFormatter(raw, metric),
        },
        adsChartBackdrop: {
          columns: 8,
          metric,
        },
      },
      scales: {
        x: {
          title: {
            display: true,
            text: sameMonth ? "Dias do mes" : "Dia/Mes",
            color: chartTitle,
            font: { weight: "700" },
          },
          grid: {
            color: chartGrid,
            drawBorder: false,
            tickLength: 0,
          },
          ticks: {
            color: chartText,
            autoSkip: true,
            maxTicksLimit: 14,
            callback: (val) => String(labels[val] ?? ""),
          },
        },
        y: {
          beginAtZero: true,
          grace: "12%",
          title: { display: true, text: label, color: chartTitle, font: { weight: "700" } },
          grid: {
            color: chartGrid,
            drawBorder: false,
            borderDash: [4, 4],
          },
          ticks: {
            color: chartText,
            callback(value) {
              return tickFmt(value);
            },
          },
        },
      },
    };

    if (state.chart) {
      state.chart.data.labels = labels;
      state.chart.data.datasets = datasets;
      state.chart.options = options;
      state.chart.update();
    } else {
      state.chart = new Chart(ctx, {
        type: "line",
        data: { labels, datasets },
        options,
        plugins: [adsChartBackdropPlugin, pointValueLabelsPlugin],
      });
    }

    syncChartHeader();
  }

  // ==========================================
  // Wizard Criar Campanha
  // ==========================================
  const wizard = state.wizard;

  function wizardSelectedIds() {
    return Array.from(wizard.selected.keys());
  }

  function wizardSelectedCount() {
    return wizard.selected.size;
  }

  function wizardSetMessage(text, isError = false) {
    const el = qs("#wizardCreateMessage");
    if (!el) return;
    el.textContent = text || "";
    el.style.color = isError ? "#b91c1c" : "#64748b";
  }

  function wizardUpdateSelectedLabels() {
    const count = wizardSelectedCount();
    const label = `${count} anuncio${count === 1 ? "" : "s"} selecionado${
      count === 1 ? "" : "s"
    }`;

    setText("wizardSelectedCount", label);
    setText("wizardSelectedCountStep2", label);

    const step2Btn = qs("#wizardStepBtn2");
    if (step2Btn) step2Btn.disabled = count === 0;

    const nextBtn = qs("#wizardNextBtn");
    if (nextBtn) nextBtn.disabled = count === 0;

    const createBtn = qs("#wizardCreateBtn");
    if (createBtn && wizard.mode === "append") createBtn.disabled = count === 0;
  }

  function wizardSyncStatusChips() {
    const current = String(wizard.status || "all");
    qsa("#wizardStatusChips .ads-status-chip").forEach((chip) => {
      const status = String(chip.getAttribute("data-status") || "all");
      const active = status === current;
      chip.classList.toggle("is-active", active);
      chip.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function wizardSetItemsLoading(loading) {
    const isLoading = !!loading;

    const refreshBtn = qs("#wizardRefreshItemsBtn");
    if (refreshBtn) {
      refreshBtn.classList.toggle("is-loading", isLoading);
      refreshBtn.disabled = isLoading;
      refreshBtn.textContent = isLoading ? "Buscando..." : "Atualizar lista";
    }

    const searchField = qs(".ads-wizard-field--search");
    if (searchField) searchField.classList.toggle("is-loading", isLoading);

    const searchInput = qs("#wizardSearchInput");
    if (searchInput) searchInput.disabled = isLoading;

    const statusFilter = qs("#wizardStatusFilter");
    if (statusFilter) statusFilter.disabled = isLoading;

    qsa("#wizardStatusChips .ads-status-chip").forEach((chip) => {
      chip.disabled = isLoading;
    });
  }

  function wizardUpdateCheckAll() {
    const input = qs("#wizardCheckAll");
    if (!input) return;

    if (!wizard.items.length) {
      input.checked = false;
      input.indeterminate = false;
      return;
    }

    const checkedCount = wizard.items.filter((it) =>
      wizard.selected.has(String(it.item_id))
    ).length;

    input.checked = checkedCount > 0 && checkedCount === wizard.items.length;
    input.indeterminate =
      checkedCount > 0 && checkedCount < wizard.items.length;
  }

  function wizardUpdateNameCounter() {
    const input = qs("#wizardCampaignName");
    const count = (input?.value || "").length;
    setText("wizardCampaignNameCount", `${count} / 30`);
  }

  function wizardSetRoas(value) {
    const n = Number(value);
    const roas = isFinite(n) ? Math.min(35, Math.max(1, n)) : 6;

    const range = qs("#wizardRoasRange");
    const input = qs("#wizardRoasInput");
    if (range) range.value = String(roas);
    if (input) input.value = String(roas);

    setText("wizardRoasPreview", `${fmtNumber(roas, 1)}x`);

    qsa(".ads-roas-chip").forEach((chip) => {
      const chipRoas = Number(chip.getAttribute("data-roas"));
      const active = isFinite(chipRoas) && chipRoas === roas;
      chip.classList.toggle("is-active", active);
      chip.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function wizardUpdateBudgetHint() {
    const budgetValue = Number(qs("#wizardDailyBudget")?.value || "0");
    const dailyBudget = isFinite(budgetValue) && budgetValue > 0 ? budgetValue : 0;
    const monthlyEstimate = dailyBudget * 30;
    setText(
      "wizardBudgetMonthlyHint",
      `Consumo estimado no mes: ${fmtMoney(monthlyEstimate)}`
    );
  }

  function wizardUpdateStepVisuals() {
    const step = Number(wizard.step) === 2 ? 2 : 1;
    setText("wizardStepIndicator", `Etapa ${step} de 2`);
    const progressFill = qs("#wizardProgressFill");
    if (progressFill) progressFill.style.width = step === 1 ? "50%" : "100%";
  }

  function wizardRenderPagination() {
    const container = qs("#wizardItemsPagination");
    if (!container) return;

    const total = Number(wizard.total || wizard.items.length || 0);
    const totalPages = Math.max(1, Math.ceil(total / wizard.limit));
    const current = Math.min(Math.max(1, wizard.page), totalPages);
    wizard.page = current;

    container.innerHTML = `
      <button data-page="prev" ${current === 1 ? "disabled" : ""}>&lt;</button>
      <button disabled class="ads-pagination__label">Pagina ${current} de ${totalPages}</button>
      <button data-page="next" ${current === totalPages ? "disabled" : ""}>&gt;</button>
    `;
  }

  function wizardRenderItems() {
    const tbody = qs("#wizardItemsBody");
    if (!tbody) return;

    if (wizard.loading) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted">Carregando anuncios...</td></tr>`;
      return;
    }

    if (!wizard.items.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted">Nenhum anuncio encontrado com os filtros atuais.</td></tr>`;
      wizardRenderPagination();
      wizardUpdateCheckAll();
      wizardUpdateSelectedLabels();
      return;
    }

    const rows = wizard.items
      .map((item) => {
        const itemId = String(item.item_id || "");
        const title = item.title || itemId || "Anuncio";
        const checked = wizard.selected.has(itemId);

        const thumbHtml = item.thumbnail
          ? `<img src="${esc(item.thumbnail)}" alt="${esc(title)}">`
          : `<span>${esc(title.trim().charAt(0).toUpperCase() || "A")}</span>`;

        const campaign = item.current_campaign || null;
        const campaignName = cleanCampaignLabel(campaign?.name) || "Sem campanha";
        const campaignStatusText = campaign?.status
          ? String(campaign.status)
          : "sem campanha";
        const campaignStatus = campaignStatusText.toLowerCase();
        const campaignStatusClass =
          campaignStatus === "active"
            ? "is-active"
            : campaignStatus === "paused"
            ? "is-paused"
            : "";

        return `
          <tr>
            <td class="check-col">
              <input type="checkbox" data-wizard-item-id="${esc(itemId)}" ${
          checked ? "checked" : ""
        }>
            </td>
            <td>
              <div class="ads-wizard-item">
                <div class="ads-wizard-item__thumb">${thumbHtml}</div>
                <div>
                  <div class="ads-wizard-item__title" title="${esc(title)}">${esc(
          title
        )}</div>
                  <div class="ads-wizard-item__meta">MLB: ${esc(itemId)}${
          item.sku ? ` | SKU: ${esc(item.sku)}` : ""
        }</div>
                </div>
              </div>
            </td>
            <td>
              <div class="ads-wizard-campaign">
                <span class="ads-wizard-campaign__name">${esc(campaignName)}</span>
                <span class="ads-wizard-campaign__status ${campaignStatusClass}">${esc(
          campaignStatusText
        )}</span>
              </div>
            </td>
            <td class="num">${fmtNumber(item.sales_last_30d || 0)}</td>
          </tr>
        `;
      })
      .join("");

    tbody.innerHTML = rows;
    wizardRenderPagination();
    wizardUpdateCheckAll();
    wizardUpdateSelectedLabels();
  }

  async function wizardLoadItems({ resetPage = false } = {}) {
    if (resetPage) wizard.page = 1;
    const requestToken = ++wizard.loadToken;

    wizard.loading = true;
    wizardSetItemsLoading(true);
    wizardSetMessage("");
    wizardRenderItems();

    const params = new URLSearchParams();
    params.set("page", String(wizard.page));
    params.set("limit", String(wizard.limit));
    if (wizard.query) params.set("query", wizard.query);
    if (wizard.status) params.set("status", wizard.status);

    const url = wizard.mode === "append" && wizard.targetCampaignId
      ? withBase(
          `/api/publicidade/product-ads/campaigns/${encodeURIComponent(
            wizard.targetCampaignId
          )}/available-items?${params.toString()}`
        )
      : withBase(
          `/api/publicidade/product-ads/campaign-wizard/items?${params.toString()}`
        );

    try {
      const r = await fetch(url, { credentials: "same-origin" });
      const txt = await r.text().catch(() => "");
      const data = txt ? JSON.parse(txt) : {};
      if (requestToken !== wizard.loadToken) return;

      if (!r.ok || !data?.success) {
        wizard.items = [];
        wizard.total = 0;
        wizardSetMessage(
          data?.error || `Falha ao carregar anuncios (HTTP ${r.status}).`,
          true
        );
        return;
      }

      wizard.items = Array.isArray(data.items) ? data.items : [];
      wizard.total = Number(data?.paging?.total || wizard.items.length || 0);
      wizard.salesRange = {
        from: data?.date_from_sales || null,
        to: data?.date_to_sales || null,
      };

      const rangeText =
        wizard.salesRange.from && wizard.salesRange.to
          ? `Vendas no Mercado Livre: ${wizard.salesRange.from} a ${wizard.salesRange.to}`
          : "Vendas no Mercado Livre: ultimos 30 dias";
      setText("wizardSalesRange", rangeText);
    } catch (e) {
      if (requestToken !== wizard.loadToken) return;
      wizard.items = [];
      wizard.total = 0;
      wizardSetMessage(
        `Erro ao carregar anuncios do wizard: ${e?.message || e}`,
        true
      );
    } finally {
      if (requestToken !== wizard.loadToken) return;
      wizard.loading = false;
      wizardSetItemsLoading(false);
      wizardRenderItems();
    }
  }

  function wizardSetStep(step) {
    const selected = wizardSelectedCount();
    const targetStep = Number(step) === 2 ? 2 : 1;

    if (wizard.mode === "append") {
      wizard.step = 1;
      const panel1 = qs("#wizardStep1Panel");
      const panel2 = qs("#wizardStep2Panel");
      if (panel1) panel1.hidden = false;
      if (panel2) panel2.hidden = true;

      const btn1 = qs("#wizardStepBtn1");
      const btn2 = qs("#wizardStepBtn2");
      if (btn1) btn1.classList.add("is-active");
      if (btn2) btn2.hidden = true;
      if (btn1) btn1.hidden = true;

      const backBtn = qs("#wizardBackBtn");
      const nextBtn = qs("#wizardNextBtn");
      const createBtn = qs("#wizardCreateBtn");
      if (backBtn) backBtn.hidden = true;
      if (nextBtn) nextBtn.hidden = true;
      if (createBtn) {
        createBtn.hidden = false;
        createBtn.textContent = "Adicionar anuncios";
        createBtn.disabled = selected === 0;
      }

      setText(
        "wizardSubtitle",
        "Selecione os anuncios que deseja adicionar na campanha atual."
      );
      wizardUpdateStepVisuals();
      wizardUpdateSelectedLabels();
      return;
    }

    if (targetStep === 2 && selected === 0) {
      wizardSetMessage("Selecione ao menos 1 anuncio para continuar.", true);
      return;
    }

    wizard.step = targetStep;

    const panel1 = qs("#wizardStep1Panel");
    const panel2 = qs("#wizardStep2Panel");
    if (panel1) panel1.hidden = wizard.step !== 1;
    if (panel2) panel2.hidden = wizard.step !== 2;

    const btn1 = qs("#wizardStepBtn1");
    const btn2 = qs("#wizardStepBtn2");
    if (btn1) btn1.classList.toggle("is-active", wizard.step === 1);
    if (btn2) {
      btn2.classList.toggle("is-active", wizard.step === 2);
      btn2.disabled = selected === 0;
    }

    const backBtn = qs("#wizardBackBtn");
    const nextBtn = qs("#wizardNextBtn");
    const createBtn = qs("#wizardCreateBtn");
    if (backBtn) backBtn.hidden = wizard.step === 1;
    if (nextBtn) {
      nextBtn.hidden = wizard.step === 2;
      nextBtn.disabled = selected === 0;
    }
    if (createBtn) {
      createBtn.hidden = wizard.step === 1;
      createBtn.textContent = "Criar campanha";
    }

    setText(
      "wizardSubtitle",
      wizard.step === 1
        ? "Passo 1 de 2 - selecione os anuncios patrocinados"
        : "Passo 2 de 2 - configure e crie a campanha"
    );

    wizardUpdateStepVisuals();
    wizardUpdateSelectedLabels();
  }

  function wizardReset() {
    wizard.loadToken += 1;
    wizard.mode = "create";
    wizard.targetCampaignId = null;
    wizard.targetCampaignName = "";
    wizard.step = 1;
    wizard.loading = false;
    wizard.creating = false;
    wizard.page = 1;
    wizard.limit = 20;
    wizard.total = 0;
    wizard.query = "";
    wizard.status = "all";
    wizard.items = [];
    wizard.selected = new Map();
    wizard.salesRange = { from: null, to: null };

    const searchInput = qs("#wizardSearchInput");
    const statusFilter = qs("#wizardStatusFilter");
    const nameInput = qs("#wizardCampaignName");
    const budgetInput = qs("#wizardDailyBudget");
    const checkAll = qs("#wizardCheckAll");

    if (searchInput) searchInput.value = "";
    if (statusFilter) statusFilter.value = "all";
    if (nameInput) nameInput.value = "";
    if (budgetInput) budgetInput.value = "50";
    if (checkAll) {
      checkAll.checked = false;
      checkAll.indeterminate = false;
    }

    wizardSetRoas(6);
    wizardUpdateBudgetHint();
    wizardSyncStatusChips();
    wizardSetItemsLoading(false);
    wizardUpdateNameCounter();
    wizardSetMessage("");
    wizardSetStep(1);
  }

  function wizardOpen(mode = "create", campaign = null) {
    const modal = qs("#campaignWizardModal");
    if (!modal) return;

    wizardReset();
    wizard.mode = mode === "append" ? "append" : "create";
    wizard.targetCampaignId = campaign ? campaignIdOf(campaign) : null;
    wizard.targetCampaignName = cleanCampaignLabel(campaign?.name) || "";
    wizard.open = true;
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    syncBodyScrollLock();
    setText(
      "wizardTitle",
      wizard.mode === "append"
        ? `Adicionar anuncios${wizard.targetCampaignName ? ` em ${wizard.targetCampaignName}` : ""}`
        : "Criar campanha de Product Ads"
    );
    const stepIndicator = qs("#wizardStepIndicator");
    if (stepIndicator) {
      stepIndicator.textContent =
        wizard.mode === "append" ? "Adicionar anuncios" : "Etapa 1 de 2";
    }
    const progressFill = qs("#wizardProgressFill");
    if (progressFill) {
      progressFill.style.width = wizard.mode === "append" ? "100%" : "50%";
    }
    const btn1 = qs("#wizardStepBtn1");
    const btn2 = qs("#wizardStepBtn2");
    if (btn1) btn1.hidden = wizard.mode === "append";
    if (btn2) btn2.hidden = wizard.mode === "append";
    wizardSetStep(1);
    wizardLoadItems({ resetPage: true });
  }

  function wizardClose() {
    const modal = qs("#campaignWizardModal");
    if (!modal) return;

    wizard.open = false;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    syncBodyScrollLock();
  }

  async function wizardCreateCampaign() {
    if (wizard.creating) return;

    const name = String(qs("#wizardCampaignName")?.value || "").trim();
    const roasValue =
      qs("#wizardRoasInput")?.value || qs("#wizardRoasRange")?.value || "0";
    const budgetValue = qs("#wizardDailyBudget")?.value || "0";
    const roasTarget = Number(roasValue);
    const dailyBudget = Number(budgetValue);
    const itemIds = wizardSelectedIds();

    if (!itemIds.length) {
      wizardSetMessage("Selecione ao menos 1 anuncio no passo 1.", true);
      wizardSetStep(1);
      return;
    }

    if (wizard.mode !== "append" && (!name || name.length < 3 || name.length > 30)) {
      wizardSetMessage("Nome da campanha deve ter entre 3 e 30 caracteres.", true);
      return;
    }

    if (wizard.mode !== "append" && (!isFinite(roasTarget) || roasTarget <= 0)) {
      wizardSetMessage("Informe um ROAS objetivo valido.", true);
      return;
    }

    if (wizard.mode !== "append" && (!isFinite(dailyBudget) || dailyBudget <= 0)) {
      wizardSetMessage("Informe um orcamento diario valido.", true);
      return;
    }

    wizard.creating = true;
    const createBtn = qs("#wizardCreateBtn");
    if (createBtn) createBtn.disabled = true;

    wizardSetMessage(
      wizard.mode === "append"
        ? "Adicionando anuncios na campanha..."
        : "Criando campanha e vinculando anuncios..."
    );

    try {
      const endpoint =
        wizard.mode === "append" && wizard.targetCampaignId
          ? withBase(
              `/api/publicidade/product-ads/campaigns/${encodeURIComponent(
                wizard.targetCampaignId
              )}/items`
            )
          : withBase("/api/publicidade/product-ads/campaigns");
      const body =
        wizard.mode === "append"
          ? { item_ids: itemIds }
          : {
              name,
              roas_target: roasTarget,
              daily_budget: dailyBudget,
                    item_ids: itemIds,
            };

      const r = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const txt = await r.text().catch(() => "");
      const data = txt ? JSON.parse(txt) : {};

      if (!r.ok || !data?.success) {
        wizardSetMessage(
          data?.error || `Falha ao criar campanha (HTTP ${r.status}).`,
          true
        );
        wizard.creating = false;
        if (createBtn) createBtn.disabled = false;
        return;
      }

      const linked = Number(data?.selection?.linked_count || 0);
      const total = Number(data?.selection?.total_selected || itemIds.length);
      const warnings = Array.isArray(data?.warnings) ? data.warnings : [];

      wizardSetMessage(
        warnings.length
          ? `${
              wizard.mode === "append" ? "Anuncios adicionados" : "Campanha criada"
            } (${linked}/${total} vinculados). ${warnings.join(" ")}`
          : `${
              wizard.mode === "append"
                ? "Anuncios adicionados com sucesso"
                : "Campanha criada com sucesso"
            } (${linked}/${total} anuncios vinculados).`
      );

      await carregarCampanhas();
      if (wizard.mode === "append" && wizard.targetCampaignId) {
        state.itemsByCampaign.delete(String(wizard.targetCampaignId));
        await carregarItensCampanha(String(wizard.targetCampaignId));
        if (state.chartScope === "campaign") {
          await carregarMetricasDiarias({
            campaignId: String(wizard.targetCampaignId),
          });
        }
      }
      wizardClose();
    } catch (e) {
      wizardSetMessage(
        `${
          wizard.mode === "append" ? "Erro ao adicionar anuncios" : "Erro ao criar campanha"
        }: ${e?.message || e}`,
        true
      );
    } finally {
      wizard.creating = false;
      if (createBtn) createBtn.disabled = false;
    }
  }

  function openAddItemsForSelectedCampaign() {
    const campaign = getSelectedCampaign();
    if (!campaign) return;
    wizardOpen("append", campaign);
  }

  async function patchCampaign(campaignId, payload) {
    const id = String(campaignId || "").trim();
    if (!id) throw new Error("Campanha invalida.");
    throw new Error(
      "O Mercado Livre nao permite editar campanhas Product Ads por integracao. Abra a Publicidade do Mercado Livre para fazer esta alteracao."
    );
  }

  async function refreshAfterCampaignPatch(campaignId) {
    await carregarCampanhas();
    if (state.focusMode && state.selectedCampaignId) {
      const id = String(campaignId || state.selectedCampaignId);
      if (id) {
        await carregarMetricasDiarias({ campaignId: id });
      }
    }
  }

  async function saveFocusFieldModal() {
    if (
      !state.focusFieldEdit.open ||
      state.focusFieldEdit.saving ||
      state.focusFieldEdit.statusSaving
    ) {
      return;
    }

    const field = state.focusFieldEdit.field === "roas" ? "roas" : "budget";
    const campaign = getCampaignById(state.focusFieldEdit.campaignId);
    const campaignId = campaignIdOf(campaign);
    const inputEl = qs("#focusFieldModalInput");
    if (!campaign || !campaignId || !inputEl) return;

    const raw = String(inputEl.value || "").trim().replace(",", ".");
    let value = Number(raw);
    if (!isFinite(value)) {
      setFocusFieldModalMessage("Informe um valor valido.", "error");
      inputEl.focus();
      return;
    }

    if (field === "budget" && value <= 0) {
      setFocusFieldModalMessage(
        "O orcamento diario precisa ser maior que zero.",
        "error"
      );
      inputEl.focus();
      return;
    }

    if (field === "roas" && value <= 0) {
      setFocusFieldModalMessage(
        "O ROAS objetivo precisa ser maior que zero.",
        "error"
      );
      inputEl.focus();
      return;
    }

    value = Math.round(value * 100) / 100;
    const payload = field === "budget" ? { daily_budget: value } : { roas_target: value };
    const label = field === "budget" ? "orcamento diario" : "ROAS objetivo";

    state.focusFieldEdit.saving = true;
    setFocusFieldModalMessage(`Salvando ${label}...`);
    setFocusInlineFeedback(`Salvando ${label}...`);
    syncFocusFieldModal();
    syncCampaignFocusHeader(campaign);

    try {
      await patchCampaign(campaignId, payload);
      await refreshAfterCampaignPatch(campaignId);
      closeFocusFieldModal();
      setFocusInlineFeedback(`${label} atualizado com sucesso.`, "success");
    } catch (e) {
      const msg = e?.message || `Falha ao salvar ${label}.`;
      setFocusFieldModalMessage(msg, "error");
      setFocusInlineFeedback(msg, "error");
    } finally {
      state.focusFieldEdit.saving = false;
      if (state.focusFieldEdit.open) {
        syncFocusFieldModal();
      }
      syncCampaignFocusHeader();
    }
  }

  function closeCampaignStatusConfirmModal(force = false) {
    if (state.statusConfirm.saving && !force) return;
    const modal = qs("#campaignStatusConfirmModal");
    if (!modal) return;

    state.statusConfirm.open = false;
    state.statusConfirm.campaignId = null;
    state.statusConfirm.nextStatus = "active";
    state.statusConfirm.showInlineFeedback = false;
    state.statusConfirm.saving = false;

    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    setStatusConfirmMessage("");
    syncBodyScrollLock();
  }

  function syncCampaignStatusConfirmModal() {
    const modal = qs("#campaignStatusConfirmModal");
    if (!modal || !state.statusConfirm.open) return;

    const campaign = getCampaignById(state.statusConfirm.campaignId);
    if (!campaign) {
      closeCampaignStatusConfirmModal(true);
      return;
    }

    const normalizedStatus = isCampaignPausedStatus(state.statusConfirm.nextStatus)
      ? "paused"
      : "active";
    const actionVerb = normalizedStatus === "active" ? "ativar" : "pausar";
    const nextStatusLabel = normalizedStatus === "active" ? "ATIVA" : "PAUSADA";
    const campaignName = cleanCampaignLabel(campaign.name) || campaignIdOf(campaign) || "campanha selecionada";

    setText(
      "campaignStatusConfirmTitle",
      normalizedStatus === "active"
        ? "Confirmar ativacao da campanha"
        : "Confirmar pausa da campanha"
    );
    setText(
      "campaignStatusConfirmSubtitle",
      normalizedStatus === "active"
        ? `Voce esta prestes a ${actionVerb} a campanha ${campaignName}.`
        : `Deseja desativar esta campanha no Mercado Livre? ${campaignName}`
    );
    setText(
      "campaignStatusConfirmHint",
      normalizedStatus === "active"
        ? `Novo estado apos a confirmacao: ${nextStatusLabel}.`
        : "Essa acao pausa a campanha no marketplace sem precisar abrir o Mercado Livre."
    );

    const closeBtn = qs("#campaignStatusConfirmCloseBtn");
    const cancelBtn = qs("#campaignStatusConfirmCancelBtn");
    const confirmBtn = qs("#campaignStatusConfirmConfirmBtn");
    if (closeBtn) closeBtn.disabled = !!state.statusConfirm.saving;
    if (cancelBtn) cancelBtn.disabled = !!state.statusConfirm.saving;
    if (confirmBtn) {
      confirmBtn.disabled = !!state.statusConfirm.saving;
      confirmBtn.textContent =
        normalizedStatus === "active" ? "Ativar campanha" : "Pausar campanha";
    }
  }

  function openCampaignStatusConfirmModal(campaignId, nextStatus, opts = {}) {
    if (
      state.focusFieldEdit.saving ||
      state.focusFieldEdit.statusSaving ||
      state.statusConfirm.saving
    ) {
      return;
    }

    const id = String(campaignId || "").trim();
    const campaign = getCampaignById(id);
    const modal = qs("#campaignStatusConfirmModal");
    if (!campaign || !id || !modal) return;
    const normalizedNextStatus = isCampaignPausedStatus(nextStatus) ? "paused" : "active";

    if (normalizedNextStatus === "active") {
      updateCampaignStatus(id, "active", {
        showInlineFeedback: !!opts?.showInlineFeedback,
        suppressAlert: true,
        onError: (msg) => showAdsToast(msg, "error"),
      });
      return;
    }

    state.statusConfirm.open = true;
    state.statusConfirm.campaignId = id;
    state.statusConfirm.nextStatus = normalizedNextStatus;
    state.statusConfirm.showInlineFeedback = !!opts?.showInlineFeedback;
    state.statusConfirm.saving = false;

    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    setStatusConfirmMessage("");
    syncBodyScrollLock();
    syncCampaignStatusConfirmModal();
    qs("#campaignStatusConfirmConfirmBtn")?.focus();
  }

  async function confirmCampaignStatusChange() {
    if (!state.statusConfirm.open || state.statusConfirm.saving) return;

    const campaignId = String(state.statusConfirm.campaignId || "").trim();
    if (!campaignId) return;

    const nextStatus = state.statusConfirm.nextStatus;
    const showInlineFeedback = !!state.statusConfirm.showInlineFeedback;

    state.statusConfirm.saving = true;
    setStatusConfirmMessage("Atualizando status...");
    syncCampaignStatusConfirmModal();

    const ok = await updateCampaignStatus(campaignId, nextStatus, {
      showInlineFeedback,
      suppressAlert: true,
      onError: (msg) => setStatusConfirmMessage(msg, "error"),
    });

    state.statusConfirm.saving = false;
    if (ok) {
      closeCampaignStatusConfirmModal(true);
      return;
    }

    if (!String(qs("#campaignStatusConfirmMessage")?.textContent || "").trim()) {
      setStatusConfirmMessage("Falha ao atualizar status da campanha.", "error");
    }
    syncCampaignStatusConfirmModal();
  }

  async function updateCampaignStatus(campaignId, nextStatus, opts = {}) {
    if (state.focusFieldEdit.saving || state.focusFieldEdit.statusSaving) return false;
    const id = String(campaignId || "").trim();
    const campaign = getCampaignById(id);
    if (!campaign || !id) return false;

    const normalizedStatus = isCampaignPausedStatus(nextStatus) ? "paused" : "active";
    const showInlineFeedback = !!opts?.showInlineFeedback;
    const suppressAlert = !!opts?.suppressAlert;
    const onError = typeof opts?.onError === "function" ? opts.onError : null;

    state.focusFieldEdit.statusSaving = true;
    if (showInlineFeedback) {
      setFocusInlineFeedback(
        normalizedStatus === "active" ? "Ativando campanha..." : "Pausando campanha..."
      );
    }
    if (state.focusMode) {
      syncCampaignFocusHeader(campaign);
    }

    try {
      await patchCampaign(id, { status: normalizedStatus });
      await refreshAfterCampaignPatch(id);
      if (showInlineFeedback) {
        setFocusInlineFeedback(
          normalizedStatus === "active" ? "Campanha ativada." : "Campanha pausada.",
          "success"
        );
      }
      showAdsToast(
        normalizedStatus === "active"
          ? "Campanha ativada com sucesso"
          : "Campanha desativada com sucesso",
        "success"
      );
      return true;
    } catch (e) {
      const msg = e?.message || "Falha ao atualizar status da campanha.";
      if (showInlineFeedback) setFocusInlineFeedback(msg, "error");
      if (onError) onError(msg);
      if (!onError && !showInlineFeedback && !suppressAlert) window.alert(msg);
      if (!onError && suppressAlert) showAdsToast(msg, "error");
      return false;
    } finally {
      state.focusFieldEdit.statusSaving = false;
      if (state.focusFieldEdit.open) syncFocusFieldModal();
      if (state.focusMode) syncCampaignFocusHeader();
    }
  }

  function toggleFocusCampaignStatus() {
    const campaign = getSelectedCampaign();
    const campaignId = campaignIdOf(campaign);
    if (!campaign || !campaignId) return;
    openCampaignEditModal(campaignId);
  }

  function openCampaignEditModal(campaignId = state.selectedCampaignId) {
    const campaign = (state.campaigns || []).find(
      (row) => campaignIdOf(row) === String(campaignId)
    );
    const modal = qs("#campaignEditModal");
    if (!campaign || !modal) return;

    state.editCampaign.open = true;
    state.editCampaign.campaignId = campaignIdOf(campaign);
    state.editCampaign.saving = false;

    const name = cleanCampaignLabel(campaign.name) || campaignIdOf(campaign);
    const budget = Number(campaign.daily_budget || campaign.budget || 0);
    const roas = Number(campaign.roas_target ?? campaign.goal ?? 0);
    const isPaused = String(campaign.status || "active").toLowerCase() === "paused";

    setText("campaignManageName", name);
    setText("campaignManageBudget", budget > 0 ? fmtMoney(budget) : "Nao informado");
    setText("campaignManageRoas", roas > 0 ? fmtRatioX(roas, 1) : "Nao informado");
    setText("campaignManageStatus", isPaused ? "Pausada" : "Ativa");
    setText(
      "campaignEditSubtitle",
      `Configuracao atual de ${name}. As alteracoes sao feitas na Publicidade do Mercado Livre.`
    );

    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    syncBodyScrollLock();
  }

  function closeCampaignEditModal() {
    const modal = qs("#campaignEditModal");
    if (!modal) return;
    state.editCampaign.open = false;
    state.editCampaign.campaignId = null;
    state.editCampaign.saving = false;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    syncBodyScrollLock();
  }

  function openMercadoLivreAdvertising() {
    window.open(
      "https://www.mercadolivre.com.br/advertising",
      "_blank",
      "noopener,noreferrer"
    );
  }

  async function removeCampaignItem(itemId, itemLabel = "") {
    const campaign = getSelectedCampaign();
    if (!campaign || !itemId) return;
    const campaignId = campaignIdOf(campaign);
    if (!campaignId) return;
    const label = String(itemLabel || itemId || "").trim() || String(itemId);
    const ok = window.confirm(
      `Remover o anuncio ${label} da campanha ${cleanCampaignLabel(campaign.name) || campaignId}?`
    );
    if (!ok) return;

    try {
      const r = await fetch(
        withBase(
          `/api/publicidade/product-ads/campaigns/${encodeURIComponent(
            campaignId
          )}/items/${encodeURIComponent(itemId)}`
        ),
        {
          method: "DELETE",
          credentials: "same-origin",
        }
      );
      const txt = await r.text().catch(() => "");
      const data = txt ? JSON.parse(txt) : {};
      if (!r.ok || !data?.success) {
        window.alert(data?.error || `Falha ao remover anuncio (HTTP ${r.status}).`);
        return;
      }

      state.itemsByCampaign.delete(String(campaignId));
      await carregarItensCampanha(String(campaignId));
      await carregarCampanhas();
      if (state.chartScope === "campaign") {
        await carregarMetricasDiarias({ campaignId: String(campaignId) });
      }
    } catch (e) {
      window.alert(`Erro ao remover anuncio: ${e?.message || e}`);
    }
  }

  async function updateCampaignItemStatus(itemId, status, itemLabel = "") {
    const campaign = getSelectedCampaign();
    if (!campaign || !itemId) return;
    const campaignId = campaignIdOf(campaign);
    if (!campaignId) return;

    const normalizedStatus = isCampaignPausedStatus(status) ? "paused" : "active";
    const label = String(itemLabel || itemId || "").trim() || String(itemId);

    try {
      const r = await fetch(
        withBase(
          `/api/publicidade/product-ads/campaigns/${encodeURIComponent(
            campaignId
          )}/items/${encodeURIComponent(itemId)}`
        ),
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: normalizedStatus }),
        }
      );
      const txt = await r.text().catch(() => "");
      const data = txt ? JSON.parse(txt) : {};
      if (!r.ok || !data?.success) {
        window.alert(
          data?.error ||
            `Falha ao ${normalizedStatus === "active" ? "ativar" : "pausar"} o anuncio ${label} (HTTP ${r.status}).`
        );
        return;
      }

      state.itemsByCampaign.delete(String(campaignId));
      await carregarItensCampanha(String(campaignId));
      await carregarCampanhas();
      if (state.chartScope === "campaign") {
        await carregarMetricasDiarias({ campaignId: String(campaignId) });
      }
    } catch (e) {
      window.alert(`Erro ao atualizar anuncio: ${e?.message || e}`);
    }
  }

  // ==========================================
  // Eventos de UI
  // ==========================================
  async function refreshDailySeriesForCurrentScope() {
    if (state.focusMode && state.selectedCampaignId) {
      state.chartScope = "campaign";
      syncCampaignActions();
      syncChartHeader();
      await carregarMetricasDiarias({ campaignId: state.selectedCampaignId });
      return;
    }
    state.chartScope = "overall";
    syncCampaignActions();
    syncChartHeader();
    await carregarMetricasDiarias();
  }

  function bindUI() {
    const reloadDashboard = async () => {
      await carregarCampanhas();
      if (state.focusMode && state.campaignTab === "campaign-evolution") {
        await refreshDailySeriesForCurrentScope();
      } else if (!state.focusMode && state.activeTab === "overview") {
        await refreshDailySeriesForCurrentScope();
      } else if (!state.focusMode && state.activeTab === "ads") {
        await carregarGlobalAds({ force: true });
      }
    };

    qsa("[data-ads-tab]").forEach((btn) => {
      btn.addEventListener("click", () => setWorkspaceTab(btn.getAttribute("data-ads-tab") || "overview"));
    });
    qsa("[data-campaign-tab]").forEach((btn) => {
      btn.addEventListener("click", () => setCampaignTab(btn.getAttribute("data-campaign-tab") || "campaign-overview"));
    });

    ["campaignSearchInput", "campaignStatusFilter", "campaignHealthFilter"].forEach((id) => {
      const el = qs(`#${id}`);
      if (!el) return;
      el.addEventListener(id === "campaignSearchInput" ? "input" : "change", renderCampanhas);
    });
    ["globalAdsSearchInput", "globalAdsCampaignFilter", "globalAdsDiagnosisFilter"].forEach((id) => {
      const el = qs(`#${id}`);
      if (!el) return;
      el.addEventListener(id === "globalAdsSearchInput" ? "input" : "change", () => {
        state.globalAds.page = 1;
        renderGlobalAds();
      });
    });

    const form = qs("#ads-filters");
    if (form) {
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        reloadDashboard();
      });
    }

    const periodButton = qs("#periodDropdownButton");
    const periodMenu = qs("#periodDropdownMenu");
    const compareButton = qs("#compareDropdownButton");
    const compareMenu = qs("#compareDropdownMenu");
    const customFields = qs("#periodCustomFields");
    const customFrom = qs("#customDateFrom");
    const customTo = qs("#customDateTo");
    const closePeriodMenu = () => {
      if (periodMenu) periodMenu.hidden = true;
      if (periodButton) periodButton.setAttribute("aria-expanded", "false");
    };
    const closeCompareMenu = () => {
      if (compareMenu) compareMenu.hidden = true;
      if (compareButton) compareButton.setAttribute("aria-expanded", "false");
    };

    if (periodButton && periodMenu) {
      periodButton.addEventListener("click", () => {
        const willOpen = periodMenu.hidden;
        periodMenu.hidden = !willOpen;
        periodButton.setAttribute("aria-expanded", willOpen ? "true" : "false");
        closeCompareMenu();
        if (willOpen) updatePeriodMenuRanges();
      });

      document.addEventListener("click", (ev) => {
        const control = qs("#adsPeriodControl");
        if (control && !control.contains(ev.target)) closePeriodMenu();
      });
    }

    if (compareButton && compareMenu) {
      compareButton.addEventListener("click", () => {
        const willOpen = compareMenu.hidden;
        compareMenu.hidden = !willOpen;
        compareButton.setAttribute("aria-expanded", willOpen ? "true" : "false");
        closePeriodMenu();
        const { from, to } = getDateRange();
        syncCompareSelector(from, to);
      });

      document.addEventListener("click", (ev) => {
        const control = qs(".ads-compare-control");
        if (control && !control.contains(ev.target)) closeCompareMenu();
      });
    }

    qsa("[data-period-days]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const days = Number(btn.getAttribute("data-period-days") || 30);
        const range = dateRangeForLastDays(days);
        setDateRangeInputs(range.from, range.to);
        if (customFields) customFields.hidden = true;
        closePeriodMenu();
        reloadDashboard();
      });
    });

    qsa("[data-compare-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = String(btn.getAttribute("data-compare-mode") || "previous_month");
        state.compareMode = mode === "previous_year" ? "previous_year" : "previous_month";
        writeCompareModePreference(state.compareMode);
        closeCompareMenu();
        reloadDashboard();
      });
    });

    const customPeriodButton = qs("[data-period-custom]");
    if (customPeriodButton) {
      customPeriodButton.addEventListener("click", () => {
        const { from, to } = getDateRange();
        if (customFrom) customFrom.value = from;
        if (customTo) customTo.value = to;
        if (customFields) customFields.hidden = false;
      });
    }

    const btnApplyCustomPeriod = qs("#btnApplyCustomPeriod");
    if (btnApplyCustomPeriod) {
      btnApplyCustomPeriod.addEventListener("click", () => {
        let from = customFrom?.value || "";
        let to = customTo?.value || "";
        if (!from || !to) return;
        if (from > to) {
          const tmp = from;
          from = to;
          to = tmp;
        }
        setDateRangeInputs(from, to);
        closePeriodMenu();
        reloadDashboard();
      });
    }

    const btnBackToOverview = qs("#btnBackToOverview");
    if (btnBackToOverview) {
      btnBackToOverview.addEventListener("click", () => showOverviewChart());
    }

    const selMetric = qs("#metric");
    if (selMetric) {
      selMetric.addEventListener("change", () => {
        const metric = getMetricSelected();
        atualizarGrafico(state.dailySeries || [], metric);
        syncChartHeader();
      });
    }

    qsa("[data-chart-metric]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const metric = String(btn.getAttribute("data-chart-metric") || "total_amount");
        const select = qs("#metric");
        if (select) select.value = metric;
        state.metric = metric;
        atualizarGrafico(state.dailySeries || [], metric);
        syncChartHeader();
      });
    });

    qsa("[data-daily-granularity]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const granularity = String(
          btn.getAttribute("data-daily-granularity") || "daily"
        );
        state.dailyGranularity = granularity === "weekly" ? "weekly" : "daily";
        syncDailyGranularityButtons();
        renderDailyTable(state.dailySeries || []);
      });
    });

    const chartComparePrev = qs("#chartComparePrev");
    if (chartComparePrev) {
      chartComparePrev.addEventListener("change", () => {
        state.chartCompareEnabled = !!chartComparePrev.checked;
        writeChartComparePreference(state.chartCompareEnabled);
        atualizarGrafico(state.dailySeries || [], getMetricSelected());
        syncChartHeader();
      });
    }

    const btnExport = $btnExport();
    if (btnExport) {
      btnExport.disabled = true;
      btnExport.addEventListener("click", () => {
        const id = state.selectedCampaignId;
        if (!id) return;

        const { from, to } = getDateRange();

        const url =
          withBase(`/api/publicidade/product-ads/campaigns/${encodeURIComponent(
            id
          )}/items/export.csv` +
          `?date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(
            to
          )}`);

        window.open(url, "_blank");
      });
    }

    const btnOpenWizard = qs("#btnOpenCreateCampaign");
    if (btnOpenWizard) {
      btnOpenWizard.addEventListener("click", () => wizardOpen("create"));
    }

    const btnAddItems = qs("#btnOpenAddItems");
    if (btnAddItems) {
      btnAddItems.addEventListener("click", () => openAddItemsForSelectedCampaign());
    }

    const btnShowCampaignChart = qs("#btnShowCampaignChart");
    if (btnShowCampaignChart) {
      btnShowCampaignChart.addEventListener("click", () => showCampaignChart());
    }

    const btnExitCampaignFocus = qs("#btnExitCampaignFocus");
    if (btnExitCampaignFocus) {
      btnExitCampaignFocus.addEventListener("click", () => closeCampaignWorkspace());
    }

    const btnFocusEditCampaign = qs("#btnFocusEditCampaign");
    if (btnFocusEditCampaign) {
      btnFocusEditCampaign.addEventListener("click", () =>
        openCampaignEditModal(state.selectedCampaignId)
      );
    }

    const btnFocusAddItems = qs("#btnFocusAddItems");
    if (btnFocusAddItems) {
      btnFocusAddItems.addEventListener("click", () => openAddItemsForSelectedCampaign());
    }

    const btnFocusEditBudget = qs("#btnFocusEditBudget");
    if (btnFocusEditBudget) {
      btnFocusEditBudget.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openCampaignEditModal(state.selectedCampaignId);
      });
    }

    const btnFocusEditRoas = qs("#btnFocusEditRoas");
    if (btnFocusEditRoas) {
      btnFocusEditRoas.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openCampaignEditModal(state.selectedCampaignId);
      });
    }

    const focusFieldModalSaveBtn = qs("#focusFieldModalSaveBtn");
    if (focusFieldModalSaveBtn) {
      focusFieldModalSaveBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        saveFocusFieldModal();
      });
    }

    const focusFieldModalCloseBtn = qs("#focusFieldModalCloseBtn");
    if (focusFieldModalCloseBtn) {
      focusFieldModalCloseBtn.addEventListener("click", () => closeFocusFieldModal());
    }

    const focusFieldModalCancelBtn = qs("#focusFieldModalCancelBtn");
    if (focusFieldModalCancelBtn) {
      focusFieldModalCancelBtn.addEventListener("click", () => closeFocusFieldModal());
    }

    const focusFieldBackdrop = qs("#focusFieldModal [data-focus-field-close='1']");
    if (focusFieldBackdrop) {
      focusFieldBackdrop.addEventListener("click", () => closeFocusFieldModal());
    }

    const focusFieldModalInput = qs("#focusFieldModalInput");
    if (focusFieldModalInput) {
      focusFieldModalInput.addEventListener("input", () =>
        updateFocusFieldModalHintFromInput()
      );
      focusFieldModalInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          saveFocusFieldModal();
        }
        if (ev.key === "Escape") {
          ev.preventDefault();
          closeFocusFieldModal();
        }
      });
    }

    const focusCampaignToggle = qs("#focusCampaignToggle");
    if (focusCampaignToggle) {
      focusCampaignToggle.addEventListener("click", (ev) => {
        ev.preventDefault();
        toggleFocusCampaignStatus();
      });
    }

    const statusConfirmCloseBtn = qs("#campaignStatusConfirmCloseBtn");
    if (statusConfirmCloseBtn) {
      statusConfirmCloseBtn.addEventListener("click", () =>
        closeCampaignStatusConfirmModal()
      );
    }

    const statusConfirmCancelBtn = qs("#campaignStatusConfirmCancelBtn");
    if (statusConfirmCancelBtn) {
      statusConfirmCancelBtn.addEventListener("click", () =>
        closeCampaignStatusConfirmModal()
      );
    }

    const statusConfirmConfirmBtn = qs("#campaignStatusConfirmConfirmBtn");
    if (statusConfirmConfirmBtn) {
      statusConfirmConfirmBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        confirmCampaignStatusChange();
      });
    }

    const statusConfirmBackdrop = qs(
      "#campaignStatusConfirmModal [data-status-confirm-close='1']"
    );
    if (statusConfirmBackdrop) {
      statusConfirmBackdrop.addEventListener("click", () =>
        closeCampaignStatusConfirmModal()
      );
    }

    const wizardCloseBtn = qs("#wizardCloseBtn");
    if (wizardCloseBtn) wizardCloseBtn.addEventListener("click", wizardClose);

    const wizardCancelBtn = qs("#wizardCancelBtn");
    if (wizardCancelBtn) wizardCancelBtn.addEventListener("click", wizardClose);

    const wizardBackdrop = qs("#campaignWizardModal [data-wizard-close='1']");
    if (wizardBackdrop) wizardBackdrop.addEventListener("click", wizardClose);

    const wizardSearchInput = qs("#wizardSearchInput");
    if (wizardSearchInput) {
      wizardSearchInput.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        wizard.query = String(wizardSearchInput.value || "").trim();
        wizardLoadItems({ resetPage: true });
      });
    }

    const wizardStatusFilter = qs("#wizardStatusFilter");
    if (wizardStatusFilter) {
      wizardStatusFilter.addEventListener("change", () => {
        wizard.status = String(wizardStatusFilter.value || "all");
        wizardSyncStatusChips();
        wizardLoadItems({ resetPage: true });
      });
    }

    const wizardStatusChips = qs("#wizardStatusChips");
    if (wizardStatusChips) {
      wizardStatusChips.addEventListener("click", (ev) => {
        const chip = ev.target.closest("button[data-status]");
        if (!chip) return;

        const status = String(chip.getAttribute("data-status") || "all");
        wizard.status = status;

        if (wizardStatusFilter) wizardStatusFilter.value = status;
        wizardSyncStatusChips();
        wizardLoadItems({ resetPage: true });
      });
    }

    const wizardRefreshBtn = qs("#wizardRefreshItemsBtn");
    if (wizardRefreshBtn) {
      wizardRefreshBtn.addEventListener("click", () => {
        wizard.query = String(qs("#wizardSearchInput")?.value || "").trim();
        wizard.status = String(qs("#wizardStatusFilter")?.value || "all");
        wizardSyncStatusChips();
        wizardLoadItems({ resetPage: true });
      });
    }

    const wizardItemsBody = qs("#wizardItemsBody");
    if (wizardItemsBody) {
      wizardItemsBody.addEventListener("change", (ev) => {
        const input = ev.target.closest("input[type='checkbox'][data-wizard-item-id]");
        if (!input) return;

        const itemId = String(input.getAttribute("data-wizard-item-id") || "");
        if (!itemId) return;

        const row = wizard.items.find((it) => String(it.item_id) === itemId);
        if (!row) return;

        if (input.checked) wizard.selected.set(itemId, row);
        else wizard.selected.delete(itemId);

        wizardUpdateSelectedLabels();
        wizardUpdateCheckAll();
      });
    }

    const wizardCheckAll = qs("#wizardCheckAll");
    if (wizardCheckAll) {
      wizardCheckAll.addEventListener("change", () => {
        if (wizardCheckAll.checked) {
          wizard.items.forEach((item) =>
            wizard.selected.set(String(item.item_id), item)
          );
        } else {
          wizard.items.forEach((item) =>
            wizard.selected.delete(String(item.item_id))
          );
        }

        wizardRenderItems();
      });
    }

    const wizardPagination = qs("#wizardItemsPagination");
    if (wizardPagination) {
      wizardPagination.addEventListener("click", (ev) => {
        const btn = ev.target.closest("button[data-page]");
        if (!btn) return;

        const totalPages = Math.max(1, Math.ceil((wizard.total || 0) / wizard.limit));
        const type = String(btn.getAttribute("data-page") || "");
        if (type === "prev" && wizard.page > 1) wizard.page -= 1;
        else if (type === "next" && wizard.page < totalPages) wizard.page += 1;
        else return;

        wizardLoadItems();
      });
    }

    const stepBtn1 = qs("#wizardStepBtn1");
    if (stepBtn1) stepBtn1.addEventListener("click", () => wizardSetStep(1));

    const stepBtn2 = qs("#wizardStepBtn2");
    if (stepBtn2) stepBtn2.addEventListener("click", () => wizardSetStep(2));

    const nextBtn = qs("#wizardNextBtn");
    if (nextBtn) nextBtn.addEventListener("click", () => wizardSetStep(2));

    const backBtn = qs("#wizardBackBtn");
    if (backBtn) backBtn.addEventListener("click", () => wizardSetStep(1));

    const createBtn = qs("#wizardCreateBtn");
    if (createBtn) createBtn.addEventListener("click", wizardCreateCampaign);

    const nameInput = qs("#wizardCampaignName");
    if (nameInput) nameInput.addEventListener("input", wizardUpdateNameCounter);

    const budgetInput = qs("#wizardDailyBudget");
    if (budgetInput) budgetInput.addEventListener("input", wizardUpdateBudgetHint);

    const roasRange = qs("#wizardRoasRange");
    if (roasRange) {
      roasRange.addEventListener("input", () => wizardSetRoas(roasRange.value));
    }

    const roasInput = qs("#wizardRoasInput");
    if (roasInput) {
      roasInput.addEventListener("input", () => wizardSetRoas(roasInput.value));
    }

    qsa(".ads-roas-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        wizardSetRoas(chip.getAttribute("data-roas"));
      });
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && state.statusConfirm.open) {
        ev.preventDefault();
        closeCampaignStatusConfirmModal();
        return;
      }
      if (ev.key === "Escape" && wizard.open) {
        wizardClose();
      }
      if (ev.key === "Escape" && state.editCampaign.open) {
        closeCampaignEditModal();
      }
      if (ev.key === "Escape" && state.focusFieldEdit.open) {
        closeFocusFieldModal();
      }
    });

    const campaignEditCloseBtn = qs("#campaignEditCloseBtn");
    if (campaignEditCloseBtn)
      campaignEditCloseBtn.addEventListener("click", closeCampaignEditModal);

    const campaignEditCancelBtn = qs("#campaignEditCancelBtn");
    if (campaignEditCancelBtn)
      campaignEditCancelBtn.addEventListener("click", closeCampaignEditModal);

    const campaignEditBackdrop = qs("#campaignEditModal [data-edit-close='1']");
    if (campaignEditBackdrop)
      campaignEditBackdrop.addEventListener("click", closeCampaignEditModal);

    const campaignManageExternalBtn = qs("#campaignManageExternalBtn");
    if (campaignManageExternalBtn)
      campaignManageExternalBtn.addEventListener(
        "click",
        openMercadoLivreAdvertising
      );
  }

  // ==========================================
  // Boot
  // ==========================================
  window.addEventListener("ml-themechange", () => {
    if (!document.getElementById("adsMetricsChart")) return;
    if (!Array.isArray(state.dailySeries)) return;
    try {
      atualizarGrafico(state.dailySeries, getMetricSelected());
    } catch (error) {
      console.warn("Nao foi possivel redesenhar o grafico ao trocar o tema.", error);
    }
  });

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      // defaults
      getDateRange();
      state.metric = getMetricSelected();
      state.chartCompareEnabled = readChartComparePreference();
      state.compareMode = readCompareModePreference();
      const routeCampaignId = readCampaignIdFromPath(window.location.pathname);
      state.pendingFocusCampaignId = routeCampaignId;
      state.focusMode = !!routeCampaignId;
      state.chartScope = routeCampaignId ? "campaign" : "overall";
      state.activeTab = "overview";
      state.campaignTab = "campaign-overview";

      bindUI();
      syncChartCompareToggle();
      syncCampaignFocusMode();
      syncCampaignActions();
      syncChartHeader();
      await carregarCampanhas();
      syncWorkspaceTabs();
      if (!state.focusMode && state.activeTab === "overview") {
        await carregarMetricasDiarias();
      }
    } catch (e) {
      console.error("Erro ao inicializar product-ads.js:", e);
    }
  });
})();

