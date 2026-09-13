let chartCpcDaily = null;
let chartCpcCampaign = null;

let selectedCpcCampaignId = null;

let cachedCampaignSeries = {};
let cachedCampaignSettings = new Map();
let cachedSettingsKey = null;
let cachedCampaignGroups = [];
let selectedCampaignGroupId = null;
let lastCpcRange = { dateFrom: null, dateTo: null };

let lastCpcCampaignRows = [];

let cpcCampaignsMaster = [];
let cpcCampaignsView = [];
let cpcPager = { page: 1, pageSize: 20, totalPages: 1 };

let cpcFilterTimer = null;
let cpcStatusBucket = "active"; // padrão Shopee: Em andamento
let lastCpcProductPerfRows = [];
let lastAdsRankingView = { allRows: [], rows: [] };
let adsIntelState = {
  dataset: null,
  strategy: null,
  selectedCampaignId: null,
  selectedCampaignIds: [],
  campaignRules: {},
  hourRulesShared: {},
  hourRulesByCampaign: {},
  automation: null,
};

(function initNeoThemeOnce() {
  if (window.NEO_THEME) return;

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return v || fallback;
  }

  window.NEO_THEME = {
    purple: cssVar("--purple", "#A855F7"),
    blue: cssVar("--blue", "#3B82F6"),
    cyan: cssVar("--cyan", "#22D3EE"),
    up: cssVar("--up", "#22C55E"),
    down: cssVar("--down", "#FF5A6A"),
    tick: "rgba(255,255,255,0.70)",
    grid: "rgba(255,255,255,0.10)",
    tooltipBg: "rgba(15,15,20,0.92)",
    tooltipBorder: "rgba(255,255,255,0.14)",
  };
})();

// Tema Neo (fonte única)
const NEO = window.NEO_THEME;

// ✅ alias de compat (seu código usa ADS_NEO em vários pontos)
window.ADS_NEO = window.NEO_THEME;
const ADS_NEO = window.ADS_NEO;

function getAdsChartThemeColors() {
  const isLight = document.body.classList.contains("theme-light");
  return {
    axis: isLight ? "rgba(15,23,42,0.78)" : "rgba(255,255,255,0.70)",
    grid: isLight ? "rgba(15,23,42,0.08)" : "rgba(255,255,255,0.10)",
    legend: isLight ? "rgba(15,23,42,0.86)" : "rgba(255,255,255,0.86)",
    tooltipBg: isLight ? "rgba(255,255,255,0.98)" : ADS_NEO.tooltipBg,
    tooltipBorder: isLight
      ? "rgba(15,23,42,0.12)"
      : ADS_NEO.tooltipBorder,
    tooltipTitle: isLight ? "rgba(15,23,42,0.92)" : "rgba(255,255,255,0.92)",
    tooltipBody: isLight ? "rgba(15,23,42,0.90)" : "rgba(255,255,255,0.90)",
  };
}

(function registerNeoGlowOnce() {
  if (!window.Chart || typeof Chart.register !== "function") return;
  if (window.__NEO_GLOW_REGISTERED__) return;

  Chart.register({
    id: "neoGlow",
    beforeDatasetDraw(chart, args) {
      const ds = chart.data.datasets?.[args.index];
      if (!ds || !ds.neoGlowColor) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.shadowBlur = ds.neoGlowBlur ?? 18;
      ctx.shadowColor = ds.neoGlowColor;
    },
    afterDatasetDraw(chart, args) {
      const ds = chart.data.datasets?.[args.index];
      if (!ds || !ds.neoGlowColor) return;
      chart.ctx.restore();
    },
  });

  window.__NEO_GLOW_REGISTERED__ = true;
})();

function fmtMoneyBR(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtNumberBR(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("pt-BR") : "—";
}

function fmtMoneyFromCents(cents) {
  const n = Number(cents || 0) / 100;
  return fmtMoneyBR(n);
}

function isoLocalDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function shiftIsoDate(isoDate, deltaDays) {
  const base = new Date(`${String(isoDate)}T12:00:00`);
  base.setDate(base.getDate() + Number(deltaDays || 0));
  return isoLocalDate(base);
}

function getAdsTodayIso() {
  return isoLocalDate(new Date());
}

async function loadCpcHourlyTodayAggregate(dateIso) {
  const j = await apiGet(
    `/shops/active/ads/cpc/hourly?dateFrom=${encodeURIComponent(
      dateIso,
    )}&dateTo=${encodeURIComponent(dateIso)}`,
  );

  const rows = Array.isArray(j?.response) ? j.response : [];
  if (!rows.length) return null;

  const totals = rows.reduce(
    (acc, row) => {
      acc.impression += Number(row?.impression || 0);
      acc.clicks += Number(row?.clicks || 0);
      acc.expense += Number(row?.expense || 0);
      acc.direct_gmv += Number(row?.direct_gmv || 0);
      acc.broad_gmv += Number(row?.broad_gmv || 0);
      acc.direct_order += Number(row?.direct_order || 0);
      acc.broad_order += Number(row?.broad_order || 0);
      acc.direct_item_sold += Number(row?.direct_item_sold || 0);
      acc.broad_item_sold += Number(row?.broad_item_sold || 0);
      return acc;
    },
    {
      impression: 0,
      clicks: 0,
      expense: 0,
      direct_gmv: 0,
      broad_gmv: 0,
      direct_order: 0,
      broad_order: 0,
      direct_item_sold: 0,
      broad_item_sold: 0,
    },
  );

  return {
    date: dateIso,
    ...totals,
    ctr: totals.impression > 0 ? (totals.clicks / totals.impression) * 100 : 0,
    direct_roas: totals.expense > 0 ? totals.direct_gmv / totals.expense : 0,
    broad_roas: totals.expense > 0 ? totals.broad_gmv / totals.expense : 0,
  };
}

function getAdsOrdersFromTotals(totals) {
  return Math.max(
    Number(totals?.broad_order || 0),
    Number(totals?.direct_order || 0),
  );
}

function getAdsItemsSoldFromTotals(totals) {
  return Math.max(
    Number(totals?.broad_item_sold || 0),
    Number(totals?.direct_item_sold || 0),
  );
}

/* ===========================
   Helpers
=========================== */

function getCpcCampaignStatusFilter() {
  const el = document.getElementById("cpcCampaignStatusFilter");
  return String(el?.value || "all");
}
function diagnosisHtml(x) {
  const exp = Number(x?.expense || 0),
    roas = Number(x?.direct_roas);
  if (exp <= 0) return badgeHtml("Sem gasto", "gray");
  if (Number.isFinite(roas) && roas < 1) return badgeHtml("ROAS baixo", "red");
  if (Number.isFinite(roas) && roas < 2) return badgeHtml("Atenção", "yellow");
  return badgeHtml("Ok", "green");
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function resetCpcPager() {
  cpcPager.page = 1;
}
function updateCpcPager(total) {
  cpcPager.totalPages = Math.max(
    1,
    Math.ceil((total || 0) / cpcPager.pageSize),
  );
  cpcPager.page = clamp(cpcPager.page, 1, cpcPager.totalPages);
}
function renderCpcPager() {
  setText(
    "cpcCampaignPageInfo",
    `Página ${cpcPager.page} de ${cpcPager.totalPages}`,
  );
  setDisabled("cpcCampaignFirst", cpcPager.page === 1);
  setDisabled("cpcCampaignPrev", cpcPager.page === 1);
  setDisabled("cpcCampaignNext", cpcPager.page === cpcPager.totalPages);
  setDisabled("cpcCampaignLast", cpcPager.page === cpcPager.totalPages);
}

function normStatus(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function getCpcStatusBucket() {
  return String(cpcStatusBucket || "active");
}

function statusBucketFromCampaignStatus(status) {
  const s = normStatus(status);
  if (!s) return "unknown";
  if (s === "1") return "scheduled";
  if (s === "2") return "active";
  if (s === "3") return "paused";
  if (s === "4") return "ended";
  if (s === "5") return "deleted";

  if (
    s.includes("sched") ||
    s.includes("upcom") ||
    s.includes("program") ||
    s.includes("not_started") ||
    s.includes("not started") ||
    s.includes("planned")
  )
    return "scheduled";

  if (s.includes("pause") || s.includes("suspend") || s.includes("hold"))
    return "paused";

  if (
    s.includes("closed") ||
    s.includes("end") ||
    s.includes("stop") ||
    s.includes("finish") ||
    s.includes("terminate") ||
    s.includes("close") ||
    s.includes("expired")
  )
    return "ended";

  if (s.includes("delete") || s.includes("remove")) return "deleted";

  if (
    s.includes("ongoing") ||
    s.includes("running") ||
    s.includes("active") ||
    s.includes("enable") ||
    s.includes("start") ||
    s.includes("in_progress") ||
    s.includes("in progress") ||
    s.includes("inprogress") ||
    s.includes("normal") ||
    s.includes("andamento") ||
    s.includes("em andamento") ||
    s.includes("ativo")
  )
    return "active";

  return "unknown";
}

function setCpcStatusBucket(next) {
  cpcStatusBucket = String(next || "active");
  localStorage.setItem("ads_cpc_status_bucket", cpcStatusBucket);

  const tabs = document.querySelectorAll("#cpcStatusTabs .status-tab");
  tabs.forEach((b) =>
    b.classList.toggle("is-active", b.dataset.status === cpcStatusBucket),
  );

  // compat: mantém o select antigo coerente
  const statusEl = document.getElementById("cpcCampaignStatusFilter");
  if (statusEl) {
    statusEl.value =
      cpcStatusBucket === "all"
        ? "all"
        : cpcStatusBucket === "active"
          ? "active"
          : "inactive";
  }
}

function isCampaignActiveStatus(status) {
  const s = normStatus(status);
  if (!s) return false;

  if (
    s.includes("ongoing") ||
    s.includes("running") ||
    s.includes("active") ||
    s.includes("enabled")
  )
    return true;

  if (
    s.includes("paused") ||
    s.includes("ended") ||
    s.includes("stopped") ||
    s.includes("disabled") ||
    s.includes("deleted")
  )
    return false;

  return false;
}

function badgeHtml(text, tone) {
  const t = escHtml(text || "—");
  const cls =
    tone === "green"
      ? "badge badge--green"
      : tone === "yellow"
        ? "badge badge--yellow"
        : tone === "red"
          ? "badge badge--red"
          : "badge badge--gray";

  return `<span class="${cls}"><span class="badge-dot"></span>${t}</span>`;
}

function statusTone(status) {
  const b = statusBucketFromCampaignStatus(status);
  if (b === "active") return "green";
  if (b === "paused") return "yellow";
  return "gray";
}

function adTypeTone(adType) {
  const s = String(adType || "").toLowerCase();
  if (s.includes("manual")) return "gray";
  if (s.includes("auto")) return "gray";
  return "gray";
}

function escAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function markSelectedCampaignRow(campaignId) {
  const id = String(campaignId || "");
  document.querySelectorAll("[data-campaign-id]").forEach((el) => {
    el.classList.toggle("is-selected", String(el.dataset.campaignId) === id);
  });
}

function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-BR");
}
function toMetricNumber(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text
    .replace(/\s+/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
function pickMetricValue(source, keys = []) {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    const n = toMetricNumber(source?.[key]);
    if (n != null) return n;
  }
  return null;
}
function fmtPct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) + "%" : "—";
}
function acosTone(acosPct) {
  const n = Number(acosPct);
  if (!Number.isFinite(n)) return "gray";
  if (n >= 50) return "red";
  if (n >= 30) return "yellow";
  return "green";
}
function fmtPctFromClicksImpr(clicks, impr) {
  const c = Number(clicks) || 0;
  const i = Number(impr) || 0;
  if (!i) return "—";
  return ((c / i) * 100).toFixed(2) + "%";
}

const ADS_CAMPAIGN_ALERT_RULES = {
  minRoas: 10,
  minCtrPct: 1,
  minAgeForLowImpressionsDays: 7,
  maxLowImpressions: 300,
  minAgeForNoSalesDays: 14,
  minClicksForNoSalesAlert: 20,
};

function parsePossibleDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const txt = String(value).trim();
  if (!txt) return null;
  if (/^\d{10,13}$/.test(txt)) {
    const raw = Number(txt);
    if (!Number.isFinite(raw)) return null;
    const ms = txt.length >= 13 ? raw : raw * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(txt);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getCampaignCreatedAt(row) {
  return (
    parsePossibleDate(row?.created_at) ||
    parsePossibleDate(row?.created_time) ||
    parsePossibleDate(row?.creation_time) ||
    null
  );
}

function getCampaignAgeDays(row) {
  const createdAt = getCampaignCreatedAt(row);
  if (!createdAt) return null;

  const now = new Date();
  const diffMs = now.getTime() - createdAt.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 0;
  return Math.floor(diffMs / 86400000);
}

function getCampaignCtrPct(row) {
  const clicks = Number(row?.clicks || 0);
  const impressions = Number(row?.impression || 0);
  if (!impressions) return null;
  return (clicks / impressions) * 100;
}

function getCampaignRoas(row) {
  const directRoas = Number(row?.direct_roas);
  if (Number.isFinite(directRoas)) return directRoas;
  const expense = Number(row?.expense || 0);
  const directGmv = Number(row?.direct_gmv || 0);
  if (expense <= 0) return null;
  return directGmv / expense;
}

function getCampaignOrdersCount(row) {
  return Math.max(
    Number(row?.broad_order || 0),
    Number(row?.direct_order || 0),
  );
}

function getCampaignAlertEntries(row) {
  const alerts = [];
  const roas = getCampaignRoas(row);
  const ctr = getCampaignCtrPct(row);
  const ageDays = getCampaignAgeDays(row);
  const impressions = Number(row?.impression || 0);
  const clicks = Number(row?.clicks || 0);
  const orders = getCampaignOrdersCount(row);
  const gmv = Number(row?.direct_gmv || 0);

  if (Number.isFinite(roas) && roas < ADS_CAMPAIGN_ALERT_RULES.minRoas) {
    alerts.push({
      key: "roas",
      tone: "red",
      label: `ROAS < ${ADS_CAMPAIGN_ALERT_RULES.minRoas}`,
      detail: `ROAS atual: ${roas.toFixed(2)}`,
    });
  }

  if (Number.isFinite(ctr) && ctr < ADS_CAMPAIGN_ALERT_RULES.minCtrPct) {
    alerts.push({
      key: "ctr",
      tone: "yellow",
      label: "CTR < 1%",
      detail: `CTR atual: ${ctr.toFixed(2)}%`,
    });
  }

  if (
    Number.isFinite(ageDays) &&
    ageDays >= ADS_CAMPAIGN_ALERT_RULES.minAgeForLowImpressionsDays &&
    impressions <= ADS_CAMPAIGN_ALERT_RULES.maxLowImpressions
  ) {
    alerts.push({
      key: "low_impressions",
      tone: "yellow",
      label: "Poucas impressões",
      detail: `${fmtInt(impressions)} impressões em ${ageDays} dias de campanha`,
    });
  }

  if (
    Number.isFinite(ageDays) &&
    ageDays >= ADS_CAMPAIGN_ALERT_RULES.minAgeForNoSalesDays &&
    orders <= 0 &&
    gmv <= 0 &&
    clicks >= ADS_CAMPAIGN_ALERT_RULES.minClicksForNoSalesAlert
  ) {
    alerts.push({
      key: "no_sales",
      tone: "red",
      label: "Sem retorno de vendas",
      detail: `Sem pedidos (${ageDays} dias de campanha)`,
    });
  }

  return alerts;
}

function renderCpcAlerts(rows) {
  const wrap = document.getElementById("cpcCampaignAlerts");
  if (!wrap) return;

  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) {
    wrap.innerHTML = "";
    return;
  }

  const counters = {
    roas: 0,
    ctr: 0,
    low_impressions: 0,
    no_sales: 0,
  };
  const campaignAlerts = [];

  for (const row of safeRows) {
    const alerts = getCampaignAlertEntries(row);
    if (!alerts.length) continue;
    campaignAlerts.push({ row, alerts });
    alerts.forEach((a) => {
      if (counters[a.key] != null) counters[a.key] += 1;
    });
  }

  const totalWithAlert = campaignAlerts.length;
  const top = campaignAlerts
    .sort((a, b) => b.alerts.length - a.alerts.length)
    .slice(0, 4);

  if (!totalWithAlert) {
    wrap.innerHTML = `
      <div class="ads-alerts__empty">
        <strong>Sem alertas críticos no filtro atual.</strong>
        <span>Todas as campanhas filtradas estão dentro dos limites monitorados.</span>
      </div>
    `;
    return;
  }

  const topHtml = top
    .map(({ row, alerts }) => {
      const id = String(row?.campaign_id || "");
      const name = escHtml(row?.ad_name || `#${id}`);
      const chips = alerts
        .map(
          (a) =>
            `<span class="ads-alert-pill ads-alert-pill--${a.tone}" title="${escAttr(
              a.detail,
            )}">${escHtml(a.label)}</span>`,
        )
        .join("");
      return `
        <button type="button" class="ads-alert-campaign" data-campaign-id="${escAttr(
          id,
        )}">
          <span class="ads-alert-campaign__title">${name}</span>
          <span class="ads-alert-campaign__chips">${chips}</span>
        </button>
      `;
    })
    .join("");

  wrap.innerHTML = `
    <div class="ads-alerts__header">
      <strong>Avisos em campanhas</strong>
      <span>${totalWithAlert} de ${safeRows.length} campanhas com atenção</span>
    </div>
    <div class="ads-alerts__kpis">
      <div class="ads-alert-kpi"><span>ROAS &lt; 10</span><strong>${fmtInt(counters.roas)}</strong></div>
      <div class="ads-alert-kpi"><span>CTR &lt; 1%</span><strong>${fmtInt(counters.ctr)}</strong></div>
      <div class="ads-alert-kpi"><span>Sem vendas</span><strong>${fmtInt(counters.no_sales)}</strong></div>
      <div class="ads-alert-kpi"><span>Poucas impressões</span><strong>${fmtInt(counters.low_impressions)}</strong></div>
    </div>
    <div class="ads-alerts__campaigns">${topHtml}</div>
  `;

  wrap.querySelectorAll(".ads-alert-campaign").forEach((el) => {
    el.addEventListener("click", () => {
      const id = String(el.getAttribute("data-campaign-id") || "");
      if (!id) return;
      selectCampaign(id);
    });
  });
}

function getAdsRankingSortBy() {
  return String(
    document.getElementById("rankingCampaignSortBy")?.value ||
      "direct_gmv_desc",
  );
}

function getAdsRankingSearch() {
  return String(
    document.getElementById("rankingCampaignFilter")?.value || "",
  ).trim();
}

function getAdsRankingStatus() {
  return String(
    document.getElementById("rankingCampaignStatus")?.value || "all",
  );
}

function getAdsRankingLimit() {
  const n = Number(document.getElementById("rankingCampaignLimit")?.value || 20);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

function getAdsRankingSourceRows(rowsFallback = []) {
  if (Array.isArray(cpcCampaignsMaster) && cpcCampaignsMaster.length) {
    return cpcCampaignsMaster;
  }
  return Array.isArray(rowsFallback) ? rowsFallback : [];
}

function compareNumbers(a, b, direction = "desc") {
  const na = Number.isFinite(Number(a)) ? Number(a) : -Infinity;
  const nb = Number.isFinite(Number(b)) ? Number(b) : -Infinity;
  return direction === "asc" ? na - nb : nb - na;
}

function sortAdsRankingRows(rows, sortBy) {
  const safeRows = Array.isArray(rows) ? [...rows] : [];
  switch (String(sortBy || "direct_gmv_desc")) {
    case "direct_gmv_asc":
      return safeRows.sort((a, b) => compareNumbers(a.direct_gmv, b.direct_gmv, "asc"));
    case "direct_roas_desc":
      return safeRows.sort((a, b) => compareNumbers(a.__roas, b.__roas, "desc"));
    case "direct_roas_asc":
      return safeRows.sort((a, b) => compareNumbers(a.__roas, b.__roas, "asc"));
    case "expense_desc":
      return safeRows.sort((a, b) => compareNumbers(a.expense, b.expense, "desc"));
    case "expense_asc":
      return safeRows.sort((a, b) => compareNumbers(a.expense, b.expense, "asc"));
    case "clicks_desc":
      return safeRows.sort((a, b) => compareNumbers(a.clicks, b.clicks, "desc"));
    case "clicks_asc":
      return safeRows.sort((a, b) => compareNumbers(a.clicks, b.clicks, "asc"));
    case "impression_desc":
      return safeRows.sort((a, b) => compareNumbers(a.impression, b.impression, "desc"));
    case "impression_asc":
      return safeRows.sort((a, b) => compareNumbers(a.impression, b.impression, "asc"));
    case "ctr_desc":
      return safeRows.sort((a, b) => compareNumbers(a.__ctr, b.__ctr, "desc"));
    case "ctr_asc":
      return safeRows.sort((a, b) => compareNumbers(a.__ctr, b.__ctr, "asc"));
    case "alerts_desc":
      return safeRows.sort(
        (a, b) =>
          compareNumbers(a.__alerts?.length, b.__alerts?.length, "desc") ||
          compareNumbers(a.direct_gmv, b.direct_gmv, "desc"),
      );
    case "direct_gmv_desc":
    default:
      return safeRows.sort((a, b) => compareNumbers(a.direct_gmv, b.direct_gmv, "desc"));
  }
}

function getAdsRankingSortLabel(sortBy) {
  const key = String(sortBy || "direct_gmv_desc");
  const labels = {
    direct_gmv_desc: "GMV direto (maior → menor)",
    direct_gmv_asc: "GMV direto (menor → maior)",
    direct_roas_desc: "ROAS (maior → menor)",
    direct_roas_asc: "ROAS (menor → maior)",
    expense_desc: "Gasto (maior → menor)",
    expense_asc: "Gasto (menor → maior)",
    clicks_desc: "Cliques (maior → menor)",
    clicks_asc: "Cliques (menor → maior)",
    impression_desc: "Impressões (maior → menor)",
    impression_asc: "Impressões (menor → maior)",
    ctr_desc: "CTR (maior → menor)",
    ctr_asc: "CTR (menor → maior)",
    alerts_desc: "Mais alertas primeiro",
  };
  return labels[key] || key;
}

function buildAdsRankingRows(rows, options = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const search = String(options.search || "").trim().toLowerCase();
  const status = String(options.status || "all");
  const sortBy = String(options.sortBy || "direct_gmv_desc");
  const limit = Number(options.limit || 20);

  let enriched = safeRows.map((row) => {
    const alerts = getCampaignAlertEntries(row);
    const roas = getCampaignRoas(row);
    const ctr = getCampaignCtrPct(row);
    return {
      ...row,
      __alerts: alerts,
      __roas: roas,
      __ctr: ctr,
    };
  });

  if (search) {
    enriched = enriched.filter((row) => {
      const name = String(row.ad_name || "").toLowerCase();
      const id = String(row.campaign_id || "").toLowerCase();
      return name.includes(search) || id.includes(search);
    });
  }

  if (status !== "all") {
    enriched = enriched.filter(
      (row) => statusBucketFromCampaignStatus(row.campaign_status) === status,
    );
  }

  const sorted = sortAdsRankingRows(enriched, sortBy).map((row, index) => ({
    ...row,
    __pos: index + 1,
  }));

  return {
    allRows: sorted,
    rows: sorted.slice(0, Math.max(1, limit)),
  };
}

function buildAdsSuggestions(rankingRows, summary) {
  const rows = Array.isArray(rankingRows) ? rankingRows : [];
  const counters = {
    roas: 0,
    ctr: 0,
    low_impressions: 0,
    no_sales: 0,
  };

  rows.forEach((row) => {
    const alerts = Array.isArray(row.__alerts) ? row.__alerts : [];
    alerts.forEach((a) => {
      if (counters[a.key] != null) counters[a.key] += 1;
    });
  });

  const suggestions = [];

  if (counters.roas > 0) {
    suggestions.push({
      tone: "red",
      type: "Atencao",
      title: `${fmtInt(counters.roas)} campanha(s) com ROAS abaixo de ${ADS_CAMPAIGN_ALERT_RULES.minRoas}`,
      text: "Reveja palavra-chave, criativo e lances para recuperar rentabilidade.",
    });
  }

  if (counters.no_sales > 0) {
    suggestions.push({
      tone: "red",
      type: "Atencao",
      title: `${fmtInt(counters.no_sales)} campanha(s) sem retorno de vendas`,
      text: "Pausar itens com baixa tracao e redistribuir budget tende a melhorar resultado.",
    });
  }

  if (counters.ctr > 0) {
    suggestions.push({
      tone: "yellow",
      type: "Oportunidade",
      title: `${fmtInt(counters.ctr)} campanha(s) com CTR abaixo de ${ADS_CAMPAIGN_ALERT_RULES.minCtrPct}%`,
      text: "Teste titulo principal, imagem e segmentacao para elevar cliques qualificados.",
    });
  }

  if (counters.low_impressions > 0) {
    suggestions.push({
      tone: "yellow",
      type: "Distribuicao",
      title: `${fmtInt(counters.low_impressions)} campanha(s) com baixa entrega`,
      text: "Ajuste orcamento, lances e cobertura de itens para aumentar alcance.",
    });
  }

  const best = rows.find(
    (row) => Number(row.direct_gmv || 0) > 0 && Number(row.__roas || 0) > 0,
  );
  if (best) {
    suggestions.push({
      tone: "ok",
      type: "Destaque",
      title: `Campanha lider: ${best.ad_name || `#${best.campaign_id}`}`,
      text: `GMV dir. ${fmtMoney(best.direct_gmv)} com ROAS ${best.__roas != null ? best.__roas.toFixed(2) : "—"}.`,
    });
  }

  const topShare = Number(summary?.topGmvShare || 0);
  if (topShare >= 45) {
    suggestions.push({
      tone: "yellow",
      type: "Risco",
      title: "Alta concentracao no top 1",
      text: `A campanha lider concentra ${topShare.toFixed(1)}% do GMV direto. Vale distribuir risco em outras campanhas.`,
    });
  }

  if (!suggestions.length) {
    suggestions.push({
      tone: "ok",
      type: "Saude",
      title: "Sem alertas criticos no recorte atual",
      text: "Campanhas estao equilibradas pelos criterios de ROAS, CTR, entrega e vendas.",
    });
  }

  return suggestions.slice(0, 6);
}

function renderAdsRankingMovement(rankingRows) {
  const el = document.getElementById("adsRankingMovement");
  if (!el) return;

  const rows = Array.isArray(rankingRows) ? rankingRows : [];
  if (!rows.length) {
    el.innerHTML =
      '<div class="ads-ranking-movement__row"><div class="ads-ranking-movement__title">Sem dados no ranking atual</div><div class="ads-ranking-movement__meta">Ajuste os filtros ou atualize os dados do Ads.</div></div>';
    return;
  }

  const topRoas = rows
    .filter((row) => Number(row.expense || 0) > 0)
    .sort((a, b) => compareNumbers(a.__roas, b.__roas, "desc"))
    .slice(0, 3);
  const attention = rows
    .filter((row) => (row.__alerts || []).length > 0)
    .sort(
      (a, b) =>
        compareNumbers(a.__alerts?.length, b.__alerts?.length, "desc") ||
        compareNumbers(a.__roas, b.__roas, "asc"),
    )
    .slice(0, 3);

  const blocks = [];
  topRoas.forEach((row, idx) => {
    blocks.push(`
      <article class="ads-ranking-movement__row">
        <div class="ads-ranking-movement__title">Top ROAS #${idx + 1}: ${escHtml(row.ad_name || `#${row.campaign_id}`)}</div>
        <div class="ads-ranking-movement__meta">ROAS ${row.__roas != null ? row.__roas.toFixed(2) : "—"} • GMV ${fmtMoney(row.direct_gmv)} • Gasto ${fmtMoney(row.expense)}</div>
      </article>
    `);
  });

  attention.forEach((row) => {
    blocks.push(`
      <article class="ads-ranking-movement__row">
        <div class="ads-ranking-movement__title">Atenção: ${escHtml(row.ad_name || `#${row.campaign_id}`)}</div>
        <div class="ads-ranking-movement__meta">${fmtInt((row.__alerts || []).length)} alerta(s) • CTR ${row.__ctr != null ? row.__ctr.toFixed(2) : "—"}% • Cliques ${fmtInt(row.clicks)}</div>
      </article>
    `);
  });

  el.innerHTML = blocks.join("");
}

function getAdsRankingView(rowsFallback = []) {
  const sourceRows = getAdsRankingSourceRows(rowsFallback);
  const options = {
    search: getAdsRankingSearch(),
    status: getAdsRankingStatus(),
    sortBy: getAdsRankingSortBy(),
    limit: getAdsRankingLimit(),
  };
  return {
    sourceRows,
    options,
    ...buildAdsRankingRows(sourceRows, options),
  };
}

function renderAdsRanking(rows) {
  const kpisEl = document.getElementById("adsRankingKpis");
  const bodyEl = document.getElementById("adsRankingBody");
  const suggestionsEl = document.getElementById("adsSuggestionsList");
  const metaEl = document.getElementById("adsRankingMeta");
  if (!kpisEl || !bodyEl || !suggestionsEl) return;

  const { allRows, rows: pageRows, sourceRows, options } = getAdsRankingView(rows);
  lastAdsRankingView = { allRows, rows: pageRows };

  if (!allRows.length) {
    kpisEl.innerHTML = "";
    bodyEl.innerHTML =
      '<tr><td colspan="9" class="muted">Sem campanhas no filtro atual.</td></tr>';
    suggestionsEl.innerHTML =
      '<div class="ads-suggestion-card ads-suggestion-card--ok"><div class="ads-suggestion-card__type">Info</div><div class="ads-suggestion-card__title">Aguardando dados</div><div class="ads-suggestion-card__text">Carregue ou ajuste filtros para visualizar ranking e sugestoes.</div></div>';
    if (metaEl) {
      metaEl.textContent = `0 campanhas exibidas (base: ${fmtInt(sourceRows.length)}).`;
    }
    renderAdsRankingMovement([]);
    return;
  }

  const totals = allRows.reduce(
    (acc, row) => {
      acc.campaigns += 1;
      acc.expense += Number(row.expense || 0);
      acc.directGmv += Number(row.direct_gmv || 0);
      acc.impressions += Number(row.impression || 0);
      acc.clicks += Number(row.clicks || 0);
      if ((row.__alerts || []).length) acc.withAlerts += 1;
      return acc;
    },
    {
      campaigns: 0,
      withAlerts: 0,
      expense: 0,
      directGmv: 0,
      impressions: 0,
      clicks: 0,
    },
  );

  const roas = totals.expense > 0 ? totals.directGmv / totals.expense : null;
  const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : null;
  const topGmv = Number(allRows[0]?.direct_gmv || 0);
  const topGmvShare =
    totals.directGmv > 0 ? (topGmv / totals.directGmv) * 100 : 0;
  if (metaEl) {
    metaEl.textContent = `${fmtInt(pageRows.length)} campanhas exibidas de ${fmtInt(
      allRows.length,
    )} filtradas (base: ${fmtInt(sourceRows.length)}). Ordenação: ${getAdsRankingSortLabel(
      options.sortBy,
    )}.`;
  }

  kpisEl.innerHTML = `
    <div class="ads-ranking-kpi"><span>Campanhas no ranking</span><strong>${fmtInt(totals.campaigns)}</strong></div>
    <div class="ads-ranking-kpi"><span>Com alertas</span><strong>${fmtInt(totals.withAlerts)}</strong></div>
    <div class="ads-ranking-kpi"><span>Gasto total</span><strong>${fmtMoney(totals.expense)}</strong></div>
    <div class="ads-ranking-kpi"><span>GMV direto total</span><strong>${fmtMoney(totals.directGmv)}</strong></div>
    <div class="ads-ranking-kpi"><span>ROAS / CTR medio</span><strong>${roas != null ? roas.toFixed(2) : "—"} · ${ctr != null ? ctr.toFixed(2) : "—"}%</strong></div>
  `;

  bodyEl.innerHTML = pageRows
    .map((row) => {
      const alerts = Array.isArray(row.__alerts) ? row.__alerts : [];
      const signalsHtml = alerts.length
        ? alerts
            .map(
              (a) =>
                `<span class="ads-alert-pill ads-alert-pill--${a.tone}" title="${escAttr(a.detail)}">${escHtml(a.label)}</span>`,
            )
            .join("")
        : '<span class="ads-alert-pill ads-alert-pill--ok">Sem alertas</span>';

      return `
        <tr data-ads-ranking-campaign-row="${escAttr(String(row.campaign_id || ""))}">
          <td><span class="ads-ranking-pos">#${fmtInt(row.__pos)}</span></td>
          <td>
            <div class="ads-ranking-campaign">
              <strong>${escHtml(row.ad_name || `#${row.campaign_id}`)}</strong>
              <small>ID ${escHtml(String(row.campaign_id || "—"))}</small>
              <button type="button" class="ads-ranking-open" data-campaign-id="${escAttr(String(row.campaign_id || ""))}">Abrir campanha</button>
            </div>
          </td>
          <td>${fmtMoney(row.expense)}</td>
          <td>${fmtMoney(row.direct_gmv)}</td>
          <td>${row.__roas != null ? row.__roas.toFixed(2) : "—"}</td>
          <td>${row.__ctr != null ? row.__ctr.toFixed(2) : "—"}%</td>
          <td>${fmtInt(row.impression)}</td>
          <td>${fmtInt(row.clicks)}</td>
          <td><div class="ads-ranking-signals">${signalsHtml}</div></td>
        </tr>
      `;
    })
    .join("");

  const suggestions = buildAdsSuggestions(allRows, { topGmvShare });
  suggestionsEl.innerHTML = suggestions
    .map(
      (item) => `
      <article class="ads-suggestion-card ads-suggestion-card--${escAttr(item.tone || "ok")}">
        <div class="ads-suggestion-card__type">${escHtml(item.type || "Insight")}</div>
        <div class="ads-suggestion-card__title">${escHtml(item.title || "")}</div>
        <div class="ads-suggestion-card__text">${escHtml(item.text || "")}</div>
      </article>
    `,
    )
    .join("");

  bodyEl.querySelectorAll(".ads-ranking-open").forEach((button) => {
    button.addEventListener("click", () => {
      const id = String(button.getAttribute("data-campaign-id") || "");
      if (!id) return;
      selectCampaign(id);
    });
  });
  renderAdsRankingMovement(allRows);
}

async function apiGet(url) {
  const r = await fetch(url, { credentials: "include" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const error = new Error(
      j?.error?.message || j?.message || `HTTP ${r.status}`,
    );
    error.code = j?.error?.code || j?.code || null;
    error.status = r.status;
    error.payload = j;
    throw error;
  }
  return j;
}

async function apiPost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const error = new Error(
      j?.error?.message || j?.message || `HTTP ${r.status}`,
    );
    error.code = j?.error?.code || j?.code || null;
    error.status = r.status;
    error.payload = j;
    throw error;
  }
  return j;
}

async function apiPut(url, body) {
  const r = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const error = new Error(
      j?.error?.message || j?.message || `HTTP ${r.status}`,
    );
    error.code = j?.error?.code || j?.code || null;
    error.status = r.status;
    error.payload = j;
    throw error;
  }
  return j;
}

async function apiDelete(url) {
  const r = await fetch(url, {
    method: "DELETE",
    credentials: "include",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const error = new Error(
      j?.error?.message || j?.message || `HTTP ${r.status}`,
    );
    error.code = j?.error?.code || j?.code || null;
    error.status = r.status;
    error.payload = j;
    throw error;
  }
  return j;
}

function isAdsNotConnectedError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  return code === "ads_not_connected" || message.includes("ads nao conectado");
}

function resetAdsSummaryUi() {
  [
    "kpiAdsBalance",
    "kpiCpcExpense",
    "kpiCpcRoas",
    "kpiCpcRoasBroad",
    "kpiCpcCtr",
    "kpiCpcDirectGmv",
    "kpiCpcBroadGmv",
    "kpiCpcImpressions",
    "kpiCpcClicks",
    "kpiCpcRealGmv",
    "kpiCpcAdsOrders",
    "kpiCpcAdsItemsSold",
    "cpcCampaignCount",
  ].forEach((id) => setText(id, "—"));
}

function handleAdsNotConnected(error) {
  if (!isAdsNotConnectedError(error)) return false;

  resetAdsSummaryUi();
  cpcCampaignsMaster = [];
  cpcCampaignsView = [];
  resetCpcPager();
  updateCpcPager(0);
  setLoading("cpcLoading", "");
  setMsg(
    "cpcCampaignMsg",
    error?.message ||
      "Ads nao conectado para esta loja. Clique em Integrar Ads para autorizar o app de Ads.",
  );
  renderCpcTable([]);
  renderCpcPager();
  renderCpcProductPerformanceTable([]);
  renderAdsRanking([]);

  const btn = document.getElementById("btnAdsIntegrate");
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Integrar Ads";
  }

  return true;
}

function ensureDefaultDates() {
  const fromEl = document.getElementById("adsDateFrom");
  const toEl = document.getElementById("adsDateTo");
  if (!fromEl || !toEl) return;
  const todayIso = getAdsTodayIso();

  fromEl.max = todayIso;
  toEl.max = todayIso;

  if (!fromEl.value || !toEl.value) {
    const now = new Date();
    const to = new Date(now);
    const from = new Date(now.getFullYear(), now.getMonth(), 1); // Primeiro dia do mês
    toEl.value = isoLocalDate(to);
    fromEl.value = isoLocalDate(from);
  }
}

function syncAdsCopy() {
  const broadKpi = Array.from(document.querySelectorAll("#tab-ads .kpi")).find(
    (node) =>
      String(node.querySelector(".kpi-label")?.textContent || "").trim() ===
      "GMV Broad",
  );

  const helper = broadKpi?.querySelector(".muted");
  if (helper) {
    helper.textContent = "Vendas Totais Vindas por ADS";
  }
}

function getDates() {
  const fromEl = document.getElementById("adsDateFrom");
  const toEl = document.getElementById("adsDateTo");
  return {
    dateFrom: fromEl ? fromEl.value : "",
    dateTo: toEl ? toEl.value : "",
  };
}

function adsIntelSetMeta(text) {
  setText("adsIntelMeta", text || "");
}

function adsIntelSetMsg(text) {
  setText("adsIntelStrategyMsg", text || "");
}

function adsIntelSetAutomationUi(automation) {
  adsIntelState.automation = automation || null;
  const isEnabled = Boolean(automation?.isEnabled);
  const stateEl = document.getElementById("adsIntelAutomationState");
  const btn = document.getElementById("btnAdsIntelApply");

  if (stateEl) {
    stateEl.classList.toggle("is-active", isEnabled);
    stateEl.textContent = isEnabled ? "IA ativa" : "IA desativada";
  }

  if (btn) {
    btn.classList.toggle("is-active", isEnabled);
  }
}

function adsIntelFormatRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function adsIntelResolveCampaign(campaignId) {
  const list = Array.isArray(adsIntelState?.dataset?.campaigns)
    ? adsIntelState.dataset.campaigns
    : [];
  return list.find((item) => String(item?.campaign_id) === String(campaignId)) || null;
}

function adsIntelResolvePlan(campaignId) {
  const plans = Array.isArray(adsIntelState?.strategy?.campaign_plans)
    ? adsIntelState.strategy.campaign_plans
    : [];
  return plans.find((item) => String(item?.campaign_id) === String(campaignId)) || null;
}

function adsIntelGetVisibleCampaigns() {
  const campaigns = Array.isArray(adsIntelState?.dataset?.campaigns)
    ? adsIntelState.dataset.campaigns
    : [];
  const searchTerm = adsIntelGetCampaignSearchTerm();
  return campaigns.filter((campaign) => {
    const expense = Number(campaign?.metrics_30d?.expense || 0);
    if (expense < 10) return false;
    if (!searchTerm) return true;
    const name = String(campaign?.ad_name || "").toLowerCase();
    const id = String(campaign?.campaign_id || "").toLowerCase();
    return name.includes(searchTerm) || id.includes(searchTerm);
  });
}

function adsIntelCloneHourRuleMap(mapLike) {
  const source = mapLike && typeof mapLike === "object" ? mapLike : {};
  const clone = {};
  Object.keys(source).forEach((key) => {
    clone[String(key)] = { ...(source[key] || {}) };
  });
  return clone;
}

function adsIntelGetHourRulesForCampaign(campaignId) {
  const ruleMode = adsIntelGetRuleMode();
  if (ruleMode === "shared") {
    return adsIntelState?.hourRulesShared || {};
  }
  const key = String(campaignId || "");
  return adsIntelState?.hourRulesByCampaign?.[key] || {};
}

function adsIntelSetHourRuleForCampaign(campaignId, hour, ruleLike) {
  const safeHour = Number(hour);
  if (!Number.isInteger(safeHour) || safeHour < 0 || safeHour > 23) return;
  const nextRule = { ...(ruleLike || {}) };
  const ruleMode = adsIntelGetRuleMode();
  if (ruleMode === "shared") {
    const next = { ...(adsIntelState?.hourRulesShared || {}) };
    next[String(safeHour)] = nextRule;
    adsIntelState.hourRulesShared = next;
    return;
  }
  const key = String(campaignId || "");
  if (!key) return;
  const currentByCampaign = { ...(adsIntelState?.hourRulesByCampaign || {}) };
  const currentMap = { ...(currentByCampaign[key] || {}) };
  currentMap[String(safeHour)] = nextRule;
  currentByCampaign[key] = currentMap;
  adsIntelState.hourRulesByCampaign = currentByCampaign;
}

function adsIntelGetHourRuleForCampaign(campaignId, hour) {
  const safeHour = Number(hour);
  if (!Number.isInteger(safeHour) || safeHour < 0 || safeHour > 23) return null;
  const map = adsIntelGetHourRulesForCampaign(campaignId);
  return map?.[String(safeHour)] || null;
}

function adsIntelGetCurrentHourBr() {
  return new Date().getHours();
}

function adsIntelGetBaseRuleFromUi() {
  const { dateFrom, dateTo } = getDates();
  const mode = String(document.getElementById("adsIntelMode")?.value || "reduce_percent");
  return {
    dateFrom,
    dateTo,
    mode,
    reduce_percent: Number(document.getElementById("adsIntelReducePercent")?.value || 25),
    fixed_budget: Number(document.getElementById("adsIntelFixedBudget")?.value || 5),
    restore_mode: String(document.getElementById("adsIntelRestoreMode")?.value || "original"),
    restore_budget: Number(document.getElementById("adsIntelRestoreBudget")?.value || 10),
  };
}

function adsIntelGetScope() {
  return String(document.getElementById("adsIntelScope")?.value || "all");
}

function adsIntelGetRuleMode() {
  return String(document.getElementById("adsIntelRuleMode")?.value || "shared");
}

function adsIntelGetCampaignSearchTerm() {
  return String(document.getElementById("adsIntelCampaignSearch")?.value || "")
    .trim()
    .toLowerCase();
}

function adsIntelGetTargetCampaignIds() {
  const visibleCampaigns = adsIntelGetVisibleCampaigns();
  if (!visibleCampaigns.length) return [];
  const scope = adsIntelGetScope();
  if (scope === "selected") {
    const selectedSet = new Set(
      (Array.isArray(adsIntelState?.selectedCampaignIds) ? adsIntelState.selectedCampaignIds : [])
        .map((id) => String(id)),
    );
    return visibleCampaigns
      .map((item) => String(item?.campaign_id || ""))
      .filter((id) => id && selectedSet.has(id));
  }
  return visibleCampaigns
    .map((item) => String(item?.campaign_id || ""))
    .filter(Boolean);
}

function adsIntelNormalizeRule(ruleLike) {
  const mode = String(ruleLike?.mode || "reduce_percent");
  return {
    mode,
    reduce_percent: Number(ruleLike?.reduce_percent || 25),
    fixed_budget: Number(ruleLike?.fixed_budget || 5),
    restore_mode: String(ruleLike?.restore_mode || "original"),
    restore_budget: Number(ruleLike?.restore_budget || 10),
  };
}

function adsIntelGetRuleForCampaign(campaignId, fallbackRule) {
  const key = String(campaignId || "");
  const raw = adsIntelState?.campaignRules?.[key];
  if (!raw) return adsIntelNormalizeRule(fallbackRule);
  return adsIntelNormalizeRule(raw);
}

function adsIntelSetRuleForCampaign(campaignId, nextRule) {
  const key = String(campaignId || "");
  if (!key) return;
  adsIntelState.campaignRules = {
    ...(adsIntelState.campaignRules || {}),
    [key]: adsIntelNormalizeRule(nextRule),
  };
}

function adsIntelCopyRuleToSelected() {
  const selectedId = String(adsIntelState?.selectedCampaignId || "");
  if (!selectedId) {
    adsIntelSetMsg("Selecione uma campanha de referência para copiar a regra.");
    return;
  }

  const selectedIds = (Array.isArray(adsIntelState?.selectedCampaignIds)
    ? adsIntelState.selectedCampaignIds
    : [])
    .map((id) => String(id))
    .filter(Boolean);

  if (!selectedIds.length) {
    adsIntelSetMsg("Selecione ao menos um anúncio para receber a regra.");
    return;
  }

  const sourceRule = adsIntelGetRuleForCampaign(selectedId, adsIntelGetBaseRuleFromUi());
  selectedIds.forEach((campaignId) => {
    adsIntelSetRuleForCampaign(campaignId, sourceRule);
  });

  renderAdsIntelPerCampaignRules();
  adsIntelSetMsg(
    `Regra da campanha ${selectedId} copiada para ${selectedIds.length} anúncio(s) selecionado(s).`,
  );
}

function adsIntelBuildPayload(baseRule, campaignIds) {
  const normalized = adsIntelNormalizeRule(baseRule);
  return {
    ...normalized,
    dateFrom: baseRule?.dateFrom,
    dateTo: baseRule?.dateTo,
    campaign_ids: (campaignIds || []).map((id) => String(id)).filter(Boolean),
  };
}

function syncAdsIntelModeUi() {
  const mode = String(document.getElementById("adsIntelMode")?.value || "reduce_percent");
  const restoreMode = String(document.getElementById("adsIntelRestoreMode")?.value || "original");
  const ruleMode = adsIntelGetRuleMode();
  const scope = adsIntelGetScope();

  const reduceField = document.getElementById("adsIntelFieldReduce");
  const fixedField = document.getElementById("adsIntelFieldFixed");
  const restoreBudgetField = document.getElementById("adsIntelFieldRestoreBudget");
  const perRulesPanel = document.getElementById("adsIntelPerCampaignRules");
  const scopeInfo = document.getElementById("adsIntelRuleScopeInfo");

  if (scopeInfo) {
    const count = adsIntelGetTargetCampaignIds().length;
    scopeInfo.textContent =
      scope === "selected"
        ? `Escopo atual: ${count} anuncio(s) selecionado(s).`
        : `Escopo atual: todos os anuncios (${count}).`;
  }

  if (reduceField) {
    reduceField.classList.toggle("is-hidden", mode !== "reduce_percent");
  }
  if (fixedField) {
    fixedField.classList.toggle("is-hidden", mode !== "fixed_budget");
  }
  if (restoreBudgetField) {
    restoreBudgetField.classList.toggle("is-hidden", restoreMode !== "fixed");
  }

  if (perRulesPanel) {
    perRulesPanel.classList.toggle("is-hidden", ruleMode !== "per_campaign");
  }

  if (ruleMode === "per_campaign") {
    renderAdsIntelPerCampaignRules();
  }
}

function adsIntelActionToLabel(action) {
  const type = String(action?.type || "");
  if (!type || type === "none") return "Sem ação";
  if (type === "pause") return "Pausar";
  if (type === "resume") return "Reativar";
  if (type === "change_budget") {
    const budget = Number(action?.budget);
    if (Number.isFinite(budget)) return `Orçamento ${fmtMoneyBR(budget)}`;
    return "Alterar orçamento";
  }
  return type;
}

function adsIntelHourActionToLabel(ruleLike, fallbackAction) {
  const action = String(ruleLike?.action || "auto");
  if (action === "auto") return adsIntelActionToLabel(fallbackAction);
  if (action === "none") return "Nao agir";
  if (action === "pause") return "Pausar";
  if (action === "reduce_percent") {
    const pct = Number(ruleLike?.reduce_percent || 0);
    return `Reduzir ${Number.isFinite(pct) ? pct : 0}%`;
  }
  if (action === "fixed_budget") {
    return `Orcamento ${fmtMoney(Number(ruleLike?.fixed_budget || 0))}`;
  }
  return action;
}

function adsIntelCopyHourRulesToTargets() {
  const selectedId = String(adsIntelState?.selectedCampaignId || "");
  if (!selectedId) {
    adsIntelSetMsg("Selecione uma campanha de referÃªncia para copiar as regras por hora.");
    return;
  }

  const targetIds = adsIntelGetTargetCampaignIds();
  if (!targetIds.length) {
    adsIntelSetMsg("Nenhum anÃºncio alvo disponÃ­vel para copiar regras por hora.");
    return;
  }

  const sourceMap = adsIntelCloneHourRuleMap(adsIntelGetHourRulesForCampaign(selectedId));
  if (!Object.keys(sourceMap).length) {
    adsIntelSetMsg("A campanha selecionada ainda nÃ£o possui regras manuais por hora.");
    return;
  }

  if (adsIntelGetRuleMode() === "shared") {
    adsIntelState.hourRulesShared = sourceMap;
    adsIntelSetMsg("Regras por hora aplicadas ao modo compartilhado.");
    renderAdsIntelHourly();
    return;
  }

  const nextByCampaign = { ...(adsIntelState?.hourRulesByCampaign || {}) };
  targetIds.forEach((campaignId) => {
    nextByCampaign[String(campaignId)] = adsIntelCloneHourRuleMap(sourceMap);
  });
  adsIntelState.hourRulesByCampaign = nextByCampaign;
  adsIntelSetMsg(`Regras por hora copiadas para ${targetIds.length} anÃºncio(s) alvo.`);
  renderAdsIntelHourly();
}

function adsIntelMergeRuleWithHourOverride(baseRule, hourOverride) {
  const normalized = adsIntelNormalizeRule(baseRule);
  const action = String(hourOverride?.action || "auto");
  if (!action || action === "auto") return normalized;
  if (action === "none") return null;
  if (action === "pause") return { ...normalized, mode: "pause" };
  if (action === "reduce_percent") {
    return {
      ...normalized,
      mode: "reduce_percent",
      reduce_percent: Number(hourOverride?.reduce_percent || normalized.reduce_percent || 25),
    };
  }
  if (action === "fixed_budget") {
    return {
      ...normalized,
      mode: "fixed_budget",
      fixed_budget: Number(hourOverride?.fixed_budget || normalized.fixed_budget || 5),
    };
  }
  return normalized;
}

function adsIntelProcessSetBadge(mode, text) {
  const badge = document.getElementById("adsIntelProcessBadge");
  if (!badge) return;
  badge.classList.remove("is-running", "is-success", "is-warning");
  if (mode === "running") badge.classList.add("is-running");
  if (mode === "success") badge.classList.add("is-success");
  if (mode === "warning") badge.classList.add("is-warning");
  badge.textContent = text || "Parado";
}

function adsIntelProcessSetProgress(done, total) {
  const safeTotal = Math.max(0, Number(total || 0));
  const safeDone = Math.max(0, Math.min(safeTotal || 0, Number(done || 0)));
  const percent = safeTotal > 0 ? Math.round((safeDone / safeTotal) * 100) : 0;
  const bar = document.getElementById("adsIntelProcessBar");
  const counter = document.getElementById("adsIntelProcessCounter");
  const pct = document.getElementById("adsIntelProcessPercent");
  if (bar) bar.style.width = `${percent}%`;
  if (counter) counter.textContent = `${safeDone}/${safeTotal}`;
  if (pct) pct.textContent = `${percent}%`;
}

function adsIntelProcessOpen(title, meta) {
  const panel = document.getElementById("adsIntelProcessPanel");
  if (panel) panel.classList.remove("is-hidden");
  setText("adsIntelProcessTitle", title || "Andamento da IA Ads");
  setText("adsIntelProcessMeta", meta || "Executando...");
  const logs = document.getElementById("adsIntelProcessLogs");
  if (logs) logs.innerHTML = "";
  adsIntelProcessSetBadge("running", "Processando");
  adsIntelProcessSetProgress(0, 0);
}

function adsIntelProcessAddLog(message, level = "info") {
  const logs = document.getElementById("adsIntelProcessLogs");
  if (!logs) return;
  const row = document.createElement("div");
  row.className = "logistics-process-log";
  if (level === "success") row.classList.add("logistics-process-log--success");
  if (level === "error") row.classList.add("logistics-process-log--error");
  row.textContent = message || "—";
  logs.appendChild(row);
  logs.scrollTop = logs.scrollHeight;
}

function adsIntelProcessClose() {
  const panel = document.getElementById("adsIntelProcessPanel");
  if (panel) panel.classList.add("is-hidden");
}

function renderAdsIntelPerCampaignRules() {
  const wrap = document.getElementById("adsIntelPerCampaignRulesBody");
  if (!wrap) return;

  const campaigns = Array.isArray(adsIntelState?.dataset?.campaigns)
    ? adsIntelState.dataset.campaigns
    : [];
  const ids = adsIntelGetTargetCampaignIds();
  const byId = new Map(campaigns.map((item) => [String(item?.campaign_id || ""), item]));
  const baseRule = adsIntelGetBaseRuleFromUi();

  if (!ids.length) {
    wrap.innerHTML = '<div class="muted">Selecione ao menos um anuncio para configurar regra individual.</div>';
    return;
  }

  wrap.innerHTML = ids
    .map((id) => {
      const campaign = byId.get(String(id)) || {};
      const rule = adsIntelGetRuleForCampaign(id, baseRule);
      return `
        <div class="ads-intel-rule-card" data-ads-intel-rule-card="${escAttr(id)}">
          <div class="ads-intel-rule-card__title">
            <strong>${escHtml(campaign?.ad_name || `#${id}`)}</strong>
            <span class="muted">ID ${escHtml(String(id))}</span>
          </div>
          <div class="ads-intel-rule-grid">
            <div class="field">
              <label class="muted">Acao sem retorno</label>
              <select class="select" data-rule-field="mode">
                <option value="reduce_percent" ${rule.mode === "reduce_percent" ? "selected" : ""}>Reduzir em %</option>
                <option value="fixed_budget" ${rule.mode === "fixed_budget" ? "selected" : ""}>Orcamento fixo</option>
                <option value="pause" ${rule.mode === "pause" ? "selected" : ""}>Pausar</option>
              </select>
            </div>
            <div class="field" data-rule-wrap="reduce_percent" ${rule.mode === "reduce_percent" ? "" : 'style="display:none"'}>
              <label class="muted">% reducao</label>
              <input class="input" data-rule-field="reduce_percent" type="number" min="1" max="95" value="${escAttr(String(rule.reduce_percent))}" />
            </div>
            <div class="field" data-rule-wrap="fixed_budget" ${rule.mode === "fixed_budget" ? "" : 'style="display:none"'}>
              <label class="muted">Orcamento fixo (R$)</label>
              <input class="input" data-rule-field="fixed_budget" type="number" min="0" step="0.01" value="${escAttr(String(rule.fixed_budget))}" />
            </div>
            <div class="field">
              <label class="muted">Restaurar em retorno</label>
              <select class="select" data-rule-field="restore_mode">
                <option value="original" ${rule.restore_mode === "original" ? "selected" : ""}>Original</option>
                <option value="fixed" ${rule.restore_mode === "fixed" ? "selected" : ""}>Valor fixo</option>
              </select>
            </div>
            <div class="field" data-rule-wrap="restore_budget" ${rule.restore_mode === "fixed" ? "" : 'style="display:none"'}>
              <label class="muted">Restauracao (R$)</label>
              <input class="input" data-rule-field="restore_budget" type="number" min="0" step="0.01" value="${escAttr(String(rule.restore_budget))}" />
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  wrap.querySelectorAll("[data-ads-intel-rule-card]").forEach((cardEl) => {
    const campaignId = String(cardEl.getAttribute("data-ads-intel-rule-card") || "");
    if (!campaignId) return;

    const collectRule = () => ({
      mode: String(cardEl.querySelector('[data-rule-field="mode"]')?.value || "reduce_percent"),
      reduce_percent: Number(cardEl.querySelector('[data-rule-field="reduce_percent"]')?.value || 25),
      fixed_budget: Number(cardEl.querySelector('[data-rule-field="fixed_budget"]')?.value || 5),
      restore_mode: String(cardEl.querySelector('[data-rule-field="restore_mode"]')?.value || "original"),
      restore_budget: Number(cardEl.querySelector('[data-rule-field="restore_budget"]')?.value || 10),
    });

    const syncCardUi = () => {
      const mode = String(cardEl.querySelector('[data-rule-field="mode"]')?.value || "reduce_percent");
      const restoreMode = String(
        cardEl.querySelector('[data-rule-field="restore_mode"]')?.value || "original",
      );
      const reduceWrap = cardEl.querySelector('[data-rule-wrap="reduce_percent"]');
      const fixedWrap = cardEl.querySelector('[data-rule-wrap="fixed_budget"]');
      const restoreWrap = cardEl.querySelector('[data-rule-wrap="restore_budget"]');
      if (reduceWrap) reduceWrap.style.display = mode === "reduce_percent" ? "" : "none";
      if (fixedWrap) fixedWrap.style.display = mode === "fixed_budget" ? "" : "none";
      if (restoreWrap) restoreWrap.style.display = restoreMode === "fixed" ? "" : "none";
    };

    cardEl.querySelectorAll("select,input").forEach((inputEl) => {
      inputEl.addEventListener("change", () => {
        syncCardUi();
        adsIntelSetRuleForCampaign(campaignId, collectRule());
      });
    });
    syncCardUi();
  });
}

function renderAdsIntelCampaigns() {
  const tbody = document.getElementById("adsIntelCampaignBody");
  const selectAllEl = document.getElementById("adsIntelSelectAllCampaigns");
  if (!tbody) return;
  const visibleCampaigns = adsIntelGetVisibleCampaigns();
  const selectedSet = new Set(
    (Array.isArray(adsIntelState?.selectedCampaignIds) ? adsIntelState.selectedCampaignIds : []).map((id) =>
      String(id),
    ),
  );

  if (!visibleCampaigns.length) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="muted">Nenhuma campanha disponível para o período.</td></tr>';
    if (selectAllEl) {
      selectAllEl.checked = false;
      selectAllEl.indeterminate = false;
    }
    return;
  }

  const visibleIdsSet = new Set(visibleCampaigns.map((item) => String(item?.campaign_id || "")));
  if (!visibleIdsSet.has(String(adsIntelState?.selectedCampaignId || ""))) {
    adsIntelState.selectedCampaignId =
      visibleCampaigns[0]?.campaign_id != null ? String(visibleCampaigns[0].campaign_id) : null;
  }

  tbody.innerHTML = visibleCampaigns
    .map((campaign) => {
      const id = String(campaign?.campaign_id || "");
      const metrics = campaign?.metrics_30d || {};
      const roas = Number(metrics?.broad_roi || metrics?.direct_roi || 0);
      const status = String(campaign?.campaign_status || "—");
      const toneClass = statusBucketFromCampaignStatus(status) === "active"
        ? "ads-intel-tag ads-intel-tag--ok"
        : "ads-intel-tag";
      const selected = String(adsIntelState.selectedCampaignId || "") === id;
      const checked = selectedSet.has(id);
      return `
        <tr data-ads-intel-campaign="${escAttr(id)}" class="${selected ? "is-selected" : ""}">
          <td>
            <input type="checkbox" data-ads-intel-check="${escAttr(id)}" ${checked ? "checked" : ""} />
          </td>
          <td>
            <div class="ads-intel-campaign-cell">
              <strong>${escHtml(campaign?.ad_name || `#${id}`)}</strong>
              <small>ID ${escHtml(id)}</small>
            </div>
          </td>
          <td><span class="${toneClass}">${escHtml(status)}</span></td>
          <td>${escHtml(campaign?.ad_type || "—")}</td>
          <td>${Number.isFinite(roas) ? roas.toFixed(2) : "—"}</td>
          <td>${fmtMoney(metrics?.broad_gmv || metrics?.direct_gmv || 0)}</td>
          <td>${fmtMoney(metrics?.expense || 0)}</td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("tr[data-ads-intel-campaign]").forEach((row) => {
    row.addEventListener("click", () => {
      const id = String(row.getAttribute("data-ads-intel-campaign") || "");
      if (!id) return;
      adsIntelState.selectedCampaignId = id;
      renderAdsIntelCampaigns();
      renderAdsIntelHourly();
    });
  });

  tbody.querySelectorAll('input[data-ads-intel-check]').forEach((checkEl) => {
    checkEl.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    checkEl.addEventListener("change", () => {
      const id = String(checkEl.getAttribute("data-ads-intel-check") || "");
      const current = new Set(
        (Array.isArray(adsIntelState?.selectedCampaignIds) ? adsIntelState.selectedCampaignIds : []).map((x) =>
          String(x),
        ),
      );
      if (checkEl.checked) current.add(id);
      else current.delete(id);
      adsIntelState.selectedCampaignIds = Array.from(current);
      renderAdsIntelCampaigns();
      renderAdsIntelPerCampaignRules();
      syncAdsIntelModeUi();
    });
  });

  const total = visibleCampaigns.length;
  const selectedCount = visibleCampaigns.filter((c) =>
    selectedSet.has(String(c?.campaign_id || "")),
  ).length;

  if (selectAllEl) {
    selectAllEl.checked = selectedCount > 0 && selectedCount === total;
    selectAllEl.indeterminate = selectedCount > 0 && selectedCount < total;
  }
}

function renderAdsIntelHourly() {
  const tbody = document.getElementById("adsIntelHourlyBody");
  const title = document.getElementById("adsIntelHourlyTitle");
  const detectedHoursEl = document.getElementById("adsIntelDetectedHours");
  if (!tbody) return;

  const selectedId = String(adsIntelState?.selectedCampaignId || "");
  if (!selectedId) {
    if (title) title.textContent = "Selecione uma campanha.";
    if (detectedHoursEl) detectedHoursEl.textContent = "Horas com acao: -";
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Sem campanha selecionada.</td></tr>';
    return;
  }

  const campaign = adsIntelResolveCampaign(selectedId);
  const plan = adsIntelResolvePlan(selectedId);
  if (!campaign) {
    if (title) title.textContent = "Campanha não encontrada.";
    if (detectedHoursEl) detectedHoursEl.textContent = "Horas com acao: -";
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Campanha não encontrada.</td></tr>';
    return;
  }

  if (title) {
    title.textContent = `${campaign.ad_name || `#${campaign.campaign_id}`} • detalhe por hora`;
  }

  const profile = Array.isArray(campaign.hour_profile) ? campaign.hour_profile : [];
  if (!profile.length) {
    if (detectedHoursEl) detectedHoursEl.textContent = "Horas com acao: -";
    tbody.innerHTML =
      '<tr><td colspan="6" class="muted">Sem dados horários para esta campanha no período.</td></tr>';
    return;
  }

  const planByHour = new Map(
    (Array.isArray(plan?.hourly_plan) ? plan.hourly_plan : []).map((item) => [
      Number(item?.hour),
      item,
    ]),
  );
  const hourRules = adsIntelGetHourRulesForCampaign(selectedId);

  if (detectedHoursEl) {
    const detectedHours = (Array.isArray(plan?.hourly_plan) ? plan.hourly_plan : [])
      .filter((item) => Boolean(item?.no_return_hour))
      .map((item) => Number(item?.hour))
      .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)
      .sort((a, b) => a - b);
    const customHours = Object.keys(hourRules || {})
      .map((hour) => Number(hour))
      .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)
      .sort((a, b) => a - b);
    const autoText = detectedHours.length
      ? detectedHours.map((hour) => `${String(hour).padStart(2, "0")}h`).join(", ")
      : "nenhuma";
    const customText = customHours.length
      ? customHours.map((hour) => `${String(hour).padStart(2, "0")}h`).join(", ")
      : "nenhuma";
    detectedHoursEl.textContent = `Horas sem retorno detectadas: ${autoText} | Horas com regra manual: ${customText}`;
  }

  tbody.innerHTML = profile
    .map((row) => {
      const hour = Number(row?.hour || 0);
      const planRow = planByHour.get(hour);
      const action = planRow?.suggested_action || null;
      const noReturn = Boolean(planRow?.no_return_hour);
      const statusClass = noReturn ? "ads-intel-tag ads-intel-tag--danger" : "ads-intel-tag ads-intel-tag--ok";
      const roas = Number(row?.broad_roi || row?.direct_roi || 0);
      const gmv = Number(row?.broad_gmv || row?.direct_gmv || 0);
      const hourRule = adsIntelGetHourRuleForCampaign(selectedId, hour) || {};
      const hourAction = String(hourRule?.action || "auto");
      return `
        <tr data-ads-intel-hour-row="${hour}">
          <td>${String(hour).padStart(2, "0")}:00</td>
          <td><span class="${statusClass}">${adsIntelFormatRatio(row?.no_return_ratio || 0)}</span></td>
          <td>${fmtInt(row?.clicks || 0)}</td>
          <td>${Number.isFinite(roas) ? roas.toFixed(2) : "—"}</td>
          <td>${fmtMoney(gmv)}</td>
          <td>
            <div class="ads-intel-hour-action">
              <select class="select" data-hour-action="${hour}">
                <option value="auto" ${hourAction === "auto" ? "selected" : ""}>Automatico</option>
                <option value="reduce_percent" ${hourAction === "reduce_percent" ? "selected" : ""}>Reduzir %</option>
                <option value="fixed_budget" ${hourAction === "fixed_budget" ? "selected" : ""}>Orcamento fixo</option>
                <option value="pause" ${hourAction === "pause" ? "selected" : ""}>Pausar</option>
                <option value="none" ${hourAction === "none" ? "selected" : ""}>Nao agir</option>
              </select>
              <input
                class="input ${hourAction === "reduce_percent" ? "" : "is-hidden"}"
                data-hour-reduce="${hour}"
                type="number"
                min="1"
                max="95"
                step="1"
                value="${escAttr(String(Number(hourRule?.reduce_percent || 25)))}"
              />
              <input
                class="input ${hourAction === "fixed_budget" ? "" : "is-hidden"}"
                data-hour-fixed="${hour}"
                type="number"
                min="0"
                step="0.01"
                value="${escAttr(String(Number(hourRule?.fixed_budget || 5)))}"
              />
              <span class="ads-intel-action-pill">${escHtml(
                adsIntelHourActionToLabel(hourRule, action),
              )}</span>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("tr[data-ads-intel-hour-row]").forEach((rowEl) => {
    const hour = Number(rowEl.getAttribute("data-ads-intel-hour-row") || 0);
    const actionEl = rowEl.querySelector(`[data-hour-action="${hour}"]`);
    const reduceEl = rowEl.querySelector(`[data-hour-reduce="${hour}"]`);
    const fixedEl = rowEl.querySelector(`[data-hour-fixed="${hour}"]`);
    if (!actionEl) return;
    const syncHourUi = () => {
      const action = String(actionEl.value || "auto");
      if (reduceEl) reduceEl.classList.toggle("is-hidden", action !== "reduce_percent");
      if (fixedEl) fixedEl.classList.toggle("is-hidden", action !== "fixed_budget");
    };
    const persistRule = () => {
      adsIntelSetHourRuleForCampaign(selectedId, hour, {
        action: String(actionEl.value || "auto"),
        reduce_percent: Number(reduceEl?.value || 25),
        fixed_budget: Number(fixedEl?.value || 5),
      });
      renderAdsIntelHourly();
    };
    actionEl.addEventListener("change", persistRule);
    reduceEl?.addEventListener("change", persistRule);
    fixedEl?.addEventListener("change", persistRule);
    syncHourUi();
  });
}

async function loadAdsIntelligenceOverview() {
  const { dateFrom, dateTo } = getDates();
  if (!dateFrom || !dateTo) {
    adsIntelSetMsg("Selecione um período válido antes de carregar a inteligência.");
    return;
  }

  adsIntelSetMsg("");
  adsIntelSetMeta("Carregando inteligência...");
  const qs = new URLSearchParams({ dateFrom, dateTo });
  const data = await apiGet(`/shops/active/ads/intelligence/overview?${qs.toString()}`);
  const response = data?.response || {};
  adsIntelState.dataset = response;
  adsIntelState.strategy = null;
  adsIntelSetAutomationUi(response?.automation || null);
  const visibleCampaigns = adsIntelGetVisibleCampaigns();

  const warnings = Array.isArray(response?.warnings) ? response.warnings : [];
  const campaignCount = visibleCampaigns.length;
  const periodLabel = `${response?.period?.date_from || dateFrom} até ${
    response?.period?.date_to || dateTo
  }`;
  adsIntelSetMeta(
    `${periodLabel} • ${campaignCount} campanha(s) analisada(s)${
      warnings.length ? ` • ${warnings[0]}` : ""
    }`,
  );

  const first = visibleCampaigns[0]?.campaign_id;
  adsIntelState.selectedCampaignId = first ? String(first) : null;
  adsIntelState.selectedCampaignIds = visibleCampaigns
    .map((item) => String(item?.campaign_id || ""))
    .filter(Boolean);
  adsIntelState.campaignRules = {};
  adsIntelState.hourRulesShared = {};
  adsIntelState.hourRulesByCampaign = {};
  const baseRule = adsIntelGetBaseRuleFromUi();
  adsIntelState.selectedCampaignIds.forEach((id) => {
    adsIntelSetRuleForCampaign(id, baseRule);
  });
  renderAdsIntelCampaigns();
  renderAdsIntelPerCampaignRules();
  syncAdsIntelModeUi();
  renderAdsIntelHourly();
}

async function simulateAdsIntelligence() {
  if (!adsIntelState?.dataset) {
    await loadAdsIntelligenceOverview();
  }

  const baseRule = adsIntelGetBaseRuleFromUi();
  const targetIds = adsIntelGetTargetCampaignIds();
  const ruleMode = adsIntelGetRuleMode();
  if (!targetIds.length) {
    adsIntelSetMsg("Selecione ao menos um anuncio para simular.");
    return;
  }

  adsIntelSetMsg("Gerando prévia da IA Ads...");
  if (ruleMode === "shared") {
    const payload = adsIntelBuildPayload(baseRule, targetIds);
    const data = await apiPost("/shops/active/ads/intelligence/simulate", payload);
    adsIntelState.dataset = data?.response || adsIntelState.dataset;
    adsIntelState.strategy = data?.response?.strategy || null;
    adsIntelSetAutomationUi(data?.response?.automation || adsIntelState.automation || null);
  } else {
    const mergedCampaigns = new Map();
    const mergedPlans = [];
    let firstResponse = null;
    let automation = adsIntelState.automation || null;

    for (const campaignId of targetIds) {
      const rule = adsIntelGetRuleForCampaign(campaignId, baseRule);
      const payload = adsIntelBuildPayload(rule, [campaignId]);
      const data = await apiPost("/shops/active/ads/intelligence/simulate", payload);
      const response = data?.response || {};
      if (!firstResponse) firstResponse = response;
      automation = response?.automation || automation;

      (Array.isArray(response?.campaigns) ? response.campaigns : []).forEach((campaign) => {
        const id = String(campaign?.campaign_id || "");
        if (!id) return;
        mergedCampaigns.set(id, campaign);
      });

      const plans = Array.isArray(response?.strategy?.campaign_plans)
        ? response.strategy.campaign_plans
        : [];
      plans.forEach((plan) => mergedPlans.push(plan));
    }

    const baseDataset = firstResponse || adsIntelState.dataset || {};
    adsIntelState.dataset = {
      ...baseDataset,
      campaigns: Array.from(mergedCampaigns.values()),
    };
    adsIntelState.strategy = {
      ...(firstResponse?.strategy || {}),
      campaign_plans: mergedPlans,
    };
    adsIntelSetAutomationUi(automation || null);
  }

  const plans = Array.isArray(adsIntelState?.strategy?.campaign_plans)
    ? adsIntelState.strategy.campaign_plans.length
    : 0;
  adsIntelSetMsg(`Prévia pronta: ${plans} campanha(s) com plano por hora.`);
  if (!adsIntelState.selectedCampaignId) {
    const visibleCampaigns = adsIntelGetVisibleCampaigns();
    adsIntelState.selectedCampaignId =
      visibleCampaigns?.[0]?.campaign_id != null
        ? String(visibleCampaigns[0].campaign_id)
        : null;
  }
  renderAdsIntelCampaigns();
  renderAdsIntelHourly();
}

async function applyAdsIntelligence() {
  const baseRule = adsIntelGetBaseRuleFromUi();
  const targetIds = adsIntelGetTargetCampaignIds();
  const ruleMode = adsIntelGetRuleMode();
  if (!targetIds.length) {
    adsIntelSetMsg("Selecione ao menos um anuncio para aplicar.");
    return;
  }

  adsIntelSetAutomationUi({ isEnabled: true });
  adsIntelProcessOpen(
    "Andamento da IA Ads",
    "Aplicando ação automática na hora atual para as campanhas avaliadas.",
  );
  adsIntelProcessAddLog("Iniciando execução da IA Ads...");

  const aggregate = {
    summary: { total_campaigns: 0, success: 0, errors: 0, skipped: 0 },
    logs: [],
    results: [],
    automation: null,
  };
  const currentHour = adsIntelGetCurrentHourBr();
  adsIntelProcessSetProgress(0, targetIds.length);
  for (let i = 0; i < targetIds.length; i += 1) {
    const campaignId = targetIds[i];
    const campaignRule =
      ruleMode === "shared"
        ? adsIntelNormalizeRule(baseRule)
        : adsIntelGetRuleForCampaign(campaignId, baseRule);
    const hourRuleMap = adsIntelGetHourRulesForCampaign(campaignId) || {};
    const hourOverride = hourRuleMap?.[String(currentHour)] || null;
    const effectiveRule = adsIntelMergeRuleWithHourOverride(campaignRule, hourOverride);

    if (!effectiveRule) {
      aggregate.summary.total_campaigns += 1;
      aggregate.summary.skipped += 1;
      aggregate.logs.push({
        level: "info",
        campaign_id: campaignId,
        message: `Regra horaria (${String(currentHour).padStart(2, "0")}:00) definida como nao agir.`,
      });
      adsIntelProcessSetProgress(i + 1, targetIds.length);
      continue;
    }

    const payload = adsIntelBuildPayload(effectiveRule, [campaignId]);
    const data = await apiPost("/shops/active/ads/intelligence/apply", payload);
    const part = data?.response || {};

    const partSummary = part?.summary || {};
    aggregate.summary.total_campaigns += Number(partSummary?.total_campaigns || 0);
    aggregate.summary.success += Number(partSummary?.success || 0);
    aggregate.summary.errors += Number(partSummary?.errors || 0);
    aggregate.summary.skipped += Number(partSummary?.skipped || 0);
    aggregate.logs.push(...(Array.isArray(part?.logs) ? part.logs : []));
    aggregate.results.push(...(Array.isArray(part?.results) ? part.results : []));
    aggregate.automation = part?.automation || aggregate.automation;
    adsIntelProcessSetProgress(i + 1, targetIds.length);
  }
  const response = aggregate;

  adsIntelSetAutomationUi(response?.automation || adsIntelState.automation || null);
  const logs = Array.isArray(response?.logs) ? response.logs : [];
  const summary = response?.summary || {};

  logs.forEach((log) => {
    const level = String(log?.level || "info").toLowerCase();
    const prefix = level === "success" ? "✅" : level === "error" ? "❌" : "⚠️";
    const message = `${prefix} [${log?.campaign_id || "campanha"}] ${log?.message || "—"}`;
    adsIntelProcessAddLog(message, level === "success" ? "success" : level === "error" ? "error" : "info");
  });

  setText(
    "adsIntelProcessMeta",
    `Sucesso: ${Number(summary?.success || 0)} • Erros: ${Number(
      summary?.errors || 0,
    )} • Ignoradas: ${Number(summary?.skipped || 0)}`,
  );
  adsIntelSetMsg(
    `Execução concluída. Sucesso: ${Number(summary?.success || 0)} | Erros: ${Number(
      summary?.errors || 0,
    )} | Ignoradas: ${Number(summary?.skipped || 0)}.`,
  );

  if (Number(summary?.errors || 0) > 0) {
    adsIntelProcessSetBadge("warning", "Concluído c/ alertas");
  } else {
    adsIntelProcessSetBadge("success", "Concluído");
  }
}

async function loadAdsRoasRealApproxForUi() {
  const dateFrom = String(document.getElementById("adsDateFrom")?.value || "");
  const dateTo = String(document.getElementById("adsDateTo")?.value || "");
  if (!dateFrom || !dateTo) return;

  const qs = new URLSearchParams({ dateFrom, dateTo });
  const data = await apiGet(`/shops/active/ads/roas-real-aproximado?${qs}`);

  const gmvCents = Number(data?.metrics?.attributedGmvCents || 0);

  setText("kpiCpcRealGmv", fmtMoneyFromCents(gmvCents));
}

function safeDestroyChart(ch) {
  if (ch && typeof ch.destroy === "function") ch.destroy();
  return null;
}

function makeNeoGradient(ctx, chartArea, stops) {
  const g = ctx.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
  for (const [p, c] of stops) g.addColorStop(p, c);
  return g;
}

function renderLineChart(canvasId, labels, datasets) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  const ctx = canvas.getContext("2d");
  const chartTheme = getAdsChartThemeColors();
  return new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },

      animation: { duration: 280 },

      plugins: {
        legend: {
          display: true,
          labels: {
            color: chartTheme.legend,
            boxWidth: 10,
            boxHeight: 10,
          },
        },
        tooltip: {
          backgroundColor: chartTheme.tooltipBg,
          borderColor: chartTheme.tooltipBorder,
          borderWidth: 1,
          titleColor: chartTheme.tooltipTitle,
          bodyColor: chartTheme.tooltipBody,
          displayColors: true,
          callbacks: {
            label(ctx) {
              const label = ctx.dataset?.label || "";
              const v = ctx.parsed?.y;

              const isMoney =
                label.toLowerCase().includes("gasto") ||
                label.toLowerCase().includes("gmv") ||
                label.toLowerCase().includes("saldo") ||
                label.toLowerCase().includes("budget") ||
                label.toLowerCase().includes("orçamento");

              const text = isMoney ? fmtMoneyBR(v) : fmtNumberBR(v);
              return `${label}: ${text}`;
            },
          },
        },
      },

      scales: {
        x: {
          ticks: { color: chartTheme.axis, maxRotation: 0, autoSkip: true },
          grid: { color: chartTheme.grid },
        },
        y: {
          beginAtZero: true,
          ticks: { color: chartTheme.axis },
          grid: { color: chartTheme.grid },
        },
      },
    },
  });
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setDisabled(id, disabled) {
  const el = document.getElementById(id);
  if (el) el.disabled = Boolean(disabled);
}

function setMsg(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || "";
}

function setLoading(id, text) {
  setMsg(id, text || "");
}

/* ===========================
   CSV
=========================== */

function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadCsv(filename, headers, rows) {
  const lines = [];
  lines.push(headers.map(csvEscape).join(","));
  for (const row of rows) lines.push(row.map(csvEscape).join(","));

  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

/* ===========================
   Export CSV Actions
=========================== */

function exportCpcCampaignsCsv() {
  if (!cpcCampaignsView.length) {
    return setMsg(
      "cpcCampaignMsg",
      "Nada para exportar. Ajuste o filtro/ordem ou clique em Atualizar.",
    );
  }

  const { dateFrom, dateTo } = getDates();
  const filename = `cpc-campaigns-view-${dateFrom}-to-${dateTo}.csv`;

  const headers = [
    "campaign_id",
    "ad_name",
    "ad_type",
    "campaign_status",
    "placement",
    "budget",
    "impression",
    "clicks",
    "expense",
    "direct_gmv",
    "direct_roas",
    "direct_acos_pct",
    "credit_estimated",
  ];

  const rows = cpcCampaignsView.map((x) => [
    x.campaign_id,
    x.ad_name,
    x.ad_type,
    x.campaign_status,
    x.placement,
    x.budget,
    x.impression,
    x.clicks,
    x.expense,
    x.direct_gmv,
    x.direct_roas != null ? Number(x.direct_roas).toFixed(4) : "",
    x.direct_acos_pct != null ? Number(x.direct_acos_pct).toFixed(4) : "",
    x.credit_estimated,
  ]);

  downloadCsv(filename, headers, rows);
}

function exportCpcLinkedItemsCsv() {
  if (!selectedCpcCampaignId)
    return setMsg("cpcCampaignMsg", "Selecione uma campanha primeiro.");

  const set = cachedCampaignSettings.get(String(selectedCpcCampaignId));
  if (!set)
    return setMsg(
      "cpcCampaignMsg",
      "Sem dados de settings para a campanha selecionada. Clique em Atualizar.",
    );

  const common = set.common_info || {};
  const itemIds = Array.isArray(common.item_id_list) ? common.item_id_list : [];

  const autoInfo = Array.isArray(set.auto_product_ads_info)
    ? set.auto_product_ads_info
    : [];
  const autoMap = new Map(
    autoInfo.filter((x) => x.item_id).map((x) => [String(x.item_id), x]),
  );

  const { dateFrom, dateTo } = getDates();
  const filename = `cpc-linked-items-campaign-${selectedCpcCampaignId}-${dateFrom}-to-${dateTo}.csv`;

  const headers = ["campaign_id", "item_id", "product_name", "status"];
  const rows = itemIds.map((itemId) => {
    const ai = autoMap.get(String(itemId));
    return [
      selectedCpcCampaignId,
      String(itemId),
      ai?.product_name || "",
      ai?.status || "",
    ];
  });

  downloadCsv(filename, headers, rows);
}

function exportCpcProductPerfCsv() {
  if (!selectedCpcCampaignId) {
    return setMsg("cpcItemsMsg", "Selecione uma campanha primeiro.");
  }

  if (!lastCpcProductPerfRows.length) {
    return setMsg(
      "cpcItemsMsg",
      "Nada para exportar. Selecione uma campanha e aguarde carregar o desempenho.",
    );
  }

  const { dateFrom, dateTo } = getDates();
  const filename = `cpc-product-performance-campaign-${selectedCpcCampaignId}-${dateFrom}-to-${dateTo}.csv`;

  const headers = [
    "campaign_id",
    "item_id",
    "title",
    "impression",
    "clicks",
    "expense",
    "gmv",
    "conversions",
    "items",
    "monthly_ad_spend",
    "monthly_sales_qty",
    "monthly_cost_per_sale",
    "product_name",
    "status",
  ];

  const rows = lastCpcProductPerfRows.map((x) => [
    selectedCpcCampaignId,
    x.item_id,
    x.title || "",
    x.impression ?? "",
    x.clicks ?? "",
    x.expense ?? "",
    x.gmv ?? "",
    x.conversions ?? "",
    x.items ?? "",
    x.monthly_ad_spend ?? "",
    x.monthly_sales_qty ?? "",
    x.monthly_cost_per_sale ?? "",
    x.product_name || "",
    x.status || "",
  ]);

  downloadCsv(filename, headers, rows);
}

function exportAdsRankingCsv() {
  const rows = Array.isArray(lastAdsRankingView.allRows)
    ? lastAdsRankingView.allRows
    : [];
  if (!rows.length) {
    return setMsg(
      "cpcCampaignMsg",
      "Sem dados no ranking para exportar. Atualize os dados e aplique filtros.",
    );
  }

  const { dateFrom, dateTo } = getDates();
  const filename = `ads-ranking-shopee-${dateFrom}-to-${dateTo}.csv`;
  const headers = [
    "posicao",
    "campaign_id",
    "ad_name",
    "campaign_status",
    "expense",
    "direct_gmv",
    "roas",
    "ctr_pct",
    "impression",
    "clicks",
    "alerts_count",
    "alerts",
  ];
  const csvRows = rows.map((row) => [
    row.__pos ?? "",
    row.campaign_id ?? "",
    row.ad_name ?? "",
    row.campaign_status ?? "",
    row.expense ?? "",
    row.direct_gmv ?? "",
    row.__roas != null ? Number(row.__roas).toFixed(4) : "",
    row.__ctr != null ? Number(row.__ctr).toFixed(4) : "",
    row.impression ?? "",
    row.clicks ?? "",
    Array.isArray(row.__alerts) ? row.__alerts.length : 0,
    Array.isArray(row.__alerts)
      ? row.__alerts.map((a) => a.label || "").join(" | ")
      : "",
  ]);
  downloadCsv(filename, headers, csvRows);
}

/* ===========================
   Modal
=========================== */

function openModal(title, html) {
  const overlay = document.getElementById("modal-overlay");
  const t = document.getElementById("modal-title");
  const b = document.getElementById("modal-body");
  const close = document.getElementById("modal-close");

  if (!overlay || !t || !b || !close) return;

  t.textContent = title;
  b.innerHTML = html;
  overlay.style.display = "flex";

  const onClose = () => {
    overlay.style.display = "none";
    close.removeEventListener("click", onClose);
    overlay.removeEventListener("click", onOverlay);
  };

  const onOverlay = (e) => {
    if (e.target === overlay) onClose();
  };

  close.addEventListener("click", onClose);
  overlay.addEventListener("click", onOverlay);
}

function val(id) {
  return document.getElementById(id)?.value;
}

/* ===========================
   CPC Campaign View (debounce + persist)
=========================== */

function debounceApplyCpcCampaignView() {
  // Se veio campanha do backend, mas o filtro salvou “escondeu tudo”, limpa automaticamente
  if (cpcFilterTimer) clearTimeout(cpcFilterTimer);
  cpcFilterTimer = setTimeout(() => applyCpcCampaignView(), 120);
}

function getCpcCampaignFilter() {
  const el = document.getElementById("cpcCampaignFilter");
  return String(el?.value || "")
    .trim()
    .toLowerCase();
}

function getCpcCampaignSort() {
  const el = document.getElementById("cpcCampaignSortBy");
  return String(el?.value || "expense_desc");
}

function applyCpcCampaignView() {
  const filter = getCpcCampaignFilter();
  const sort = getCpcCampaignSort();

  let rows = [...cpcCampaignsMaster];

  if (filter) {
    rows = rows.filter((x) => {
      const name = String(x.ad_name || "").toLowerCase();
      const id = String(x.campaign_id || "").toLowerCase();
      return name.includes(filter) || id.includes(filter);
    });
  }

  const bucket = getCpcStatusBucket();
  if (bucket !== "all") {
    const baseRows = [...rows];
    rows = rows.filter(
      (x) => statusBucketFromCampaignStatus(x.campaign_status) === bucket,
    );

    // Fallback resiliente: quando a Shopee retornar status inesperado/novo,
    // não zeramos a visão padrão "Em andamento".
    if (bucket === "active" && rows.length === 0 && baseRows.length > 0) {
      const unknownRows = baseRows.filter(
        (x) => statusBucketFromCampaignStatus(x.campaign_status) === "unknown",
      );
      if (unknownRows.length) {
        rows = unknownRows;
        setMsg(
          "cpcCampaignMsg",
          "Campanhas exibidas com status não mapeado pela API. Atualizaremos o mapeamento automaticamente.",
        );
      }
    }
  }

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : -Infinity);

  rows.sort((a, b) => {
    switch (sort) {
      case "expense_asc":
        return num(a.expense) - num(b.expense);
      case "expense_desc":
        return num(b.expense) - num(a.expense);

      case "direct_gmv_asc":
        return num(a.direct_gmv) - num(b.direct_gmv);
      case "direct_gmv_desc":
        return num(b.direct_gmv) - num(a.direct_gmv);

      case "direct_roas_asc":
        return num(a.direct_roas) - num(b.direct_roas);
      case "direct_roas_desc":
        return num(b.direct_roas) - num(a.direct_roas);

      case "clicks_asc":
        return num(a.clicks) - num(b.clicks);
      case "clicks_desc":
        return num(b.clicks) - num(a.clicks);

      case "impression_asc":
        return num(a.impression) - num(b.impression);
      case "impression_desc":
        return num(b.impression) - num(a.impression);

      default:
        return num(b.expense) - num(a.expense);
    }
  });

  cpcCampaignsView = rows;
  renderCpcAlerts(rows);
  renderAdsRanking(rows);
  const countEl = document.getElementById("cpcCampaignCount");
  if (countEl) countEl.textContent = `${rows.length} campanhas`;
  updateCpcPager(rows.length);
  const start = (cpcPager.page - 1) * cpcPager.pageSize;
  const pageRows = rows.slice(start, start + cpcPager.pageSize);
  renderCpcCampaignCards(pageRows);
  renderCpcPager();
}

// Compatibilidade: legado chamava renderCpcTable; a UI atual usa cards.
function renderCpcTable(rows) {
  renderCpcCampaignCards(Array.isArray(rows) ? rows : []);
}

function renderCpcCampaignCards(rows) {
  const wrap = document.getElementById("cpcCampaignCards");
  if (!wrap) return;
  wrap.innerHTML = "";

  for (const x of rows) {
    const id = String(x.campaign_id || "");
    const img = x.thumbnail_url
      ? `<img class="cpc-card__thumb" src="${escAttr(
          x.thumbnail_url,
        )}" onerror="this.style.display='none'">`
      : `<div class="cpc-card__thumb cpc-card__thumb--ph"></div>`;
    const status = badgeHtml(
      x.campaign_status || "—",
      statusTone(x.campaign_status),
    );
    const type = badgeHtml(x.ad_type || "—", "gray");
    const diag = diagnosisHtml(x);
    const placement = badgeHtml(x.placement || "—", "gray");
    const acosTxt = x.direct_acos_pct != null ? fmtPct(x.direct_acos_pct) : "—";
    const acosBadge =
      x.direct_acos_pct != null
        ? badgeHtml("ACOS " + acosTxt, acosTone(x.direct_acos_pct))
        : badgeHtml("ACOS —", "gray");
    const broadGmv = x.broad_gmv != null ? fmtMoney(x.broad_gmv) : "—";
    const broadRoas =
      x.broad_roas != null ? Number(x.broad_roas).toFixed(2) : "—";
    const alerts = getCampaignAlertEntries(x);
    const alertHtml = alerts.length
      ? `<div class="cpc-card__alerts">${alerts
          .map(
            (a) =>
              `<span class="ads-alert-pill ads-alert-pill--${a.tone}" title="${escAttr(
                a.detail,
              )}">${escHtml(a.label)}</span>`,
          )
          .join("")}</div>`
      : `<div class="cpc-card__alerts"><span class="ads-alert-pill ads-alert-pill--ok">Sem alertas críticos</span></div>`;
    const el = document.createElement("div");
    el.className = "cpc-card";
    el.dataset.campaignId = id;
    if (id === String(selectedCpcCampaignId || ""))
      el.classList.add("is-selected");

    el.innerHTML = `
      <div class="cpc-card__left">${img}</div>
      <div class="cpc-card__mid">
        <div class="cpc-card__title">${escHtml(x.ad_name || "#" + id)}</div>
        <div class="cpc-card__meta">
          <span class="muted">#${escHtml(id)}</span>
          ${type} ${status} ${placement} ${diag} ${acosBadge}
        </div>
        ${alertHtml}
        <div class="cpc-card__grid">
          <div><div class="muted">Orçamento</div><div class="v">${
            x.budget != null ? fmtMoney(x.budget) : "—"
          }</div></div>
          <div><div class="muted">Gasto</div><div class="v">${fmtMoney(
            x.expense,
          )}</div></div>
          <div><div class="muted">GMV Dir.</div><div class="v">${fmtMoney(
            x.direct_gmv,
          )}</div></div>
          <div><div class="muted">ROAS Dir.</div><div class="v">${
            x.direct_roas != null ? Number(x.direct_roas).toFixed(2) : "—"
          }</div></div>
          <div><div class="muted">GMV Broad</div><div class="v">${broadGmv}</div></div>
          <div><div class="muted">ROAS Broad</div><div class="v">${broadRoas}</div></div>
          <div><div class="muted">Imp.</div><div class="v">${fmtInt(
            x.impression,
          )}</div></div>
          <div><div class="muted">Cliques</div><div class="v">${fmtInt(
            x.clicks,
          )}</div></div>
          <div><div class="muted">ACOS Dir.</div><div class="v">${acosTxt}
          </div></div>
        </div>
      </div>
      <div class="cpc-card__right">
        <div class="muted">ROAS alvo</div>
        <div class="v">${
          x.roas_target != null ? Number(x.roas_target).toFixed(2) : "—"
        }</div>
      </div>
    `;

    el.addEventListener("click", () => selectCampaign(x.campaign_id));
    wrap.appendChild(el);
  }

  if (!rows.length) {
    wrap.innerHTML = `<div class="muted" style="padding:10px">Nenhuma campanha encontrada para o filtro/ordem atual.</div>`;
  }
}

/* ===========================
   DOM Events
=========================== */

document.addEventListener("DOMContentLoaded", () => {
  ensureDefaultDates();
  syncAdsCopy();
  syncAdsIntelModeUi();
  adsIntelSetAutomationUi(null);
  // ✅ padrão fixo: Em andamento
  setCpcStatusBucket("active");

  const tabsWrap = document.getElementById("cpcStatusTabs");
  if (tabsWrap) {
    tabsWrap.addEventListener("click", (e) => {
      const btn = e.target.closest?.(".status-tab");
      if (!btn) return;
      setCpcStatusBucket(btn.dataset.status || "active");
      resetCpcPager();
      applyCpcCampaignView();
    });
  }
  // restore filter/sort
  const filterEl = document.getElementById("cpcCampaignFilter");
  const sortEl = document.getElementById("cpcCampaignSortBy");
  const statusEl = document.getElementById("cpcCampaignStatusFilter");
  const btnExportCpcPerf = document.getElementById(
    "btnExportCpcProductPerfCsv",
  );
  if (btnExportCpcPerf) {
    btnExportCpcPerf.addEventListener("click", () => exportCpcProductPerfCsv());
  }

  if (filterEl) filterEl.value = localStorage.getItem("ads_cpc_filter") || "";
  if (sortEl)
    sortEl.value = localStorage.getItem("ads_cpc_sort") || "expense_desc";

  const rankingFilterEl = document.getElementById("rankingCampaignFilter");
  const rankingSortEl = document.getElementById("rankingCampaignSortBy");
  const rankingStatusEl = document.getElementById("rankingCampaignStatus");
  const rankingLimitEl = document.getElementById("rankingCampaignLimit");
  const btnRankingApply = document.getElementById("btnRankingApply");
  const btnRankingExport = document.getElementById("btnRankingExport");

  if (rankingFilterEl) {
    rankingFilterEl.value = localStorage.getItem("ads_ranking_filter") || "";
  }
  if (rankingSortEl) {
    rankingSortEl.value =
      localStorage.getItem("ads_ranking_sort") || "direct_gmv_desc";
  }
  if (rankingStatusEl) {
    rankingStatusEl.value = localStorage.getItem("ads_ranking_status") || "all";
  }
  if (rankingLimitEl) {
    rankingLimitEl.value = localStorage.getItem("ads_ranking_limit") || "20";
  }

  // CPC filter/sort listeners (persist + debounce)
  if (filterEl) {
    filterEl.addEventListener("input", () => {
      localStorage.setItem("ads_cpc_filter", filterEl.value || "");
      resetCpcPager();
      debounceApplyCpcCampaignView();
    });
  }

  if (sortEl) {
    sortEl.addEventListener("change", () => {
      localStorage.setItem("ads_cpc_sort", sortEl.value || "expense_desc");
      resetCpcPager();
      applyCpcCampaignView();
    });
  }

  if (rankingFilterEl) {
    rankingFilterEl.addEventListener("input", () => {
      localStorage.setItem("ads_ranking_filter", rankingFilterEl.value || "");
      renderAdsRanking();
    });
  }
  if (rankingSortEl) {
    rankingSortEl.addEventListener("change", () => {
      localStorage.setItem(
        "ads_ranking_sort",
        rankingSortEl.value || "direct_gmv_desc",
      );
      renderAdsRanking();
    });
  }
  if (rankingStatusEl) {
    rankingStatusEl.addEventListener("change", () => {
      localStorage.setItem("ads_ranking_status", rankingStatusEl.value || "all");
      renderAdsRanking();
    });
  }
  if (rankingLimitEl) {
    rankingLimitEl.addEventListener("change", () => {
      localStorage.setItem("ads_ranking_limit", rankingLimitEl.value || "20");
      renderAdsRanking();
    });
  }
  if (btnRankingApply) {
    btnRankingApply.addEventListener("click", () => renderAdsRanking());
  }
  if (btnRankingExport) {
    btnRankingExport.addEventListener("click", () => exportAdsRankingCsv());
  }

  const clearBtn = document.getElementById("btnCpcCampaignClearFilter");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (filterEl) {
        filterEl.value = "";
        localStorage.setItem("ads_cpc_filter", "");
      }
      if (sortEl) {
        sortEl.value = "expense_desc";
        localStorage.setItem("ads_cpc_sort", "expense_desc");
      }
      setCpcStatusBucket("active");
      resetCpcPager();
      applyCpcCampaignView();
    });
  }
  const ps = document.getElementById("cpcCampaignPageSize");
  if (ps) {
    ps.value = String(cpcPager.pageSize);
    ps.addEventListener("change", () => {
      cpcPager.pageSize = Number(ps.value) || 20;
      resetCpcPager();
      applyCpcCampaignView();
    });
  }
  document.getElementById("cpcCampaignFirst")?.addEventListener("click", () => {
    cpcPager.page = 1;
    applyCpcCampaignView();
  });
  document.getElementById("cpcCampaignPrev")?.addEventListener("click", () => {
    cpcPager.page = Math.max(1, cpcPager.page - 1);
    applyCpcCampaignView();
  });
  document.getElementById("cpcCampaignNext")?.addEventListener("click", () => {
    cpcPager.page = Math.min(cpcPager.totalPages, cpcPager.page + 1);
    applyCpcCampaignView();
  });
  document.getElementById("cpcCampaignLast")?.addEventListener("click", () => {
    cpcPager.page = cpcPager.totalPages;
    applyCpcCampaignView();
  });
  // Exports
  const btnExportCpc = document.getElementById("btnExportCpcCampaignsCsv");
  if (btnExportCpc)
    btnExportCpc.addEventListener("click", () => exportCpcCampaignsCsv());

  const btnExportCpcLinked = document.getElementById(
    "btnExportCpcLinkedItemsCsv",
  );
  if (btnExportCpcLinked)
    btnExportCpcLinked.addEventListener("click", () =>
      exportCpcLinkedItemsCsv(),
    );

  // Reload + pager
  const btnReload = document.getElementById("btnAdsReload");
  if (btnReload) btnReload.addEventListener("click", () => loadAdsAll());

  const btnIntegrate = document.getElementById("btnAdsIntegrate");
  if (btnIntegrate) {
    btnIntegrate.addEventListener("click", async () => {
      if (typeof window.startAdsOauthFlow === "function") {
        await window.startAdsOauthFlow();
      } else {
        setMsg(
          "cpcCampaignMsg",
          "Fluxo de integracao de Ads indisponivel no momento. Recarregue a pagina.",
        );
      }
    });
  }

  const selGroup = document.getElementById("adsGroupSelect");
  if (selGroup) {
    selGroup.addEventListener("change", () => {
      selectedCampaignGroupId = selGroup.value || null;
      const g = getGroupById(selectedCampaignGroupId);
      renderGroupSummary(g);
      renderGroupItemsInline(g);
    });
  }

  const btnGR = document.getElementById("btnAdsGroupReload");
  if (btnGR) btnGR.addEventListener("click", () => loadCampaignGroups());

  const btnGC = document.getElementById("btnAdsGroupCreate");
  if (btnGC) btnGC.addEventListener("click", () => openAdsGroupCreateModal());

  const btnGE = document.getElementById("btnAdsGroupEdit");
  if (btnGE) btnGE.addEventListener("click", () => openAdsGroupEditModal());

  const btnGD = document.getElementById("btnAdsGroupDelete");
  if (btnGD) btnGD.addEventListener("click", () => deleteAdsGroupSelected());

  const btnGV = document.getElementById("btnAdsGroupViewItems");
  if (btnGV)
    btnGV.addEventListener("click", () => {
      const g = getGroupById(selectedCampaignGroupId);
      if (!g) return setMsg("adsGroupMsg", "Selecione um grupo primeiro.");
      openGroupItemsModal(g);
    });

  const btnAdsIntelLoad = document.getElementById("btnAdsIntelLoad");
  if (btnAdsIntelLoad) {
    btnAdsIntelLoad.addEventListener("click", () => {
      loadAdsIntelligenceOverview().catch((error) => {
        adsIntelSetMsg(error?.message || "Falha ao carregar Intelligence Ads.");
      });
    });
  }

  const btnAdsIntelSimulate = document.getElementById("btnAdsIntelSimulate");
  if (btnAdsIntelSimulate) {
    btnAdsIntelSimulate.addEventListener("click", () => {
      simulateAdsIntelligence().catch((error) => {
        adsIntelSetMsg(error?.message || "Falha ao simular Intelligence Ads.");
      });
    });
  }

  const btnAdsIntelApply = document.getElementById("btnAdsIntelApply");
  if (btnAdsIntelApply) {
    btnAdsIntelApply.addEventListener("click", () => {
      applyAdsIntelligence().catch((error) => {
        adsIntelProcessSetBadge("warning", "Falha");
        adsIntelProcessAddLog(
          `❌ Falha ao aplicar IA Ads: ${error?.message || "erro desconhecido"}`,
          "error",
        );
        adsIntelSetMsg(error?.message || "Falha ao aplicar IA Ads.");
      });
    });
  }

  document.getElementById("btnAdsIntelProcessClose")?.addEventListener("click", () => {
    adsIntelProcessClose();
  });

  document.getElementById("adsIntelMode")?.addEventListener("change", () => {
    syncAdsIntelModeUi();
  });

  document.getElementById("adsIntelRestoreMode")?.addEventListener("change", () => {
    syncAdsIntelModeUi();
  });

  document.getElementById("adsIntelScope")?.addEventListener("change", () => {
    syncAdsIntelModeUi();
    renderAdsIntelPerCampaignRules();
    renderAdsIntelHourly();
  });

  document.getElementById("adsIntelRuleMode")?.addEventListener("change", () => {
    syncAdsIntelModeUi();
    renderAdsIntelPerCampaignRules();
    renderAdsIntelHourly();
  });

  document.getElementById("adsIntelSelectAllCampaigns")?.addEventListener("change", (event) => {
    const checked = Boolean(event?.target?.checked);
    const campaigns = adsIntelGetVisibleCampaigns();
    adsIntelState.selectedCampaignIds = checked
      ? campaigns.map((item) => String(item?.campaign_id || "")).filter(Boolean)
      : [];
    renderAdsIntelCampaigns();
    renderAdsIntelPerCampaignRules();
    syncAdsIntelModeUi();
  });

  document
    .getElementById("btnAdsIntelCopyRuleToSelected")
    ?.addEventListener("click", () => {
      adsIntelCopyRuleToSelected();
    });

  document
    .getElementById("btnAdsIntelCopyHourRuleToTargets")
    ?.addEventListener("click", () => {
      adsIntelCopyHourRulesToTargets();
    });

  document.getElementById("adsIntelCampaignSearch")?.addEventListener("input", () => {
    renderAdsIntelCampaigns();
  });

  document.querySelectorAll("[data-ads-subtab]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.getAttribute("data-ads-subtab") || "cpc";
      document.querySelectorAll("[data-ads-subtab]").forEach((tabButton) => {
        const active = tabButton.getAttribute("data-ads-subtab") === next;
        tabButton.classList.toggle("btn-primary", active);
        tabButton.classList.toggle("btn-ghost", !active);
      });
      document.querySelectorAll(".ads-subtab-panel").forEach((panel) => {
        const active = panel.id === `ads-subtab-${next}`;
        panel.classList.toggle("is-active", active);
      });
      if (next === "ranking") {
        renderAdsRanking();
        if (!cpcCampaignsMaster.length) loadAdsAll().catch(() => {});
      }
      if (next === "boost" && window.adsBoostManager) {
        window.adsBoostManager.load();
      }
      if (next === "intelligence") {
        if (!adsIntelState?.dataset) {
          loadAdsIntelligenceOverview().catch((error) => {
            adsIntelSetMsg(error?.message || "Falha ao carregar Intelligence Ads.");
          });
        } else {
          renderAdsIntelCampaigns();
          renderAdsIntelHourly();
        }
      }
    });
  });
});

/* ===========================
   Load All (CPC independente, sem alert)
=========================== */

async function loadAdsAll() {
  setMsg("cpcCampaignMsg", "");
  setLoading("cpcLoading", "Carregando CPC...");
  let shouldLoadRealRoas = true;

  const btn = document.getElementById("btnAdsReload");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Carregando...";
  }

  try {
    let { dateFrom, dateTo } = getDates();
    if (!dateFrom || !dateTo) {
      ensureDefaultDates();
      ({ dateFrom, dateTo } = getDates());
      if (!dateFrom || !dateTo) throw new Error("Datas inválidas.");
    }

    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    const diffDays = Math.ceil((to - from) / (1000 * 60 * 60 * 24));

    let cpcDateFrom = dateFrom;
    let cpcDateTo = dateTo;

    if (Number.isFinite(diffDays) && diffDays > 30) {
      const cutTo = new Date(to);
      const cutFrom = new Date(to);
      cutFrom.setDate(cutFrom.getDate() - 30);
      cpcDateTo = isoLocalDate(cutTo);
      cpcDateFrom = isoLocalDate(cutFrom);
    }

    await Promise.all([
      (async () => {
        try {
          await loadCpcBalance();
          await loadCpcDaily(cpcDateFrom, cpcDateTo);
          await loadCpcCampaigns(cpcDateFrom, cpcDateTo);
        } catch (e) {
          if (handleAdsNotConnected(e)) {
            shouldLoadRealRoas = false;
            return;
          }
          setMsg("cpcCampaignMsg", e.message || "Falha ao carregar CPC.");
        } finally {
          setLoading("cpcLoading", "");
        }
      })(),
    ]);
  } catch (e) {
    if (handleAdsNotConnected(e)) {
      shouldLoadRealRoas = false;
      return;
    }
    setMsg("cpcCampaignMsg", e.message || "Falha ao carregar Ads.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Atualizar";
      if (shouldLoadRealRoas) {
        try {
          await loadAdsRoasRealApproxForUi();
        } catch (e) {
          // não quebra a aba Ads se o endpoint falhar
          if (!handleAdsNotConnected(e)) {
            setText("kpiCpcRealGmv", "—");
          }
        }
      }
    }
    if (window.adsBoostManager) {
      try {
        window.adsBoostManager.load({ silent: true });
      } catch (_error) {}
    }
    setLoading("cpcLoading", "");
  }
}

window.loadAdsAll = loadAdsAll;

/* ===========================
   CPC
=========================== */

function parseCampaignIdsCsv(s) {
  const seen = new Set();
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

function getGroupById(id) {
  const gid = String(id || "");
  return cachedCampaignGroups.find((g) => String(g.id) === gid) || null;
}

function computeGroupAgg(group) {
  const ids = Array.isArray(group?.campaign_ids) ? group.campaign_ids : [];

  const byCampaign = new Map(
    cpcCampaignsMaster.map((x) => [String(x.campaign_id), x]),
  );

  let totals = {
    campaigns: 0,
    impression: 0,
    clicks: 0,
    expense: 0,
    direct_gmv: 0,
    budget: 0,
    credit_estimated: 0, // budget - expense do período
  };

  // União de itens vinculados (sem duplicar por item_id)
  const itemMap = new Map(); // item_id -> {item_id,title,image_url,product_name,status}

  for (const cid of ids) {
    const row = byCampaign.get(String(cid));
    if (row) {
      totals.campaigns += 1;
      totals.impression += Number(row.impression || 0);
      totals.clicks += Number(row.clicks || 0);
      totals.expense += Number(row.expense || 0);
      totals.direct_gmv += Number(row.direct_gmv || 0);

      // budget e crédito estimado já calculado no row
      if (row.budget != null) totals.budget += Number(row.budget || 0);
      if (row.credit_estimated != null)
        totals.credit_estimated += Number(row.credit_estimated || 0);
    } else {
      // campanha do grupo não apareceu no período -> conta como “fora do período”
      totals.campaigns += 1;
    }

    const set = cachedCampaignSettings.get(String(cid));
    const linked = Array.isArray(set?.linked_items) ? set.linked_items : [];
    for (const it of linked) {
      const key = String(it.item_id || "");
      if (!key) continue;

      const prev = itemMap.get(key) || {};
      itemMap.set(key, {
        item_id: key,
        title: it.title || prev.title || null,
        image_url: it.image_url || prev.image_url || null,
        product_name: it.product_name || prev.product_name || null,
        status: it.status || prev.status || null,
      });
    }
  }

  return { totals, linkedItems: Array.from(itemMap.values()) };
}

function renderGroupSummary(group) {
  const box = document.getElementById("adsGroupSummary");
  if (!box) return;

  if (!group) {
    box.innerHTML = "";
    return;
  }

  const { totals, linkedItems } = computeGroupAgg(group);

  box.innerHTML = `
    <div class="kpi-grid kpi-grid-sm">
      <div class="kpi"><div class="kpi-label">Campanhas</div><div class="kpi-value">${fmtInt(
        totals.campaigns,
      )}</div></div>
      <div class="kpi"><div class="kpi-label">Gasto</div><div class="kpi-value">${fmtMoney(
        totals.expense,
      )}</div></div>
      <div class="kpi"><div class="kpi-label">GMV Dir.</div><div class="kpi-value">${fmtMoney(
        totals.direct_gmv,
      )}</div></div>
      <div class="kpi"><div class="kpi-label">Budget (soma)</div><div class="kpi-value">${fmtMoney(
        totals.budget,
      )}</div></div>
      <div class="kpi"><div class="kpi-label">Crédito (est.)</div><div class="kpi-value">${fmtMoney(
        totals.credit_estimated,
      )}</div></div>
      <div class="kpi"><div class="kpi-label">Itens (união)</div><div class="kpi-value">${fmtInt(
        linkedItems.length,
      )}</div></div>
    </div>
    <div class="muted" style="margin-top:8px;">
      Crédito (est.) = soma de (budget − gasto) das campanhas no período ${
        lastCpcRange.dateFrom || "—"
      } → ${lastCpcRange.dateTo || "—"}.
    </div>
  `;
}

function openGroupItemsModal(group) {
  const { linkedItems } = computeGroupAgg(group);

  const rows = linkedItems
    .map((it) => {
      const productHtml = `
        <div class="product-cell">
          <img class="product-thumb" src="${
            it.image_url || ""
          }" onerror="this.style.display='none'">
          <div>
            <div style="font-weight:700">${
              it.title || "Item " + it.item_id
            }</div>
            <div class="muted">${it.item_id}</div>
          </div>
        </div>
      `;
      return `
        <tr>
          <td>${productHtml}</td>
          <td>${it.product_name || "—"}</td>
          <td>${it.status || "—"}</td>
        </tr>
      `;
    })
    .join("");

  const html = `
    <div class="muted" style="margin-bottom:10px;">
      Itens agregados (união) do grupo <b>${escHtml(group.name)}</b>.
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Produto</th>
            <th>Nome no Ads</th>
            <th>Status no Ads</th>
          </tr>
        </thead>
        <tbody>
          ${
            rows ||
            `<tr><td colspan="3" class="muted">Nenhum item encontrado.</td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;

  openModal(`Itens do grupo`, html);
}

function renderGroupItemsInline(group) {
  const box = document.getElementById("adsGroupItems");
  if (!box) return;

  if (!group) {
    box.innerHTML = "";
    return;
  }

  const { linkedItems } = computeGroupAgg(group);

  const rows = linkedItems
    .map((it) => {
      const productHtml = `
      <div class="product-cell">
        <img class="product-thumb" src="${
          it.image_url || ""
        }" onerror="this.style.display='none'">
        <div>
          <div style="font-weight:700">${escHtml(
            it.title || "Item " + it.item_id,
          )}</div>
          <div class="muted">ID: ${escHtml(it.item_id)}</div>
        </div>
      </div>
    `;

      return `<tr><td>${productHtml}</td><td>${escHtml(
        it.product_name || "—",
      )}</td><td>${escHtml(it.status || "—")}</td></tr>`;
    })
    .join("");

  box.innerHTML = `
    <div class="muted" style="margin:8px 0;">Itens dentro do grupo</div>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Produto</th><th>Nome no Ads</th><th>Status no Ads</th></tr></thead>
        <tbody>${
          rows ||
          `<tr><td colspan="3" class="muted">Nenhum item encontrado no grupo.</td></tr>`
        }</tbody>
      </table>
    </div>
  `;
}

async function loadCampaignGroups() {
  setMsg("adsGroupMsg", "");
  setLoading("adsGroupLoading", "Carregando grupos...");

  try {
    const j = await apiGet("/shops/active/ads/campaign-groups");
    const groups = j?.response?.groups || [];
    cachedCampaignGroups = groups;

    const sel = document.getElementById("adsGroupSelect");
    if (sel) {
      sel.innerHTML = `<option value="">Selecione um grupo…</option>`;
      for (const g of groups) {
        const opt = document.createElement("option");
        opt.value = String(g.id);
        opt.textContent = g.name;
        sel.appendChild(opt);
      }
      // tenta manter seleção
      if (selectedCampaignGroupId) sel.value = String(selectedCampaignGroupId);
    }

    renderGroupSummary(getGroupById(selectedCampaignGroupId));
    renderGroupItemsInline(getGroupById(selectedCampaignGroupId));
  } catch (e) {
    setMsg("adsGroupMsg", e.message || "Falha ao carregar grupos.");
  } finally {
    setLoading("adsGroupLoading", "");
  }
}

function openAdsGroupCreateModal() {
  openModal(
    "Criar grupo de campanhas",
    `
      <div class="field">
        <label class="muted">Nome (obrigatório)</label>
        <input id="adsGroupName" class="input" type="text" placeholder="Ex: Linha Premium">
      </div>
      <div class="field" style="margin-top:10px;">
        <label class="muted">Descrição (opcional)</label>
        <input id="adsGroupDesc" class="input" type="text" placeholder="Ex: campanhas de alto ticket">
      </div>
      <div class="field" style="margin-top:10px;">
        <label class="muted">Campaign IDs (CSV)</label>
        <input id="adsGroupCampaignIds" class="input" type="text" placeholder="123, 456, 789">
        <div class="muted" style="margin-top:6px;">Unitária = 1 ID • Grupal = vários IDs</div>
      </div>
      <div class="actions" style="margin-top:14px;">
        <button id="btnAdsGroupCreateSubmit" class="btn btn-primary">Criar</button>
      </div>
    `,
  );

  const submit = document.getElementById("btnAdsGroupCreateSubmit");
  if (!submit) return;

  submit.addEventListener("click", async () => {
    setMsg("adsGroupMsg", "");
    setLoading("adsGroupLoading", "Criando grupo...");

    try {
      const name = document.getElementById("adsGroupName")?.value || "";
      const description =
        document.getElementById("adsGroupDesc")?.value || null;
      const campaignIdsCsv =
        document.getElementById("adsGroupCampaignIds")?.value || "";
      const campaignIds = parseCampaignIdsCsv(campaignIdsCsv);

      await apiPost("/shops/active/ads/campaign-groups", {
        name,
        description,
        campaignIds,
      });

      const overlay = document.getElementById("modal-overlay");
      if (overlay) overlay.style.display = "none";

      await loadCampaignGroups();
      setMsg("adsGroupMsg", "Grupo criado.");
    } catch (e) {
      setMsg("adsGroupMsg", e.message || "Falha ao criar grupo.");
    } finally {
      setLoading("adsGroupLoading", "");
    }
  });
}

function openAdsGroupEditModal() {
  const g = getGroupById(selectedCampaignGroupId);
  if (!g) return setMsg("adsGroupMsg", "Selecione um grupo primeiro.");

  openModal(
    "Editar grupo de campanhas",
    `
      <div class="field">
        <label class="muted">Nome</label>
        <input id="adsGroupName" class="input" type="text" value="${escAttr(
          g.name || "",
        )}">
      </div>
      <div class="field" style="margin-top:10px;">
        <label class="muted">Descrição</label>
        <input id="adsGroupDesc" class="input" type="text" value="${escAttr(
          g.description || "",
        )}">
      </div>
      <div class="field" style="margin-top:10px;">
        <label class="muted">Campaign IDs (CSV)</label>
        <input id="adsGroupCampaignIds" class="input" type="text" value="${escAttr(
          (g.campaign_ids || []).join(", "),
        )}">
      </div>
      <div class="actions" style="margin-top:14px;">
        <button id="btnAdsGroupEditSubmit" class="btn btn-primary">Salvar</button>
      </div>
    `,
  );

  const submit = document.getElementById("btnAdsGroupEditSubmit");
  if (!submit) return;

  submit.addEventListener("click", async () => {
    setMsg("adsGroupMsg", "");
    setLoading("adsGroupLoading", "Salvando grupo...");

    try {
      const name = document.getElementById("adsGroupName")?.value || "";
      const description =
        document.getElementById("adsGroupDesc")?.value || null;
      const campaignIdsCsv =
        document.getElementById("adsGroupCampaignIds")?.value || "";
      const campaignIds = parseCampaignIdsCsv(campaignIdsCsv);

      await apiPut(`/shops/active/ads/campaign-groups/${g.id}`, {
        name,
        description,
        campaignIds,
      });

      const overlay = document.getElementById("modal-overlay");
      if (overlay) overlay.style.display = "none";

      await loadCampaignGroups();
      setMsg("adsGroupMsg", "Grupo atualizado.");
    } catch (e) {
      setMsg("adsGroupMsg", e.message || "Falha ao atualizar grupo.");
    } finally {
      setLoading("adsGroupLoading", "");
    }
  });
}

async function deleteAdsGroupSelected() {
  const g = getGroupById(selectedCampaignGroupId);
  if (!g) return setMsg("adsGroupMsg", "Selecione um grupo primeiro.");

  setMsg("adsGroupMsg", "");
  setLoading("adsGroupLoading", "Excluindo grupo...");

  try {
    await apiDelete(`/shops/active/ads/campaign-groups/${g.id}`);
    selectedCampaignGroupId = null;

    const sel = document.getElementById("adsGroupSelect");
    if (sel) sel.value = "";

    renderGroupSummary(null);
    renderGroupItemsInline(null);
    await loadCampaignGroups();

    setMsg("adsGroupMsg", "Grupo excluído.");
  } catch (e) {
    setMsg("adsGroupMsg", e.message || "Falha ao excluir grupo.");
  } finally {
    setLoading("adsGroupLoading", "");
  }
}

async function loadCpcBalance() {
  const j = await apiGet("/shops/active/ads/balance");
  const bal = j?.response?.total_balance;
  setText("kpiAdsBalance", fmtMoney(bal));
}

async function loadCpcDaily(dateFrom, dateTo) {
  const todayIso = getAdsTodayIso();
  const wantsToday = String(dateTo) === todayIso;
  const lastClosedDayIso = shiftIsoDate(todayIso, -1);
  const effectiveDateTo =
    wantsToday && String(dateFrom) <= lastClosedDayIso
      ? lastClosedDayIso
      : dateTo;

  let series = [];

  if (String(effectiveDateTo) >= String(dateFrom)) {
    const j = await apiGet(
      `/shops/active/ads/performance/daily?dateFrom=${encodeURIComponent(
        dateFrom,
      )}&dateTo=${encodeURIComponent(effectiveDateTo)}`,
    );

    series = Array.isArray(j?.response?.series) ? j.response.series : [];
  }

  if (wantsToday) {
    try {
      const todayAggregate = await loadCpcHourlyTodayAggregate(todayIso);
      if (todayAggregate) series = series.concat(todayAggregate);
    } catch (_) {
      // Mantem o periodo carregado ate o ultimo dia consolidado caso hoje ainda nao esteja pronto.
    }
  }

  series = [...series]
    .filter((item) => item?.date)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));

  const totals = series.reduce(
    (acc, x) => {
      acc.impression += Number(x?.impression || 0);
      acc.clicks += Number(x?.clicks || 0);
      acc.expense += Number(x?.expense || 0);
      acc.direct_gmv += Number(x?.direct_gmv || 0);
      acc.broad_gmv += Number(x?.broad_gmv || 0);
      acc.direct_order += Number(x?.direct_order || 0);
      acc.broad_order += Number(x?.broad_order || 0);
      acc.direct_item_sold += Number(x?.direct_item_sold || 0);
      acc.broad_item_sold += Number(x?.broad_item_sold || 0);
      return acc;
    },
    {
      impression: 0,
      clicks: 0,
      expense: 0,
      direct_gmv: 0,
      broad_gmv: 0,
      direct_order: 0,
      broad_order: 0,
      direct_item_sold: 0,
      broad_item_sold: 0,
    },
  );

  setText("kpiCpcExpense", fmtMoney(totals.expense));
  setText("kpiCpcImpressions", fmtInt(totals.impression));
  setText("kpiCpcClicks", fmtInt(totals.clicks));
  setText("kpiCpcCtr", fmtPctFromClicksImpr(totals.clicks, totals.impression));
  setText("kpiCpcDirectGmv", fmtMoney(totals.direct_gmv));
  setText("kpiCpcBroadGmv", fmtMoney(totals.broad_gmv));
  setText("kpiCpcAdsOrders", fmtInt(getAdsOrdersFromTotals(totals)));
  setText("kpiCpcAdsItemsSold", fmtInt(getAdsItemsSoldFromTotals(totals)));
  const exp = Number(totals.expense || 0);
  const gmvD = Number(totals.direct_gmv || 0);
  const gmvB = Number(totals.broad_gmv || 0);
  setText("kpiCpcRoas", exp > 0 ? (gmvD / exp).toFixed(2) : "—");
  setText("kpiCpcRoasBroad", exp > 0 ? (gmvB / exp).toFixed(2) : "—");
  const labels = series.map((x) => x.date);
  const ds = [
    {
      label: "Impressões",
      data: series.map((x) => x.impression),
      borderColor: ADS_NEO.blue,
      neoGlowColor: ADS_NEO.blue,
      borderWidth: 2,
      tension: 0.28,
      pointRadius: 0,
    },
    {
      label: "Cliques",
      data: series.map((x) => x.clicks),
      borderColor: ADS_NEO.up,
      neoGlowColor: ADS_NEO.up,
      borderWidth: 2,
      tension: 0.28,
      pointRadius: 0,
    },
    {
      label: "Gasto",
      data: series.map((x) => x.expense),
      borderColor: ADS_NEO.down,
      neoGlowColor: ADS_NEO.down,
      borderWidth: 2,
      tension: 0.28,
      pointRadius: 0,
    },
    {
      label: "GMV Direto",
      data: series.map((x) => x.direct_gmv),
      borderColor: (context) => {
        const chart = context.chart;
        const { ctx, chartArea } = chart;
        if (!chartArea) return ADS_NEO.purple; // primeira renderização pode vir sem chartArea
        return makeNeoGradient(ctx, chartArea, [
          [0, ADS_NEO.purple],
          [1, ADS_NEO.cyan],
        ]);
      },
      neoGlowColor: ADS_NEO.purple,
      borderWidth: 2,
      tension: 0.28,
      pointRadius: 0,
    },
    {
      label: "GMV Broad",
      data: series.map((x) => x.broad_gmv),
      borderColor: ADS_NEO.cyan,
      neoGlowColor: ADS_NEO.cyan,
      borderWidth: 2,
      tension: 0.28,
      pointRadius: 0,
    },
  ];

  chartCpcDaily = safeDestroyChart(chartCpcDaily);
  chartCpcDaily = renderLineChart("chartCpcDaily", labels, ds);
}

async function loadCpcCampaigns(dateFrom, dateTo) {
  console.log("loadCpcCampaigns", dateFrom, dateTo);
  lastCpcRange = { dateFrom, dateTo };
  setMsg("cpcCampaignMsg", "");
  selectedCpcCampaignId = null;

  const todayIso = getAdsTodayIso();
  const wantsToday = String(dateTo) === todayIso;
  const lastClosedDayIso = shiftIsoDate(todayIso, -1);
  let effectiveDateTo = dateTo;
  let usingTodayFallback = false;
  let skipPerformanceFetch = false;

  if (wantsToday) {
    if (String(dateFrom) > lastClosedDayIso) {
      skipPerformanceFetch = true;
      usingTodayFallback = true;
    } else {
      effectiveDateTo = lastClosedDayIso;
      usingTodayFallback = true;
    }
  }

  // cache settings por período CPC
  const newKey = `cpc:${dateFrom}:${effectiveDateTo}`;
  if (cachedSettingsKey !== newKey) {
    cachedSettingsKey = newKey;
    cachedCampaignSettings = new Map();
  }

  const perf = skipPerformanceFetch
    ? { response: { campaigns: [], seriesByCampaignId: {} } }
    : await apiGet(
        `/shops/active/ads/campaigns/performance/daily?dateFrom=${encodeURIComponent(
          dateFrom,
        )}&dateTo=${encodeURIComponent(effectiveDateTo)}&adType=`,
      );

  let campaigns = Array.isArray(perf?.response?.campaigns)
    ? perf.response.campaigns
    : [];
  if (!campaigns.length && Array.isArray(perf?.response?.campaign_list)) {
    campaigns = perf.response.campaign_list.map((campaign) => ({
      campaign_id: campaign?.campaign_id,
      ad_name: campaign?.ad_name || "",
      ad_type: campaign?.ad_type || "",
      campaign_status: campaign?.campaign_status || campaign?.status || "",
      campaign_placement: campaign?.campaign_placement || "",
      metrics: Array.isArray(campaign?.metrics_list)
        ? campaign.metrics_list.reduce(
            (acc, metric) => {
              acc.impression += Number(metric?.impression || 0);
              acc.clicks += Number(metric?.clicks || 0);
              acc.expense += Number(metric?.expense || 0);
              acc.direct_gmv += Number(metric?.direct_gmv || 0);
              acc.broad_gmv += Number(metric?.broad_gmv || 0);
              acc.direct_order += Number(metric?.direct_order || 0);
              acc.broad_order += Number(metric?.broad_order || 0);
              return acc;
            },
            {
              impression: 0,
              clicks: 0,
              expense: 0,
              direct_gmv: 0,
              broad_gmv: 0,
              direct_order: 0,
              broad_order: 0,
            },
          )
        : campaign?.metrics || {},
    }));
  }

  console.log("CPC campaigns len:", campaigns.length, perf);
  cachedCampaignSeries = perf?.response?.seriesByCampaignId || {};

  let ids = campaigns
    .map((c) => c.campaign_id)
    .filter(Boolean)
    .map((x) => String(x));

  const idsResp = await apiGet("/shops/active/ads/campaigns/ids?adType=");
  const fromCampaignList = Array.isArray(idsResp?.response?.campaign_list)
    ? idsResp.response.campaign_list
        .map((item) => item?.campaign_id)
        .filter(Boolean)
    : [];
  const fromResponseArray = Array.isArray(idsResp?.response)
    ? idsResp.response.map((item) =>
        item && typeof item === "object" ? item?.campaign_id : item,
      )
    : [];
  const fromCampaignIdList = Array.isArray(idsResp?.response?.campaign_id_list)
    ? idsResp.response.campaign_id_list
    : [];

  ids = Array.from(
    new Set(
      [...ids, ...fromCampaignList, ...fromResponseArray, ...fromCampaignIdList]
        .filter((value) => value != null && String(value).trim() !== "")
        .map((value) => String(value)),
    ),
  );

  const campaignById = new Map(
    campaigns
      .filter((campaign) => campaign?.campaign_id != null)
      .map((campaign) => [String(campaign.campaign_id), campaign]),
  );

  for (const campaignId of ids) {
    if (campaignById.has(String(campaignId))) continue;
    const emptyCampaign = {
      campaign_id: campaignId,
      ad_name: "",
      ad_type: "",
      campaign_status: "",
      campaign_placement: "",
      metrics: {
        impression: 0,
        clicks: 0,
        expense: 0,
        direct_gmv: 0,
        broad_gmv: 0,
        direct_order: 0,
        broad_order: 0,
      },
    };
    campaignById.set(String(campaignId), emptyCampaign);
  }

  campaigns = Array.from(campaignById.values());

  const missing = ids.filter((id) => !cachedCampaignSettings.has(id));

  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const settings = await apiGet(
      `/shops/active/ads/campaigns/settings?campaignIds=${encodeURIComponent(
        batch.join(","),
      )}&infoTypes=1,2,3,4`,
    );
    const list = settings?.response?.campaign_list || [];
    for (const c of list) cachedCampaignSettings.set(String(c.campaign_id), c);
  }

  lastCpcCampaignRows = campaigns.map((row) => {
    const set = cachedCampaignSettings.get(String(row.campaign_id));
    const thumb = set?.linked_items?.[0]?.image_url || null;
    const roasTarget =
      set?.auto_bidding_info?.roas_target ??
      set?.manual_bidding_info?.roas_target ??
      null;
    const common = set?.common_info || {};
    const m = row.metrics || {};
    const creditEstimated =
      common.campaign_budget != null
        ? Number(common.campaign_budget) - Number(m.expense || 0)
        : null;
    const directRoas =
      m.expense && m.direct_gmv ? m.direct_gmv / m.expense : null;
    const directAcos = m.direct_gmv ? (m.expense / m.direct_gmv) * 100 : null;

    return {
      campaign_id: row.campaign_id,
      ad_name: common.ad_name || row.ad_name || "",
      ad_type: common.ad_type || row.ad_type || "",
      campaign_status:
        common.campaign_status || row.campaign_status || row.status || "",
      placement: common.campaign_placement || row.campaign_placement || "",
      created_at:
        common.create_time ??
        common.created_time ??
        common.creation_time ??
        common.created_at ??
        row.create_time ??
        row.created_at ??
        null,
      budget: common.campaign_budget ?? null,
      impression: m.impression ?? 0,
      clicks: m.clicks ?? 0,
      expense: m.expense ?? 0,
      direct_gmv: m.direct_gmv ?? 0,
      direct_order: m.direct_order ?? 0,
      broad_order: m.broad_order ?? 0,
      direct_roas: directRoas,
      direct_acos_pct: directAcos,
      credit_estimated: creditEstimated,
      roas_target: roasTarget,
      thumbnail_url: thumb,
    };
  });
  console.log("CPC rows:", lastCpcCampaignRows.length);
  console.log(
    "CPC status sample:",
    lastCpcCampaignRows.slice(0, 10).map((x) => x.campaign_status),
  );
  console.log(
    "CPC buckets:",
    Array.from(
      new Set(
        lastCpcCampaignRows.map((x) =>
          statusBucketFromCampaignStatus(x.campaign_status),
        ),
      ),
    ),
  );
  cpcCampaignsMaster = [...lastCpcCampaignRows];
  resetCpcPager();
  applyCpcCampaignView();
  if (cpcCampaignsMaster.length > 0 && cpcCampaignsView.length === 0) {
    const filterEl = document.getElementById("cpcCampaignFilter");
    const hadFilter = filterEl && String(filterEl.value || "").trim();

    if (hadFilter) {
      filterEl.value = "";
      localStorage.setItem("ads_cpc_filter", "");

      applyCpcCampaignView();
      setMsg(
        "cpcCampaignMsg",
        "Filtro limpo automaticamente para exibir campanhas.",
      );
    }
  }
  if (cpcCampaignsView.length) {
    selectCampaign(cpcCampaignsView[0].campaign_id);
  } else {
    setText("cpcCampaignSelected", "Nenhuma selecionada");
  }
  await loadCampaignGroups();
  // ✅ trazer campanhas do grupo mesmo sem performance no período
  const groupIds = (cachedCampaignGroups || [])
    .flatMap((g) => (Array.isArray(g.campaign_ids) ? g.campaign_ids : []))
    .map((x) => String(x));

  await ensureCampaignSettingsLoaded(groupIds);

  const byId = new Map(
    cpcCampaignsMaster.map((x) => [String(x.campaign_id), x]),
  );

  // ✅ 1) Atualiza campanhas já existentes com dados do SETTINGS (inclui status atual!)
  for (const [cid, row] of byId.entries()) {
    const set = cachedCampaignSettings.get(String(cid));
    const common = set?.common_info || {};
    if (!set || !common) continue;

    const roasTarget =
      set?.auto_bidding_info?.roas_target ??
      set?.manual_bidding_info?.roas_target ??
      row.roas_target ??
      null;

    row.ad_name = common.ad_name || row.ad_name || "";
    row.ad_type = common.ad_type || row.ad_type || "";
    row.campaign_status = common.campaign_status || row.campaign_status || ""; // ⭐ aqui resolve
    row.placement = common.campaign_placement || row.placement || "";
    row.created_at =
      common.create_time ??
      common.created_time ??
      common.creation_time ??
      common.created_at ??
      row.created_at ??
      null;
    row.budget = common.campaign_budget ?? row.budget ?? null;
    row.roas_target = roasTarget;
  }

  // ✅ 2) Adiciona campanhas do grupo que não estavam na performance
  for (const cid of groupIds) {
    if (byId.has(cid)) continue;

    const set = cachedCampaignSettings.get(String(cid));
    const common = set?.common_info || {};
    const roasTarget =
      set?.auto_bidding_info?.roas_target ??
      set?.manual_bidding_info?.roas_target ??
      null;

    byId.set(String(cid), {
      campaign_id: Number(cid),
      ad_name: common.ad_name || "",
      ad_type: common.ad_type || "",
      campaign_status: common.campaign_status || "",
      placement: common.campaign_placement || "",
      created_at:
        common.create_time ??
        common.created_time ??
        common.creation_time ??
        common.created_at ??
        null,
      budget: common.campaign_budget ?? null,
      impression: 0,
      clicks: 0,
      expense: 0,
      direct_gmv: 0,
      direct_order: 0,
      broad_order: 0,
      direct_roas: null,
      direct_acos_pct: null,
      credit_estimated: common.campaign_budget ?? null,
      roas_target: roasTarget,
    });
  }

  cpcCampaignsMaster = Array.from(byId.values());
  applyCpcCampaignView();
  console.log(
    "Active count:",
    cpcCampaignsMaster.filter(
      (x) => statusBucketFromCampaignStatus(x.campaign_status) === "active",
    ).length,
  );

  console.log(
    "Buckets after merge:",
    Array.from(
      new Set(
        cpcCampaignsMaster.map((x) =>
          statusBucketFromCampaignStatus(x.campaign_status),
        ),
      ),
    ),
  );

  console.log(
    "Settings status sample:",
    groupIds
      .slice(0, 10)
      .map(
        (id) =>
          cachedCampaignSettings.get(String(id))?.common_info?.campaign_status,
      ),
  );

  if (usingTodayFallback) {
    setMsg(
      "cpcCampaignMsg",
      skipPerformanceFetch
        ? "Campanhas CPC carregadas pela configuracao atual. As metricas de hoje ainda estao em consolidacao na Shopee Ads."
        : "Campanhas carregadas ate ontem. O dia atual ainda esta em consolidacao na Shopee Ads.",
    );
  }
}

async function ensureCampaignSettingsLoaded(campaignIds) {
  const ids = (Array.isArray(campaignIds) ? campaignIds : [])
    .map((x) => String(x))
    .filter(Boolean);

  const missing = ids.filter((id) => !cachedCampaignSettings.has(id));

  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const settings = await apiGet(
      `/shops/active/ads/campaigns/settings?campaignIds=${encodeURIComponent(
        batch.join(","),
      )}&infoTypes=1,2,3,4`,
    );
    const list = settings?.response?.campaign_list || [];
    for (const c of list) cachedCampaignSettings.set(String(c.campaign_id), c);
  }
}

function setCampaignProductKpis(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];

  const impressionValues = safeRows
    .map((row) =>
      pickMetricValue(row, [
        "impression",
        "impressions",
        "impression_count",
        "impressionCount",
        "view_count",
        "views",
      ]),
    )
    .filter((value) => value != null);
  const clickValues = safeRows
    .map((row) =>
      pickMetricValue(row, [
        "clicks",
        "click",
        "click_count",
        "clickCount",
      ]),
    )
    .filter((value) => value != null);
  const impressionRows = impressionValues;
  const clickRows = clickValues;

  const productImpressions = impressionValues.reduce(
    (sum, value) => sum + Number(value || 0),
    0,
  );
  const productClicks = clickValues.reduce(
    (sum, value) => sum + Number(value || 0),
    0,
  );

  setText(
    "cpcCampProdImp",
    impressionRows.length ? fmtInt(productImpressions) : "—",
  );
  setText("cpcCampProdClicks", clickRows.length ? fmtInt(productClicks) : "—");
}

async function selectCampaign(campaignId) {
  selectedCpcCampaignId = String(campaignId);
  markSelectedCampaignRow(selectedCpcCampaignId);
  const id = String(campaignId);
  const set = cachedCampaignSettings.get(id);
  const common = set?.common_info || {};

  setText(
    "cpcCampaignSelected",
    common.ad_name ? `${common.ad_name} (#${id})` : `#${id}`,
  );

  const series = cachedCampaignSeries[id] || [];
  const totals = series.reduce(
    (a, x) => {
      a.impression += x.impression || 0;
      a.clicks += x.clicks || 0;
      a.expense += x.expense || 0;
      a.direct_gmv += x.direct_gmv || 0;
      return a;
    },
    { impression: 0, clicks: 0, expense: 0, direct_gmv: 0 },
  );

  setText("cpcCampImp", fmtInt(totals.impression));
  setText("cpcCampClicks", fmtInt(totals.clicks));
  setText("cpcCampExpense", fmtMoney(totals.expense));
  setText("cpcCampDirectGmv", fmtMoney(totals.direct_gmv));
  setCampaignProductKpis([]);

  const labels = series.map((x) => x.date);
  const ds = [
    {
      label: "Impressões",
      data: series.map((x) => x.impression),
      borderColor: ADS_NEO.blue,
      neoGlowColor: ADS_NEO.blue,
      borderWidth: 2,
      tension: 0.28,
      pointRadius: 0,
    },
    {
      label: "Cliques",
      data: series.map((x) => x.clicks),
      borderColor: ADS_NEO.up,
      neoGlowColor: ADS_NEO.up,
      borderWidth: 2,
      tension: 0.28,
      pointRadius: 0,
    },
    {
      label: "Gasto",
      data: series.map((x) => x.expense),
      borderColor: ADS_NEO.down,
      neoGlowColor: ADS_NEO.down,
      borderWidth: 2,
      tension: 0.28,
      pointRadius: 0,
    },
    {
      label: "GMV Direto",
      data: series.map((x) => x.direct_gmv),
      borderColor: ADS_NEO.purple,
      neoGlowColor: ADS_NEO.purple,
      borderWidth: 2,
      tension: 0.28,
      pointRadius: 0,
    },
  ];

  chartCpcCampaign = safeDestroyChart(chartCpcCampaign);
  chartCpcCampaign = renderLineChart("chartCpcCampaign", labels, ds);

  // Desempenho do Produto (tabela de 8 colunas)
  setMsg("cpcItemsMsg", "");
  setLoading("cpcItemsLoading", "Carregando desempenho do produto...");
  lastCpcProductPerfRows = [];

  try {
    const perf = await loadCpcProductPerformance(selectedCpcCampaignId);
    const items = perf?.response?.items || [];
    const ready = Boolean(perf?.response?.performance_ready);

    if (!ready) {
      setMsg(
        "cpcItemsMsg",
        "Desempenho do produto ainda não disponível (endpoint não configurado ou sem dados). Exibindo itens base.",
      );
    }

    renderCpcProductPerformanceTable(items);
  } catch (e) {
    setMsg(
      "cpcItemsMsg",
      e.message || "Falha ao carregar desempenho do produto.",
    );
    renderCpcProductPerformanceTable([]); // mantém tabela consistente
  } finally {
    setLoading("cpcItemsLoading", "");
  }
}

async function loadCpcProductPerformance(campaignId) {
  const { dateFrom, dateTo } = getDates();

  // Essa rota vamos criar no backend na próxima etapa
  return apiPost("/shops/active/ads/campaigns/items/performance", {
    campaignId: String(campaignId),
    dateFrom,
    dateTo,
  });
}

function renderCpcProductPerformanceTable(items) {
  const safeItems = Array.isArray(items) ? items : [];
  lastCpcProductPerfRows = safeItems
    .map((it) => ({
      item_id: String(it.item_id || ""),
      title: it.title || "",
      image_url: it.image_url || "",
      product_name: it.product_name || "",
      status: it.status || "",
      impression: pickMetricValue(it, [
        "impression",
        "impressions",
        "impression_count",
        "impressionCount",
        "view_count",
        "views",
      ]),
      clicks: pickMetricValue(it, [
        "clicks",
        "click",
        "click_count",
        "clickCount",
      ]),
      expense: it.expense ?? null,
      gmv: it.gmv ?? null,
      conversions: it.conversions ?? null,
      items: it.items ?? null,
      monthly_ad_spend: it.monthly_ad_spend ?? null,
      monthly_sales_qty: it.monthly_sales_qty ?? null,
      monthly_cost_per_sale: it.monthly_cost_per_sale ?? null,
      ads_cost_reference_month: it.ads_cost_reference_month || "",
    }))
    .filter((x) => x.item_id);

  setCampaignProductKpis(lastCpcProductPerfRows);

  const tbody = document.querySelector("#tblCpcCampaignItems tbody");
  if (!tbody) return;

  tbody.innerHTML = "";

  for (const it of lastCpcProductPerfRows) {
    const tr = document.createElement("tr");

    const productHtml = `
      <div class="product-cell">
        <img class="product-thumb" src="${
          it.image_url || ""
        }" onerror="this.style.display='none'">
        <div>
          <div style="font-weight:900">${escHtml(
            it.title || "Item " + it.item_id,
          )}</div>
          <div class="muted">ID: ${escHtml(it.item_id)}${
            it.product_name ? " • " + escHtml(it.product_name) : ""
          }${it.status ? " • " + escHtml(it.status) : ""}</div>
        </div>
      </div>
    `;

    // Ação simples: copiar item_id
    const actionHtml = `<button class="btn btn-ghost" data-copy="${escAttr(
      it.item_id,
    )}">Copiar ID</button>`;

    const costPerSale = Number(it.monthly_cost_per_sale || 0);
    const spendRef = Number(it.monthly_ad_spend || 0);
    const salesRef = Number(it.monthly_sales_qty || 0);
    const costHint =
      spendRef > 0 || salesRef > 0
        ? `Mês atual: ${fmtMoney(spendRef)} / ${fmtInt(salesRef)} venda(s)`
        : "Sem investimento mensal rateável no mês atual";

    tr.innerHTML = `
      <td>${productHtml}</td>
      <td>${fmtInt(it.impression)}</td>
      <td>${fmtInt(it.clicks)}</td>
      <td>${fmtMoney(it.expense)}</td>
      <td>${fmtMoney(it.gmv)}</td>
      <td>${fmtInt(it.conversions)}</td>
      <td>${fmtInt(it.items)}</td>
      <td>
        <div style="font-weight:800;">${fmtMoney(costPerSale)}</div>
        <div class="muted" style="font-size:11px;">${escHtml(costHint)}</div>
      </td>
      <td>${actionHtml}</td>
    `;

    // Handler do botão de copiar
    tr.querySelector("button[data-copy]")?.addEventListener(
      "click",
      async (e) => {
        e.stopPropagation();
        const v = e.currentTarget.getAttribute("data-copy") || "";
        try {
          await navigator.clipboard.writeText(v);
          setMsg("cpcItemsMsg", "Item ID copiado.");
        } catch (_) {
          setMsg(
            "cpcItemsMsg",
            "Não foi possível copiar (permissão do navegador).",
          );
        }
      },
    );

    tbody.appendChild(tr);
  }

  if (!lastCpcProductPerfRows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="9" class="muted">Nenhum item retornado para esta campanha no período.</td>`;
    tbody.appendChild(tr);
  }
}

if (typeof window !== "undefined") {
  window.renderAdsRanking = renderAdsRanking;
  window.loadAdsAll = loadAdsAll;
}
