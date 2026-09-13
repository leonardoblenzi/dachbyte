// =============================================================
// Base path helper (supports deployments under /ml)
// =============================================================
const withPromoBase =
  window.withBase ||
  function fallbackWithPromoBase(path) {
    const base =
      typeof window !== "undefined" &&
      (window.__ML_BASE_PATH || window.__ML_BASE__ || window.ML_BASE)
        ? window.__ML_BASE_PATH || window.__ML_BASE__ || window.ML_BASE
        : "";
    if (!path || typeof path !== "string") return path;
    if (!base) return path;
    if (path === base || path.startsWith(base + "/")) return path;
    if (path.startsWith("/")) return base + path;
    return path;
  };

// public/js/criar-promocao.js
// ===================== Bootstrap =====================
console.log("criar-promocao.js carregado");

const PromoState = window.PromoStateHelpers || {};
const PromoActions = window.PromoActions || {};
const PromoSellerCampaign = window.PromoSellerCampaign || {};
const PromoCards = window.PromoCards || {};
const PromoTable = window.PromoTable || {};
const PromoBulkBridge = window.PromoBulkBridge || {};

function notifyPromocoes(message, tone = "info") {
  const text = String(message || "").trim();
  if (!text) return;
  const level = tone === "error" || tone === "warn" ? "warn" : "log";
  console[level](`[criar-promocao] ${text}`);
  if (typeof window.dispatchEvent === "function") {
    window.dispatchEvent(
      new CustomEvent("promo:notice", {
        detail: { message: text, tone },
      }),
    );
  }
}
window.notifyPromocoes = notifyPromocoes;

// =====================================================
// ============ Helpers de HTTP e caminhos =============
// =====================================================

const PromoHttp = window.PromoHttp || {};

/** Converte caminho relativo em absoluto (mantém http/https) */
const toAbs =
  PromoHttp.toAbs ||
  ((p) => (/^https?:\/\//i.test(p) ? p : p.startsWith("/") ? p : `/${p}`));

/**
 * Tenta buscar JSON em uma lista de rotas alternativas, retornando o primeiro sucesso.
 * Loga o motivo de cada falha para facilitar debug.
 */
const getJSONAny =
  PromoHttp.getJSONAny ||
  async function fetchFirstJson(paths) {
    let lastErr;

    for (const p of paths) {
      const url = toAbs(p);

      try {
        const r = await fetch(url, {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });

        const finalUrl = r && r.url ? r.url : url;
        const ct = (r.headers.get("content-type") || "").toLowerCase();
        const looksHtml = ct.includes("text/html");

        if (!r.ok || looksHtml) {
          const body = await r.text().catch(() => "");
          lastErr = new Error(`HTTP ${r.status} ${url}`);
          lastErr.cause = {
            status: r.status,
            url,
            finalUrl,
            contentType: ct,
            body: body ? body.slice(0, 400) : "",
          };
          continue;
        }

        return await r.json();
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr || new Error("Nenhum endpoint respondeu");
  };

// Rotas canônicas — usuários/promos
const usersPaths = PromoHttp.usersPaths || (() => ["/api/promocoes/users"]);

// Rotas canônicas — itens de uma promoção
const itemsPaths =
  PromoHttp.itemsPaths ||
  ((promotionId, type, qs) => {
    const suffix = `?promotion_type=${encodeURIComponent(type)}&app_version=v2${
      qs ? `&${qs}` : ""
    }`;
    const pid = encodeURIComponent(promotionId);
    return [`/api/promocoes/promotions/${pid}/items${suffix}`];
  });

// Rotas canônicas para resolver offer_id / candidate_id via backend
const offerIdsPaths =
  PromoHttp.offerIdsPaths ||
  ((mlb, opts = {}) => {
    const query = new URLSearchParams();
    if (opts.promotion_id) query.set("promotion_id", String(opts.promotion_id));
    if (opts.promotion_type)
      query.set("promotion_type", String(opts.promotion_type));
    if (opts.candidate_id) query.set("candidate_id", String(opts.candidate_id));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return [
      `/api/promocoes/items/${encodeURIComponent(mlb)}/offer-ids${suffix}`,
    ];
  });

// =====================================================
// ============== DOM / formatação básica ==============
// =====================================================

const PAGE_SIZE = 25;
const PAGE_FETCH_BATCH_SIZE = 50;
const PAGE_FETCH_SCAN_LIMIT = 80;
window.PROMO_MANUAL_MAX_PERCENT = Number(window.PROMO_MANUAL_MAX_PERCENT || 60);
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function esc(s) {
  return s == null
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
          })[c],
      );
}

// Escapa string para uso seguro em inline JS (onclick), sem quebrar aspas
const jsStr = (v) => JSON.stringify(String(v ?? ""));

const fmtMoeda = (n) =>
  n == null || isNaN(Number(n))
    ? "—"
    : Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const fmtPerc = (n, d = 2) => (n || n === 0 ? `${Number(n).toFixed(d)}%` : "—");
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function attachManualPercentGuardPayload(payload, item, requestedPercent) {
  const original = toNum(item?.original_price ?? item?.price ?? null);
  const pct = toNum(requestedPercent);
  if (original != null) payload.original_price = original;
  if (isValidManualPromoPercent(pct)) payload.manual_percent = round2(pct);
  return payload;
}

function isValidManualPromoPercent(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= window.PROMO_MANUAL_MAX_PERCENT;
}

function manualPromoPercentMessage(prefix = "Informe um percentual valido") {
  return `${prefix} entre 0,01 e ${window.PROMO_MANUAL_MAX_PERCENT}%.`;
}

function elCards() {
  return document.getElementById("cards");
}
function elTbody() {
  return document.getElementById("tbody");
}
function elPag() {
  return document.getElementById("paginacao");
}
function elProgressText() {
  return document.getElementById("progressText");
}
function elProgressFill() {
  return document.getElementById("progressFill");
}
function getTable() {
  return elTbody()?.closest("table") || null;
}
function elDebugInput() {
  return document.getElementById("debugMlbInput");
}
function elDebugMeta() {
  return document.getElementById("debugMlbMeta");
}
function elDebugOutput() {
  return document.getElementById("debugMlbOutput");
}

function setText(id, value = "") {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = value == null ? "" : String(value);
}

function setLoading(on, message = "") {
  const text = elProgressText();
  const fill = elProgressFill();
  if (text)
    text.textContent = on ? message || "Carregando…" : message || "Pronto.";
  if (fill) fill.style.width = on ? "35%" : "100%";
}

function setProgressMessage(message) {
  const text = elProgressText();
  if (text && message) text.textContent = message;
}

function updateDebugMlbMeta(message = "") {
  const meta = elDebugMeta();
  if (!meta) return;
  if (message) {
    meta.textContent = message;
    return;
  }
  if (!state.selectedCard) {
    meta.textContent = "Selecione uma campanha e informe um MLB.";
    return;
  }
  meta.textContent = `Campanha selecionada: ${state.selectedCard.name || state.selectedCard.id} (${state.selectedCard.type || "—"})`;
}

function setDebugMlbOutput(payload) {
  const output = elDebugOutput();
  if (!output) return;
  output.textContent =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

async function runManualMlbDebug() {
  const mlb = (elDebugInput()?.value || "").trim().toUpperCase();
  if (!mlb) {
    updateDebugMlbMeta("Informe um MLB para rodar o debug.");
    setDebugMlbOutput("Aguardando debug.");
    return;
  }
  if (!state.selectedCard?.id || !state.selectedCard?.type) {
    updateDebugMlbMeta("Selecione uma campanha antes de rodar o debug.");
    setDebugMlbOutput("Nenhuma campanha selecionada.");
    return;
  }

  updateDebugMlbMeta(
    `Executando debug para ${mlb} na campanha ${state.selectedCard.id}...`,
  );
  setDebugMlbOutput("Carregando...");

  const params = new URLSearchParams({
    promotion_id: String(state.selectedCard.id || ""),
    promotion_type: String(state.selectedCard.type || ""),
  });

  try {
    const response = await fetch(
      toAbs(
        `/api/promocoes/debug/items/${encodeURIComponent(mlb)}?${params.toString()}`,
      ),
      {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      },
    );

    const text = await response.text().catch(() => "");
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!response.ok) {
      updateDebugMlbMeta(`Falha no debug de ${mlb}. HTTP ${response.status}.`);
      setDebugMlbOutput(json);
      return;
    }

    updateDebugMlbMeta(
      `Debug carregado para ${mlb} na campanha ${state.selectedCard.id}.`,
    );
    setDebugMlbOutput(json);
  } catch (err) {
    updateDebugMlbMeta(`Erro ao rodar debug de ${mlb}.`);
    setDebugMlbOutput({ error: err?.message || String(err) });
  }
}

// =====================================================
// ====================== STATE ========================
// =====================================================

const state = {
  cards: [],
  cardsFilteredIds: null,
  items: [],
  selectedCard: null,
  promotionBenefits: null,
  activeTypeTab: "DEAL", // DEAL | SMART | SELLER_CAMPAIGN | LIGHTNING | OTHER
  operationMode: "campaign", // campaign | list
  listMode: {
    mlbs: [],
    activeMlbs: [],
    percent: null,
    typeFilter: "SELLER_CAMPAIGN",
    loading: false,
    results: [],
    applyingCampaignId: null,
    selectedCampaignId: null,
    selectedToken: null,
  },

  filtroParticipacao: "all", // all|yes|non|prog
  maxDesc: null, // percent max (número) para filtro
  mlbFilter: "",
  sellerManualPercent: null,
  dealManualPercent: null,
  dealRangeDrafts: {},
  lightningStockDrafts: {},
  manualWizard: {
    percent: null,
    quantity: null,
    stockMin: null,
    stockMax: null,
    listRaw: "",
    listOpen: false,
    listDiagnostics: null,
    verified: false,
    loading: false,
    eligibleTotal: null,
    scope: "all",
    promotionId: null,
    promotionType: null,
    status: null,
    mlb: null,
    mlbsKey: "",
    selectionToken: null,
    selectionIds: null,
    validationJobId: null,
  },
  loadingMessage: "",

  paging: {
    total: 0,
    limit: PAGE_SIZE,
    tokensByPage: { 1: null }, // paginação por search_after
    currentPage: 1,
    lastPageKnown: 1,
  },

  loading: false,
  searchMlb: null,
  sellerCampaignEditor: null,
  openCardMenuId: null,

  // Sessão de aplicação (para HUD / JobsPanel)
  applySession: {
    started: false,
    totalHint: null,
    processed: 0,
    added: 0,
    changed: 0,
    removed: 0,
    errors: 0,
    lastTitle: "",
  },
};

// =====================================================
// =================== HUD (no-op) =====================
// =====================================================
// Mantido propositalmente como no-op para não quebrar chamadas.
// O progresso visual é feito via JobsPanel.
const HUD = {
  open() {},
  bump() {},
  tickProcessed() {},
  reset() {},
  render() {},
};

// ====== Job title cache (front-only) ======
const JobTitleCache =
  window.PromoJobTitleCache ||
  (() => {
    const map = {};
    return {
      set(id, title) {
        if (!id || !title) return;
        map[String(id)] = String(title);
      },
      get(id) {
        return map[String(id)] || null;
      },
    };
  })();

// =====================================================
// ================ Jobs Watcher (poll) ================
// =====================================================

const JobsWatcher =
  window.PromoJobsWatcher ||
  (() => ({
    start() {},
    stop() {},
    isRunning() {
      return false;
    },
    poll() {},
    setFilter() {},
  }))();

function normalizeJobsPanelText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function readShellAccountLabel() {
  const raw = String(
    document.getElementById("account-current")?.textContent || "",
  ).trim();
  if (!raw) return "";
  if (/carregando|indispon|nenhuma selecionada/i.test(raw)) return "";
  return raw;
}

function getCurrentPromoPanelAccount() {
  const shellLabel = readShellAccountLabel();
  const key = normalizeJobsPanelText(window.__ACCOUNT__?.key || "");
  const label = normalizeJobsPanelText(
    shellLabel || window.__ACCOUNT__?.label || "",
  );
  return { key, label };
}

async function ensurePromoPanelAccount({ force = false } = {}) {
  const current = getCurrentPromoPanelAccount();
  if (!force && (current.key || current.label)) return current;
  try {
    const response = await fetch(withPromoBase("/api/account/current"), {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const payload = await response.json().catch(() => ({}));
    const key = String(
      payload?.accountKey || payload?.key || payload?.current?.id || "",
    ).trim();
    const label = String(
      payload?.label || payload?.current?.label || "",
    ).trim();
    if (key || label) {
      window.__ACCOUNT__ = {
        ...(window.__ACCOUNT__ || {}),
        ...(key ? { key } : {}),
        label: label || key || readShellAccountLabel() || "Conta selecionada",
      };
    }
  } catch {}
  return getCurrentPromoPanelAccount();
}

function shouldShowPromoPanelJob(job) {
  const source = String(job?.source || "").toLowerCase();
  const id = normalizeJobsPanelText(job?.id || "");
  const backendId = normalizeJobsPanelText(
    job?.backendJobId || job?.backend_job_id || job?.job_uid || "",
  );
  const title = normalizeJobsPanelText(job?.title || job?.label || "");
  const sourceKey = source.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const titleKey = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const isRemoveJob =
    sourceKey === "remove" ||
    id.startsWith("remove:") ||
    id.startsWith("promocoes:remove:") ||
    backendId.startsWith("remove:") ||
    backendId.startsWith("promocoes:remove:");
  if (isRemoveJob) return false;
  if (titleKey.startsWith("remocao")) return false;

  const looksLikePromoJob =
    sourceKey === "promo" ||
    sourceKey === "promocoes" ||
    titleKey.startsWith("aplicando ") ||
    titleKey.startsWith("aplicacao ") ||
    titleKey.startsWith("exportando csv");
  if (!looksLikePromoJob) return false;

  const currentAccount = getCurrentPromoPanelAccount();
  const currentAccountKey = currentAccount.key;
  const currentAccountLabel = currentAccount.label;
  const jobAccountKey = normalizeJobsPanelText(
    job?.accountKey || job?.account?.key || "",
  );
  const jobAccountLabel = normalizeJobsPanelText(
    job?.accountLabel || job?.account?.label || "",
  );
  if (!currentAccountKey && !currentAccountLabel) return false;
  if (!jobAccountKey && !jobAccountLabel) return false;
  if (currentAccountLabel && jobAccountLabel && currentAccountLabel === jobAccountLabel)
    return true;
  if (currentAccountKey && jobAccountKey)
    return currentAccountKey === jobAccountKey;
  return false;
}

function applyPromoPanelVisibilityFilter() {
  window.JobsPanel?.setAdapter?.("promocoes");
  window.JobsPanel?.setVisibilityFilter?.(shouldShowPromoPanelJob);
}

applyPromoPanelVisibilityFilter();

JobsWatcher.setFilter?.((job) => shouldShowPromoPanelJob(job));

// =====================================================
// =================== Utils diversos ==================
// =====================================================

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function toNum(x) {
  return x === null || x === undefined || x === "" ? null : Number(x);
}

function isSellerCampaignSelected() {
  return PromoSellerCampaign.isSellerCampaignSelected
    ? PromoSellerCampaign.isSellerCampaignSelected(state)
    : String(state.selectedCard?.type || "").toUpperCase() ===
        "SELLER_CAMPAIGN";
}

function isDealSelected() {
  return ["DEAL", "DOD", "LIGHTNING"].includes(
    String(state.selectedCard?.type || "").toUpperCase(),
  );
}

function isLightningSelected() {
  return String(state.selectedCard?.type || "").toUpperCase() === "LIGHTNING";
}

function isDealRangePromotionType(type) {
  return [
    "DEAL",
    "SELLER_CAMPAIGN",
    "PRICE_DISCOUNT",
    "DOD",
    "LIGHTNING",
  ].includes(String(type || "").toUpperCase());
}

function isSmartLikePromotionType(type) {
  const typeUp = String(type || "").toUpperCase();
  return (
    typeUp === "SMART" ||
    typeUp === "PRE_NEGOTIATED" ||
    typeUp === "PRICE_MATCHING" ||
    typeUp === "PRICE_MATCHING_MELI_ALL" ||
    typeUp.startsWith("PRICE_MATCHING")
  );
}

function isSmartApplyFlowSelected() {
  return isSmartLikePromotionType(state.selectedCard?.type);
}

function getGuidedApplyMode() {
  if (isDealSelected()) return "deal";
  if (isSellerCampaignSelected()) return "seller";
  if (String(state.selectedCard?.type || "").toUpperCase() === "PRE_NEGOTIATED") {
    return "pre_negotiated";
  }
  if (isSmartApplyFlowSelected()) return "smart";
  return null;
}

function sellerManualPercentInput() {
  return PromoSellerCampaign.sellerManualPercentInput
    ? PromoSellerCampaign.sellerManualPercentInput()
    : document.getElementById("sellerManualPercentInput");
}

function getSellerManualPercent() {
  return PromoSellerCampaign.getSellerManualPercent
    ? PromoSellerCampaign.getSellerManualPercent(state)
    : (() => {
        const n = Number(state.sellerManualPercent);
        if (!isValidManualPromoPercent(n)) return null;
        return n;
      })();
}

function dealManualPercentInput() {
  return document.getElementById("dealManualPercentInput");
}

function getDealManualPercent() {
  const n = Number(state.dealManualPercent);
  if (!isValidManualPromoPercent(n)) return null;
  return n;
}

function setManualFlowBadge(el, text, variant = "default") {
  if (!el) return;
  el.textContent = text;
  el.classList.remove(
    "manual-flow__badge--active",
    "manual-flow__badge--success",
    "manual-flow__badge--warn",
  );
  if (variant === "active") el.classList.add("manual-flow__badge--active");
  if (variant === "success") el.classList.add("manual-flow__badge--success");
  if (variant === "warn") el.classList.add("manual-flow__badge--warn");
}

function computeDealPriceFromPercent(originalPrice, percent) {
  const orig = Number(originalPrice);
  const pct = Number(percent);
  if (!Number.isFinite(orig) || orig <= 0) return null;
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return null;
  return round2(orig * (1 - pct / 100));
}

function computeDealDiscountRange(it) {
  if (PromoState.computeDealDiscountRange) {
    return PromoState.computeDealDiscountRange(it, { state, toNum });
  }
  const original = toNum(
    it?.original_price ?? it?.originalPrice ?? it?.price ?? null,
  );
  const typeUp = String(it?.promotion_type ?? it?.type ?? "").toUpperCase();
  const minPrice = toNum(it?.min_discounted_price);
  let maxPrice = toNum(it?.max_discounted_price);
  const lightningPrice = toNum(it?.price);
  if (
    typeUp === "LIGHTNING" &&
    maxPrice == null &&
    lightningPrice != null &&
    lightningPrice > 0 &&
    lightningPrice < original &&
    (minPrice == null || lightningPrice >= minPrice)
  ) {
    maxPrice = lightningPrice;
  }
  const toPct = (price) =>
    original != null && original > 0 && price != null
      ? round2(((original - price) / original) * 100)
      : null;

  return {
    minPrice,
    maxPrice,
    minPct: toPct(maxPrice),
    maxPct: toPct(minPrice),
  };
}

function isDealPercentWithinRange(it, percent) {
  if (PromoState.isDealPercentWithinRange) {
    return PromoState.isDealPercentWithinRange(it, percent);
  }
  const pct = toNum(percent);
  if (pct == null) return false;
  const range = computeDealDiscountRange(it);
  const lo = range.minPct;
  const hi = range.maxPct;
  if (lo == null || hi == null) return false;
  return pct + 0.01 >= lo && pct - 0.01 <= hi;
}

function clampDealSliderPct(value, fallback = 0) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(99, n));
}

function normalizeDealSliderRange(minPct, maxPct) {
  let min = clampDealSliderPct(minPct, 0);
  let max = clampDealSliderPct(maxPct, 99);
  if (max < 1) max = 1;
  if (min > 98) min = 98;
  if (min >= max) {
    if (max < 99) {
      min = Math.max(0, max - 1);
    } else {
      min = 98;
      max = 99;
    }
  }
  return { minPct: min, maxPct: max };
}

function formatDealSliderPct(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? `${n}%` : "—";
}

function dealRangeDraftKey(mlb) {
  return `${state.selectedCard?.id || "promo"}:${String(mlb || "").toUpperCase()}`;
}

function resetDealRangeDrafts() {
  state.dealRangeDrafts = {};
  state.lightningStockDrafts = {};
}

function getDealRangeDraftForItem(mlb) {
  const draft = state.dealRangeDrafts?.[dealRangeDraftKey(mlb)];
  if (!draft) return null;
  const normalized = normalizeDealSliderRange(draft.minPct, draft.maxPct);
  const defPct = Math.round((normalized.minPct + normalized.maxPct) / 2);
  return { ...normalized, defPct };
}

function getDealRangeDraftPriceForItem(mlb, it) {
  const draft = getDealRangeDraftForItem(mlb);
  if (!draft) return null;
  if (!isDealPercentWithinRange(it, draft.defPct)) return null;
  const original = toNum(it?.original_price ?? it?.price ?? null);
  return computeDealPriceFromPercent(original, draft.defPct);
}

function getDealRangeVisualState(key, defaults) {
  const draft = state.dealRangeDrafts?.[key];
  const source = draft || defaults;
  const normalized = normalizeDealSliderRange(source.minPct, source.maxPct);
  const fallbackDef =
    defaults.defPct != null
      ? clampDealSliderPct(defaults.defPct, Math.round((normalized.minPct + normalized.maxPct) / 2))
      : Math.round((normalized.minPct + normalized.maxPct) / 2);
  return {
    ...normalized,
    defPct: draft
      ? Math.round((normalized.minPct + normalized.maxPct) / 2)
      : fallbackDef,
  };
}

function dealRangeStyleVars(minPct, maxPct) {
  const normalized = normalizeDealSliderRange(minPct, maxPct);
  return `--deal-range-left:${normalized.minPct}%;--deal-range-width:${Math.max(
    1,
    normalized.maxPct - normalized.minPct,
  )}%`;
}

function buildDealDiscountControl({ key, minPct, maxPct, defPct }) {
  const style = dealRangeStyleVars(minPct, maxPct);
  return `<div class="deal-discount-control" data-deal-range-key="${esc(key)}" style="${style}">
    <div class="deal-range-track" aria-hidden="true"><span></span></div>
    <div class="deal-range-scale"><span data-deal-scale-min>${formatDealSliderPct(minPct)}</span><span data-deal-scale-max>${formatDealSliderPct(maxPct)}</span></div>
    <label class="deal-slider-row">
      <span>mín</span>
      <input class="deal-range-slider" type="range" min="0" max="99" step="1" value="${esc(minPct)}" data-deal-range-role="min" data-deal-range-key="${esc(key)}">
      <strong data-deal-min-value>${formatDealSliderPct(minPct)}</strong>
    </label>
    <label class="deal-slider-row">
      <span>máx</span>
      <input class="deal-range-slider" type="range" min="0" max="99" step="1" value="${esc(maxPct)}" data-deal-range-role="max" data-deal-range-key="${esc(key)}">
      <strong data-deal-max-value>${formatDealSliderPct(maxPct)}</strong>
    </label>
    <span class="deal-defined-badge">% definida: <b data-deal-def-value>${formatDealSliderPct(defPct)}</b></span>
  </div>`;
}

function buildDealPriceControl({ key, original, minPct, maxPct, defPct }) {
  const definedPrice = computeDealPriceFromPercent(original, defPct);
  const minPrice = computeDealPriceFromPercent(original, minPct);
  const maxPrice = computeDealPriceFromPercent(original, maxPct);
  return `<div class="deal-price-control" data-deal-price-key="${esc(key)}">
    <strong class="deal-defined-price" data-deal-defined-price>${definedPrice != null ? fmtMoeda(definedPrice) : "—"}</strong>
    <div class="deal-price-range-bar" aria-hidden="true"><span></span></div>
    <div class="deal-price-range-values">
      <span class="deal-price-range-values__min" data-deal-price-min>${minPrice != null ? fmtMoeda(minPrice) : "—"}</span>
      <span class="deal-price-range-values__max" data-deal-price-max>${maxPrice != null ? fmtMoeda(maxPrice) : "—"}</span>
    </div>
  </div>`;
}

function buildDealFixedDiscountControl({ pct }) {
  const value = clampDealSliderPct(pct, 0);
  return `<div class="deal-discount-control deal-discount-control--fixed" style="--deal-current-position:${value}%">
    <div class="deal-current-track" aria-hidden="true"><span></span></div>
    <div class="deal-current-scale"><span>0%</span><strong>Atual ${formatDealSliderPct(value)}</strong><span>99%</span></div>
    <div class="deal-fixed-row"><span>Faixa permitida</span><strong>nao informada</strong></div>
    <div class="deal-fixed-row"><span>Situacao</span><strong>participando</strong></div>
    <span class="deal-defined-badge">Aplicado: <b>${formatDealSliderPct(value)}</b></span>
  </div>`;
}

function buildDealFixedPriceControl({ original, finalPrice }) {
  return `<div class="deal-price-control deal-price-control--fixed">
    <strong class="deal-defined-price">${finalPrice != null ? fmtMoeda(finalPrice) : "—"}</strong>
    <div class="deal-price-range-bar" aria-hidden="true"><span></span></div>
    <div class="deal-price-range-values">
      <span class="deal-price-range-values__min">Atual ${original != null ? fmtMoeda(original) : "—"}</span>
      <span class="deal-price-range-values__max">Aplicado</span>
    </div>
  </div>`;
}

function updateDealRangeRowFromSlider(slider) {
  const row = slider?.closest?.("[data-deal-row-key]");
  const key = row?.dataset?.dealRowKey || slider?.dataset?.dealRangeKey;
  if (!row || !key) return;
  const minInput = row.querySelector('.deal-range-slider[data-deal-range-role="min"]');
  const maxInput = row.querySelector('.deal-range-slider[data-deal-range-role="max"]');
  if (!minInput || !maxInput) return;

  let minPct = clampDealSliderPct(minInput.value, 0);
  let maxPct = clampDealSliderPct(maxInput.value, 99);
  if (slider.dataset.dealRangeRole === "min" && minPct >= maxPct) {
    minPct = Math.max(0, maxPct - 1);
  } else if (slider.dataset.dealRangeRole === "max" && maxPct <= minPct) {
    maxPct = Math.min(99, minPct + 1);
  }
  ({ minPct, maxPct } = normalizeDealSliderRange(minPct, maxPct));

  minInput.value = String(minPct);
  maxInput.value = String(maxPct);
  const defPct = Math.round((minPct + maxPct) / 2);
  state.dealRangeDrafts[key] = { minPct, maxPct, defPct };

  const style = dealRangeStyleVars(minPct, maxPct);
  row.querySelectorAll(`.deal-discount-control[data-deal-range-key="${key}"]`).forEach((control) => {
    control.style.cssText = style;
  });
  row.querySelectorAll("[data-deal-min-value]").forEach((el) => {
    el.textContent = formatDealSliderPct(minPct);
  });
  row.querySelectorAll("[data-deal-max-value]").forEach((el) => {
    el.textContent = formatDealSliderPct(maxPct);
  });
  row.querySelectorAll("[data-deal-scale-min]").forEach((el) => {
    el.textContent = formatDealSliderPct(minPct);
  });
  row.querySelectorAll("[data-deal-scale-max]").forEach((el) => {
    el.textContent = formatDealSliderPct(maxPct);
  });
  row.querySelectorAll("[data-deal-def-value]").forEach((el) => {
    el.textContent = formatDealSliderPct(defPct);
  });

  const original = toNum(row.dataset.dealOriginal);
  const definedPrice = computeDealPriceFromPercent(original, defPct);
  const minPrice = computeDealPriceFromPercent(original, minPct);
  const maxPrice = computeDealPriceFromPercent(original, maxPct);
  row.querySelectorAll("[data-deal-defined-price]").forEach((el) => {
    el.textContent = definedPrice != null ? fmtMoeda(definedPrice) : "—";
  });
  row.querySelectorAll("[data-deal-price-min]").forEach((el) => {
    el.textContent = minPrice != null ? fmtMoeda(minPrice) : "—";
  });
  row.querySelectorAll("[data-deal-price-max]").forEach((el) => {
    el.textContent = maxPrice != null ? fmtMoeda(maxPrice) : "—";
  });
}

function itemMatchesDiscountFilter(it, benefitsGlobal) {
  if (state.maxDesc == null) return true;
  const targetPct = Number(state.maxDesc);
  if (!Number.isFinite(targetPct) || targetPct <= 0) return true;

  if (isDealSelected() || isSellerCampaignSelected()) {
    return isDealPercentWithinRange(it, targetPct);
  }

  const descPct = computeDescPct(it, benefitsGlobal);
  return descPct != null && Number(descPct) <= targetPct;
}

function updateDiscountFilterUi() {
  const mode = getGuidedApplyMode();
  syncPromoBulkMeta({
    manualFlow: !!mode,
    manualPercent: getCurrentApplyPercent(),
    filterLimit: state.maxDesc != null ? Number(state.maxDesc) : null,
  });
  renderManualApplyWizard();
}

function isManualApplyFlowSelected() {
  return !!getGuidedApplyMode();
}

function selectedTableCount() {
  return document.querySelectorAll('#tbody input[type="checkbox"][data-mlb]:checked')
    .length;
}

function currentWizardStatusKey() {
  return filtroToStatusParam() || "all";
}

const LIST_MODE_MAX_MLBS = 80;
const MANUAL_WIZARD_LIST_MAX_MLBS = 5000;
const LIST_MODE_ITEM_SEARCH_CONCURRENCY = 6;
const LIST_MODE_COMPATIBLE_TYPES = new Set(["SELLER_CAMPAIGN", "DEAL"]);

function normalizeMlbInput(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return `MLB${raw}`;
  const match = raw.match(/MLB\s*-?\s*(\d+)/i);
  if (match) return `MLB${match[1]}`;
  return /^MLB\d+$/i.test(raw) ? raw : "";
}

function parseMlbList(raw) {
  const seen = new Set();
  const out = [];
  String(raw || "")
    .split(/[\s,;|]+/)
    .map(normalizeMlbInput)
    .filter(Boolean)
    .forEach((id) => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push(id);
    });
  return out;
}

function listModeMlbsKey(mlbs = null) {
  const list = Array.isArray(mlbs) ? mlbs : activeListModeMlbs();
  return list.length ? list.join("|") : "";
}

function isListOperationMode() {
  return state.operationMode === "list";
}

function hasActiveListModeCampaign() {
  return isListOperationMode() && !!state.listMode?.selectedCampaignId;
}

function shouldHideOperationalArea() {
  if (isListOperationMode()) return !hasActiveListModeCampaign();
  return !state.selectedCard;
}

function activeListModeMlbs() {
  if (!isListOperationMode()) return [];
  if (!state.listMode?.selectedCampaignId) return [];
  if (Array.isArray(state.listMode.activeMlbs) && state.listMode.activeMlbs.length) {
    return state.listMode.activeMlbs;
  }
  return Array.isArray(state.listMode.mlbs) ? state.listMode.mlbs : [];
}

function activeListModeMlbSet() {
  const list = activeListModeMlbs();
  return list.length ? new Set(list.map((id) => String(id).toUpperCase())) : null;
}

function isManualWizardListSupported() {
  const typeUp = String(state.selectedCard?.type || "").toUpperCase();
  return (
    typeUp === "DEAL" ||
    typeUp === "SELLER_CAMPAIGN" ||
    isSmartLikePromotionType(typeUp)
  );
}

function manualWizardListMlbs() {
  if (!isManualWizardListSupported()) return [];
  return parseMlbList(state.manualWizard?.listRaw || "");
}

function manualWizardListRawTokenCount() {
  return String(state.manualWizard?.listRaw || "")
    .split(/[\s,;|]+/)
    .filter(Boolean).length;
}

function manualWizardListEntries() {
  const seen = new Set();
  return String(state.manualWizard?.listRaw || "")
    .split(/[\s,;|]+/)
    .map((raw, index) => {
      const token = String(raw || "").trim();
      if (!token) return null;
      const mlb = normalizeMlbInput(token);
      const duplicate = !!mlb && seen.has(mlb);
      if (mlb && !duplicate) seen.add(mlb);
      return { index: index + 1, token, mlb, duplicate };
    })
    .filter(Boolean);
}

function manualWizardListKey(mlbs = null) {
  const list = Array.isArray(mlbs) ? mlbs : manualWizardListMlbs();
  return list.length ? list.join("|") : "";
}

function hasActiveManualWizardList() {
  return manualWizardListMlbs().length > 0;
}

function buildManualWizardListDiagnostics({ eligibleIds = [], percent = null } = {}) {
  const eligibleSet = new Set(
    (Array.isArray(eligibleIds) ? eligibleIds : [])
      .map((id) => String(id || "").trim().toUpperCase())
      .filter(Boolean),
  );
  return manualWizardListEntries().map((entry) => {
    const base = {
      ordem: entry.index,
      entrada: entry.token,
      mlb: entry.mlb || "",
      campanha_id: state.selectedCard?.id || "",
      campanha_nome: state.selectedCard?.name || "",
      campanha_tipo: state.selectedCard?.type || "",
      filtro_status: currentWizardStatusKey(),
      percentual: percent != null ? fmtPerc(percent, 2) : "",
      resultado: "",
      motivo: "",
      aplicavel: "nao",
    };
    if (!entry.mlb) {
      return {
        ...base,
        resultado: "invalido",
        motivo: "Entrada nao foi reconhecida como MLB valido.",
      };
    }
    if (entry.duplicate) {
      return {
        ...base,
        resultado: "duplicado",
        motivo: "MLB repetido na lista. A validacao considera apenas a primeira ocorrencia.",
      };
    }
    if (eligibleSet.has(entry.mlb)) {
      return {
        ...base,
        resultado: "elegivel",
        motivo: "Anuncio retornado como elegivel para esta campanha e filtro.",
        aplicavel: "sim",
      };
    }
    return {
      ...base,
      resultado: "nao_elegivel",
      motivo: "O Mercado Livre nao retornou este anuncio como elegivel para esta campanha e filtro.",
    };
  });
}

function normalizeManualWizardListDiagnostics(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({
      ordem: row?.ordem ?? index + 1,
      entrada: row?.entrada ?? row?.token ?? row?.mlb ?? row?.mlb_id ?? "",
      mlb: String(row?.mlb || row?.mlb_id || "").trim().toUpperCase(),
      campanha_id: row?.campanha_id ?? state.selectedCard?.id ?? "",
      campanha_nome: row?.campanha_nome ?? state.selectedCard?.name ?? "",
      campanha_tipo: row?.campanha_tipo ?? state.selectedCard?.type ?? "",
      filtro_status: row?.filtro_status ?? currentWizardStatusKey(),
      percentual: row?.percentual ?? "",
      resultado: row?.resultado ?? (row?.success ? "elegivel" : "nao_elegivel"),
      motivo: row?.motivo ?? row?.message ?? "",
      aplicavel: row?.aplicavel ?? (row?.success ? "sim" : "nao"),
    }));
}

function extractManualWizardListJobResult(payload) {
  const candidates = [
    payload?.result,
    payload?.job?.result,
    payload?.data?.result,
    payload?.data,
    payload?.returnvalue,
  ].filter(Boolean);
  return candidates.find((candidate) =>
    candidate?.kind === "promotion-list-validation" ||
    Array.isArray(candidate?.diagnostics) ||
    Array.isArray(candidate?.listDiagnostics) ||
    Array.isArray(candidate?.ids) ||
    Array.isArray(candidate?.selectionIds) ||
    candidate?.selection_token
  ) || null;
}

function parseManualWizardPercentValue(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace("%", "").replace(",", "."));
  return Number.isFinite(n) ? round2(n) : null;
}

function manualWizardListKeyFromDiagnostics(rows) {
  const entries = (Array.isArray(rows) ? rows : [])
    .filter((row) => Number(row?.ordem ?? 0) > 0 || row?.entrada || row?.mlb || row?.mlb_id)
    .sort((a, b) => Number(a?.ordem ?? 0) - Number(b?.ordem ?? 0))
    .map((row) => normalizeMlbInput(row?.entrada || row?.mlb || row?.mlb_id || ""))
    .filter(Boolean);
  return entries.length ? [...new Set(entries)].join("|") : "";
}

function manualWizardListResultMatchesCurrent(result, { pct, mlbs } = {}) {
  if (!result || !state.selectedCard) return false;
  const diagnostics = result?.diagnostics || result?.listDiagnostics || result?.results || [];
  const firstDiagnostic = (Array.isArray(diagnostics) ? diagnostics : []).find(
    (row) => row?.campanha_id || row?.campanha_tipo || row?.percentual != null,
  );
  const resultPromotionId =
    result?.promotion_id || result?.promotionId || firstDiagnostic?.campanha_id || "";
  const resultPromotionType =
    result?.promotion_type || result?.promotionType || firstDiagnostic?.campanha_tipo || "";
  if (resultPromotionId && String(resultPromotionId) !== String(state.selectedCard.id || "")) {
    return false;
  }
  if (
    resultPromotionType &&
    String(resultPromotionType).toUpperCase() !== String(state.selectedCard.type || "").toUpperCase()
  ) {
    return false;
  }

  const targetPct = parseManualWizardPercentValue(pct ?? getCurrentApplyPercent());
  const resultPct = parseManualWizardPercentValue(result?.percentual ?? firstDiagnostic?.percentual);
  if (targetPct != null && resultPct != null && targetPct !== resultPct) return false;

  const currentKey = manualWizardListKey(mlbs);
  const diagnosticKey = manualWizardListKeyFromDiagnostics(diagnostics);
  if (currentKey && diagnosticKey && currentKey !== diagnosticKey) return false;

  return true;
}

function isPromotionJobComplete(payload) {
  const statusText = String(
    payload?.lifecycle_status ||
      payload?.status ||
      payload?.state ||
      payload?.job_contract?.lifecycle_status ||
      "",
  ).toLowerCase();
  return (
    payload?.completed === true ||
    payload?.progress >= 100 ||
    statusText.includes("completed") ||
    statusText.includes("conclu") ||
    statusText.includes("falhou") ||
    statusText.includes("failed") ||
    statusText.includes("cancel")
  );
}

async function fetchPromotionJobDetail(jobId) {
  const response = await fetch(
    withPromoBase(`/api/promocoes/jobs/${encodeURIComponent(jobId)}`),
    {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || "Nao foi possivel consultar o job.");
  }
  return payload;
}

function adoptManualWizardListValidationResult(result, { pct, mlbs } = {}) {
  const rawIds = Array.isArray(result?.ids)
    ? result.ids
    : Array.isArray(result?.selectionIds)
      ? result.selectionIds
      : [];
  const ids = rawIds.length
    ? [...new Set(rawIds.map((id) => String(id || "").trim().toUpperCase()).filter(Boolean))]
    : [];
  const total = Number(
    (result?.eligible ??
      result?.success ??
      result?.counters?.success ??
      ids.length) || 0,
  );
  state.manualWizard = {
    ...state.manualWizard,
    percent: round2(pct),
    quantity: null,
    stockMin: null,
    stockMax: null,
    verified: true,
    loading: false,
    eligibleTotal: Number.isFinite(total) ? total : ids.length,
    scope: state.manualWizard?.scope || "all",
    promotionId: state.selectedCard?.id || null,
    promotionType: state.selectedCard?.type || null,
    status: currentWizardStatusKey(),
    mlb: state.mlbFilter || null,
    mlbsKey: manualWizardListKey(mlbs),
    listRaw: state.manualWizard?.listRaw || "",
    listOpen: true,
    listDiagnostics: normalizeManualWizardListDiagnostics(
      result?.diagnostics || result?.listDiagnostics || result?.results || [],
    ),
    selectionToken: result?.selection_token || result?.selectionToken || null,
    selectionIds: ids,
    validationJobId: result?.id || state.manualWizard?.validationJobId || null,
  };
  if (ids.length) {
    const eligibleIds = new Set(ids);
    state.items = (Array.isArray(state.items) ? state.items : []).filter((item) =>
      eligibleIds.has(String(item?.id || item?.item_id || "").trim().toUpperCase()),
    );
  }
  state.paging.total = state.manualWizard.eligibleTotal;
  syncPromoBulkMeta({
    filteredTotal: state.manualWizard.eligibleTotal,
    manualPercent: state.manualWizard.percent,
    manualFlow: true,
    filterLimit: state.manualWizard.percent,
  });
}

async function completeManualWizardListValidationJob(
  jobId,
  result,
  { pct, mlbs, localJobId } = {},
) {
  if (!manualWizardListResultMatchesCurrent(result, { pct, mlbs })) return false;
  adoptManualWizardListValidationResult(result, { pct, mlbs });
  await carregarItensPagina(1, true).catch(() => {});
  renderTabela(state.items);
  renderPaginacao();
  renderManualApplyWizard();
  window.JobsPanel?.updateLocalJob?.(localJobId || jobId, {
    state: `concluido: ${state.manualWizard.eligibleTotal || 0} elegiveis`,
    progress: 100,
  });
  return true;
}

function watchManualWizardListValidationJob(jobId, { pct, mlbs, localJobId } = {}) {
  const startedAt = Date.now();
  const maxMs = 30 * 60 * 1000;
  const poll = async () => {
    try {
      const payload = await fetchPromotionJobDetail(jobId);
      JobsWatcher.poll?.();
      const result = extractManualWizardListJobResult(payload);
      if (isPromotionJobComplete(payload) && result) {
        await completeManualWizardListValidationJob(jobId, result, {
          pct,
          mlbs,
          localJobId: localJobId || jobId,
        });
        return;
      }
      if (isPromotionJobComplete(payload) && !result) {
        throw new Error("Job finalizado sem resultado de validacao da lista.");
      }
      if (Date.now() - startedAt < maxMs) {
        setTimeout(poll, 2500);
        return;
      }
      throw new Error("Tempo de acompanhamento da validacao expirou.");
    } catch (err) {
      console.warn("[manualApplyWizard] job de lista falhou:", err);
      if (state.manualWizard?.validationJobId === jobId) {
        state.manualWizard.loading = false;
        state.manualWizard.validationJobId = null;
        renderManualApplyWizard();
      }
      window.JobsPanel?.updateLocalJob?.(localJobId || jobId, {
        state: "falhou",
        progress: 100,
      });
      notifyPromocoes(err?.message || "Falha ao validar a lista por job.");
    }
  };
  setTimeout(poll, 1800);
}

function syncManualWizardListValidationFromJobs(jobs) {
  if (!Array.isArray(jobs) || !hasActiveManualWizardList()) return;
  if (isManualWizardVerifiedForCurrent()) return;
  const pct = getCurrentApplyPercent();
  const mlbs = manualWizardListMlbs();
  const currentJobId = String(state.manualWizard?.validationJobId || "");
  const match = jobs.find((job) => {
    const result = extractManualWizardListJobResult(job);
    if (!result || !isPromotionJobComplete(job)) return false;
    const jobId = String(job?.id || job?.backend_job_id || job?.backendJobId || "");
    if (currentJobId && jobId && jobId !== currentJobId) return false;
    return manualWizardListResultMatchesCurrent(result, { pct, mlbs });
  });
  if (!match) return;
  const jobId = String(match?.id || match?.backend_job_id || match?.backendJobId || "");
  const result = extractManualWizardListJobResult(match);
  completeManualWizardListValidationJob(jobId, result, { pct, mlbs, localJobId: jobId }).catch(
    (err) => console.warn("[manualApplyWizard] falha ao sincronizar job da lista:", err),
  );
}

function installManualWizardListJobsPanelSync() {
  if (!window.JobsPanel?.mergeApiJobs || window.JobsPanel.__manualWizardListSyncInstalled) return;
  const originalMerge = window.JobsPanel.mergeApiJobs.bind(window.JobsPanel);
  window.JobsPanel.mergeApiJobs = function mergeApiJobsWithManualWizardSync(list, ...args) {
    const ret = originalMerge(list, ...args);
    syncManualWizardListValidationFromJobs(list);
    return ret;
  };
  window.JobsPanel.__manualWizardListSyncInstalled = true;
}

installManualWizardListJobsPanelSync();

async function startManualWizardListValidationJob({ pct, mlbs }) {
  const campaignName = state.selectedCard?.name || state.selectedCard?.id || "campanha";
  const account = await ensurePromoPanelAccount({ force: true });
  let localJobId = null;
  try {
    localJobId =
      window.JobsPanel?.addLocalJob?.({
        title: `Validando lista • ${campaignName}`,
        accountKey: account.key || null,
        accountLabel: account.label || null,
        state: `queued 0/${mlbs.length}`,
        progress: 0,
      }) || null;
    window.JobsPanel?.show?.();
  } catch {}

  const response = await fetch(withPromoBase("/api/promocoes/selection/list-validation-job"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      promotion_id: state.selectedCard.id,
      promotion_type: state.selectedCard.type,
      promotion_name: campaignName,
      status: filtroToStatusParam() || null,
      mlbs,
      raw_list: state.manualWizard?.listRaw || mlbs,
      percent_max: pct,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false || !data?.job_id) {
    throw new Error(data?.error || "Nao foi possivel iniciar o job de validacao da lista.");
  }
  const realId = String(data.job_id);
  if (localJobId) {
    window.JobsPanel?.replaceId?.(localJobId, realId);
  }
  JobTitleCache.set(realId, `Validando lista • ${campaignName}`);
  window.JobsPanel?.updateLocalJob?.(realId, {
    label: `Validando lista • ${campaignName}`,
    accountKey: data?.account?.key || account.key || null,
    accountLabel: data?.account?.label || account.label || null,
    state: `active 0/${data?.total || mlbs.length}`,
    progress: 0,
  });
  JobsWatcher.start?.();
  state.manualWizard.validationJobId = realId;
  state.manualWizard.loading = true;
  state.manualWizard.verified = false;
  renderManualApplyWizard();
  watchManualWizardListValidationJob(realId, { pct, mlbs, localJobId: realId });
  return true;
}

function activeScopedMlbsForPrepare() {
  const manualList = manualWizardListMlbs();
  if (manualList.length) return manualList;
  return activeListModeMlbs();
}

function activeScopedMlbSet() {
  const list = activeScopedMlbsForPrepare();
  return list.length ? new Set(list.map((id) => String(id).toUpperCase())) : null;
}

function applyOperationModeUi() {
  const isList = isListOperationMode();
  document.querySelectorAll("[data-promo-mode]").forEach((btn) => {
    const active = String(btn.dataset.promoMode || "") === state.operationMode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
  document.getElementById("campaignModeDiscovery")?.classList.toggle("hidden", isList);
  document.getElementById("campaignModeTabs")?.classList.toggle("hidden", isList);
  document.getElementById("campaignModeCampaigns")?.classList.toggle("hidden", isList);
  document.getElementById("listModePanel")?.classList.toggle("hidden", !isList);
  document.getElementById("campaignWorkspaceHeader")?.classList.toggle("hidden", isList);
  document.getElementById("campaignWorkspaceFilters")?.classList.toggle("hidden", isList);

  const hideOperational = shouldHideOperationalArea();
  const showCampaignEmptyState = !isList && !state.selectedCard;
  const emptyState = document.getElementById("campaignEmptyState");
  emptyState?.classList.toggle("hidden", !showCampaignEmptyState);
  emptyState?.setAttribute("aria-hidden", showCampaignEmptyState ? "false" : "true");

  ["campaignWorkspace", "itemsTableCard", "itemsProgressCard"].forEach((id) => {
    const node = document.getElementById(id);
    node?.classList.toggle("hidden", hideOperational);
    node?.setAttribute("aria-hidden", hideOperational ? "true" : "false");
  });
}

function resetCampaignOperationalState({ clearCard = false, keepMlbFilter = true } = {}) {
  if (clearCard) state.selectedCard = null;

  state.items = [];
  state.promotionBenefits = null;
  state.filtroParticipacao = "all";
  state.maxDesc = null;
  state.sellerManualPercent = null;
  state.dealManualPercent = null;
  state.dealRangeDrafts = {};
  state.lightningStockDrafts = {};
  if (!keepMlbFilter) state.mlbFilter = "";

  state.paging = {
    total: 0,
    limit: PAGE_SIZE,
    tokensByPage: { 1: null },
    currentPage: 1,
    lastPageKnown: 1,
  };

  document.querySelectorAll('input[name="filtro"]').forEach((input) => {
    input.checked = input.value === "all";
  });
  const checkAll = document.getElementById("checkAll");
  if (checkAll) checkAll.checked = false;

  invalidateManualApplyWizard({ keepPercent: false });
  renderTabela([]);
  renderPaginacao();
  updateSelectedCampaignName();
  updateSellerCampaignControls();
  updateDealControls();
  updateDiscountFilterUi();
  atualizarFaixaSelecaoCampanha();
  applyOperationModeUi();
}

function clearCampaignSelection({ keepMlbFilter = true } = {}) {
  resetCampaignOperationalState({ clearCard: true, keepMlbFilter });
  destacarCardSelecionado();
  setLoading(false, "Selecione uma campanha para carregar os itens.");
}

function resetListModeCampaignSelection() {
  state.listMode.selectedCampaignId = null;
  state.listMode.applyingCampaignId = null;
  state.listMode.selectedToken = null;
  state.listMode.activeMlbs = [];
  state.selectedCard = null;
  state.items = [];
  state.paging.currentPage = 1;
  state.paging.total = 0;
  state.paging.tokensByPage = { 1: null };
  window.PromoBulk?.reset?.();
  invalidateManualApplyWizard({ keepPercent: true });
  updateSelectedCampaignName();
  renderTabela([]);
  renderPaginacao();
  atualizarFaixaSelecaoCampanha();
  applyOperationModeUi();
}

function setListModeStatus(text, tone = "") {
  const el = document.getElementById("listModeStatus");
  if (!el) return;
  el.textContent = text || "";
  if (tone) el.dataset.tone = tone;
  else el.removeAttribute("data-tone");
}

function getVisibleListModeResults() {
  const results = Array.isArray(state.listMode.results) ? state.listMode.results : [];
  return results.filter((row) => Number(row?.eligible || 0) > 0);
}

function normalizeListModeResultIds(ids) {
  const allowed = new Set(
    (Array.isArray(state.listMode.mlbs) ? state.listMode.mlbs : []).map((id) =>
      String(id || "").trim().toUpperCase(),
    ),
  );
  const seen = new Set();
  return (Array.isArray(ids) ? ids : [])
    .map(normalizeMlbInput)
    .filter(Boolean)
    .filter((id) => {
      const key = String(id).toUpperCase();
      if (allowed.size && !allowed.has(key)) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getListModeResultCandidateMlbs(row) {
  return normalizeListModeResultIds(
    Array.isArray(row?.eligibleIds) && row.eligibleIds.length
      ? row.eligibleIds
      : Array.isArray(row?.matchedMlbs) && row.matchedMlbs.length
      ? row.matchedMlbs
      : row?.card?.matchedMlbs,
  );
}

function buildListModeDistributionPlan() {
  const assigned = new Set();
  const rows = getVisibleListModeResults().slice().sort((a, b) => {
    if (Number(b.eligible || 0) !== Number(a.eligible || 0)) {
      return Number(b.eligible || 0) - Number(a.eligible || 0);
    }
    if (String(a.type || "") !== String(b.type || "")) {
      return String(a.type || "").toUpperCase() === "SELLER_CAMPAIGN" ? -1 : 1;
    }
    return String(a.name || "").localeCompare(String(b.name || ""), "pt-BR");
  });

  const plan = [];
  for (const row of rows) {
    const mlbs = getListModeResultCandidateMlbs(row).filter((mlb) => {
      const key = String(mlb).toUpperCase();
      return !assigned.has(key);
    });
    if (!mlbs.length) continue;
    mlbs.forEach((mlb) => assigned.add(String(mlb).toUpperCase()));
    plan.push({ row, mlbs });
  }

  const rejected = normalizeListModeResultIds(state.listMode.mlbs).filter(
    (mlb) => !assigned.has(String(mlb).toUpperCase()),
  );

  return { plan, rejected, assignedTotal: assigned.size };
}

function renderListModeResults() {
  const host = document.getElementById("listModeResults");
  if (!host) return;
  const results = Array.isArray(state.listMode.results) ? state.listMode.results : [];
  const visibleResults = getVisibleListModeResults();
  host.classList.toggle("hidden", !isListOperationMode() || !results.length);
  if (!results.length) {
    host.innerHTML = "";
    return;
  }
  if (!visibleResults.length) {
    host.innerHTML =
      '<div class="promo-list-result__empty">Nenhuma campanha compativel com a lista e o desconto informado. Reduza a porcentagem ou tente outro tipo de campanha.</div>';
    return;
  }

  const informedTotal = state.listMode.mlbs.length || 0;
  const distribution = buildListModeDistributionPlan();
  const isApplyingListCampaign = !!state.listMode.applyingCampaignId;
  const canDistribute = visibleResults.length > 1 && distribution.assignedTotal > 0;
  const toolbar = `
    <div class="promo-list-distribution">
      <div>
        <strong>Campanha recomendada ou distribuicao inteligente</strong>
        <span>${canDistribute
          ? `Podemos distribuir ate ${distribution.assignedTotal.toLocaleString("pt-BR")} MLB(s) em ${distribution.plan.length} campanha(s), sem repetir o mesmo MLB.`
          : "Escolha uma campanha recomendada para iniciar a aplicacao nos MLBs elegiveis."}</span>
      </div>
      <button class="btn promo-list-distribution__btn" type="button" data-list-distribute-campaigns ${canDistribute && !isApplyingListCampaign ? "" : "disabled"}>
        Distribuir entre campanhas compativeis
      </button>
    </div>
  `;
  const cards = visibleResults
    .map((row, index) => {
      const coverage = informedTotal > 0 ? Math.round((row.eligible / informedTotal) * 100) : 0;
      const isApplying = String(state.listMode.applyingCampaignId || "") === String(row.id || "");
      const disabled = row.eligible <= 0 || isApplyingListCampaign ? "disabled" : "";
      const actionLabel = isApplying ? "Iniciando job..." : "Aplicar nesta campanha";
      const loadingClass = isApplying ? " is-loading" : "";
      return `
        <article class="promo-list-result${index === 0 && row.eligible > 0 ? " is-best" : ""}">
          <div class="promo-list-result__top">
            <div>
              <div class="promo-list-result__name">${esc(row.name || row.id || "Campanha")}</div>
              <div class="promo-list-result__type">${esc(row.type || "")} • ${esc(row.status || "status nao informado")}</div>
            </div>
            <span class="promo-list-result__score">${coverage}%</span>
          </div>
          <div class="promo-list-result__metrics">
            <div class="promo-list-result__metric">
              <span>Elegiveis</span>
              <strong>${Number(row.eligible || 0).toLocaleString("pt-BR")}</strong>
            </div>
            <div class="promo-list-result__metric">
              <span>Fora</span>
              <strong>${Number(row.rejected || 0).toLocaleString("pt-BR")}</strong>
            </div>
            <div class="promo-list-result__metric">
              <span>Lista</span>
              <strong>${Number(informedTotal || 0).toLocaleString("pt-BR")}</strong>
            </div>
          </div>
          <button class="btn promo-list-result__action${loadingClass}" type="button" data-list-use-campaign="${esc(row.id)}" ${disabled}>
            ${actionLabel}
          </button>
        </article>
      `;
    })
    .join("");
  host.innerHTML = `${toolbar}${cards}`;
}

function setOperationMode(mode) {
  const next = mode === "list" ? "list" : "campaign";
  if (state.operationMode === next) {
    applyOperationModeUi();
    return;
  }

  state.operationMode = next;
  state.listMode.selectedCampaignId = null;
  state.listMode.applyingCampaignId = null;
  state.listMode.selectedToken = null;
  state.listMode.activeMlbs = [];
  state.selectedCard = null;
  state.items = [];
  state.mlbFilter = "";
  state.cardsFilteredIds = null;
  invalidateManualApplyWizard({ keepPercent: false });
  updateSelectedCampaignName();
  renderTabela([]);
  renderPaginacao();
  renderListModeResults();
  applyOperationModeUi();
  atualizarFaixaSelecaoCampanha();
}

function getListModeCandidateCards() {
  const desired = String(document.getElementById("listModeTypeFilter")?.value || state.listMode.typeFilter || "SELLER_CAMPAIGN").toUpperCase();
  state.listMode.typeFilter = desired;
  const base = Array.isArray(state.cards) ? state.cards : [];
  return base.filter((card) => {
    const type = String(card?.type || "").toUpperCase();
    if (!LIST_MODE_COMPATIBLE_TYPES.has(type)) return false;
    if (desired === "ALL") return true;
    return type === desired;
  });
}

function isListModeTypeAllowed(type) {
  const desired = String(document.getElementById("listModeTypeFilter")?.value || state.listMode.typeFilter || "SELLER_CAMPAIGN").toUpperCase();
  const typeUp = String(type || "").toUpperCase();
  if (!LIST_MODE_COMPATIBLE_TYPES.has(typeUp)) return false;
  if (desired === "ALL") return true;
  return typeUp === desired;
}

function normalizeItemPromotionForListMode(entry, mlb) {
  if (!entry || typeof entry !== "object") return null;
  const id = String(entry.id || entry.promotion_id || entry.code || "").trim();
  const type = String(entry.type || entry.promotion_type || "").toUpperCase();
  if (!id || !isListModeTypeAllowed(type)) return null;
  return {
    id,
    type,
    name: entry.name || entry.title || entry.promotion_name || id,
    status: entry.status || entry.item_status || "",
    start_date: entry.start_date || entry.valid_from || null,
    finish_date: entry.finish_date || entry.valid_to || null,
    benefits: entry.benefits || null,
    sourceMlb: mlb,
  };
}

async function fetchPromotionsForListModeMlb(mlb) {
  for (const path of itemPromosPaths(mlb)) {
    try {
      const response = await fetch(path, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) continue;
      const payload = await response.json().catch(() => []);
      return extractList(payload)
        .map((entry) => normalizeItemPromotionForListMode(entry, mlb))
        .filter(Boolean);
    } catch (err) {
      console.warn(`[listMode] falha ao consultar promocoes do item ${mlb}:`, err);
    }
  }
  return [];
}

async function buildListModeCandidatesFromItems(mlbs) {
  const grouped = new Map();
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < mlbs.length) {
      const index = cursor;
      cursor += 1;
      const mlb = mlbs[index];
      setListModeStatus(`Consultando campanhas por MLB ${done + 1}/${mlbs.length}: ${mlb}...`, "loading");
      const promotions = await fetchPromotionsForListModeMlb(mlb);
      for (const promo of promotions) {
        const key = `${promo.type}:${promo.id}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.sourceMlbs.add(mlb);
          existing.itemStatuses.set(mlb, promo.status || "");
          if (!existing.name && promo.name) existing.name = promo.name;
          continue;
        }
        grouped.set(key, {
          ...promo,
          sourceMlbs: new Set([mlb]),
          itemStatuses: new Map([[mlb, promo.status || ""]]),
        });
      }
      done += 1;
    }
  }

  const workers = Array.from(
    { length: Math.min(LIST_MODE_ITEM_SEARCH_CONCURRENCY, mlbs.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return [...grouped.values()].map((entry) => ({
    ...entry,
    matchedMlbs: [...entry.sourceMlbs],
    sourceMlbs: undefined,
    itemStatuses: Object.fromEntries(entry.itemStatuses.entries()),
  }));
}

async function findCompatibleCampaignsForList() {
  const raw = document.getElementById("listModeMlbsInput")?.value || "";
  const mlbs = parseMlbList(raw);
  const percentRaw = document.getElementById("listModePercentInput")?.value?.trim();
  const pct = percentRaw === "" || percentRaw == null ? null : Number(String(percentRaw).replace(",", "."));

  if (!mlbs.length) {
    setListModeStatus("Cole ao menos 1 MLB valido para buscar campanhas compativeis.", "warn");
    return;
  }
  if (mlbs.length > LIST_MODE_MAX_MLBS) {
    setListModeStatus(`A consulta aceita ate ${LIST_MODE_MAX_MLBS} MLBs por vez. Voce informou ${mlbs.length}.`, "warn");
    return;
  }
  if (!isValidManualPromoPercent(pct)) {
    setListModeStatus(manualPromoPercentMessage("Informe um desconto valido"), "warn");
    document.getElementById("listModePercentInput")?.focus();
    return;
  }

  state.listMode.mlbs = mlbs;
  state.listMode.activeMlbs = [];
  state.listMode.percent = round2(pct);
  state.listMode.selectedCampaignId = null;
  state.listMode.applyingCampaignId = null;
  state.listMode.selectedToken = null;
  state.listMode.loading = true;
  state.listMode.results = [];
  resetListModeCampaignSelection();
  renderListModeResults();
  setListModeStatus(`Validando ${mlbs.length} MLB(s) nas campanhas compativeis...`, "loading");
  const btn = document.getElementById("btnListModeSearch");
  if (btn) {
    btn.disabled = true;
    btn.classList.add("is-loading");
  }

  try {
    const candidates = await buildListModeCandidatesFromItems(mlbs);
    if (!candidates.length) {
      setListModeStatus("Nenhuma campanha Deal/Seller foi encontrada para estes MLBs.", "warn");
      return;
    }

    const results = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const card = candidates[i];
      const candidateMlbs = Array.isArray(card.matchedMlbs) && card.matchedMlbs.length
        ? card.matchedMlbs
        : mlbs;
      setListModeStatus(`Validando campanha ${i + 1}/${candidates.length}: ${card.name || card.id} (${candidateMlbs.length} MLBs apontados pelo ML)...`, "loading");
      const body = {
        promotion_id: card.id,
        promotion_type: card.type,
        status: null,
        mlbs: candidateMlbs,
        percent_max: state.listMode.percent,
      };
      try {
        const prepResult = await window.PromoHttp?.postSelectionPrepare?.(body);
        const data = prepResult?.data || {};
        const eligible = prepResult?.ok && typeof data.total === "number" ? Number(data.total || 0) : 0;
        results.push({
          id: String(card.id || ""),
          name: card.name || card.id,
          type: String(card.type || "").toUpperCase(),
          status: card.status || "",
          eligible: Math.min(eligible, mlbs.length),
          rejected: Math.max(0, mlbs.length - Math.min(eligible, mlbs.length)),
          discovered: candidateMlbs.length,
          matchedMlbs: candidateMlbs,
          eligibleIds: Array.isArray(data.ids) ? data.ids : [],
          itemStatuses: card.itemStatuses || {},
          token: data.token || null,
          ok: !!prepResult?.ok,
          card,
        });
      } catch (err) {
        results.push({
          id: String(card.id || ""),
          name: card.name || card.id,
          type: String(card.type || "").toUpperCase(),
          status: card.status || "",
          eligible: 0,
          rejected: mlbs.length,
          discovered: candidateMlbs.length,
          matchedMlbs: candidateMlbs,
          eligibleIds: [],
          itemStatuses: card.itemStatuses || {},
          ok: false,
          error: err?.message || String(err),
          card,
        });
      }
    }

    results.sort((a, b) => {
      if (b.eligible !== a.eligible) return b.eligible - a.eligible;
      if (a.type !== b.type) return a.type === "SELLER_CAMPAIGN" ? -1 : 1;
      return String(a.name || "").localeCompare(String(b.name || ""), "pt-BR");
    });
    state.listMode.results = results;
    renderListModeResults();
    const best = results[0];
    if (best?.eligible > 0) {
      setListModeStatus(`Encontramos ${results.filter((r) => r.eligible > 0).length} campanha(s) com pelo menos 1 MLB elegivel. Escolha uma para continuar no wizard.`, "success");
    } else {
      setListModeStatus("Nenhuma campanha aceitou a lista com esse desconto. Tente reduzir a % ou selecionar outro tipo de campanha.", "warn");
    }
  } finally {
    state.listMode.loading = false;
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
  }
}

async function useListModeCampaign(campaignId) {
  const result = state.listMode.results.find((row) => String(row.id) === String(campaignId));
  const card =
    state.cards.find((row) => String(row.id) === String(campaignId)) ||
    result?.card ||
    null;
  if (!result || !card || result.eligible <= 0) return;
  if (state.listMode.applyingCampaignId) return;
  if (!state.cards.some((row) => String(row.id) === String(card.id))) {
    state.cards.push(card);
  }

  state.listMode.applyingCampaignId = String(campaignId);
  renderListModeResults();
  setListModeStatus(`Iniciando job para ${result.name || result.id}...`, "loading");

  try {
    const activeMlbs = normalizeListModeResultIds(
      Array.isArray(result.eligibleIds) && result.eligibleIds.length
        ? result.eligibleIds
        : result.matchedMlbs,
    ).slice(0, Number(result.eligible || 0) || undefined);

    state.listMode.selectedCampaignId = String(campaignId);
    state.listMode.selectedToken = result.token || null;
    state.listMode.activeMlbs = activeMlbs;
    state.activeTypeTab = normalizeCardTypeForTabs(card.type) || state.activeTypeTab;
    syncManualWizardPercent(state.listMode.percent);
    state.selectedCard = {
      id: card.id,
      type: (card.type || "").toUpperCase(),
      name: card.name || card.id,
      benefits: card.benefits || null,
    };
    invalidateManualApplyWizard({ keepPercent: true });
    state.promotionBenefits = null;
    state.paging = {
      total: Number(result.eligible || activeMlbs.length || 0),
      limit: PAGE_SIZE,
      tokensByPage: { 1: null },
      currentPage: 1,
      lastPageKnown: 1,
    };
    destacarCardSelecionado();
    hideLeadingRebateColumnIfPresent();
    applyRebateHeaderTooltip();
    updateSelectedCampaignName();
    updateSellerCampaignControls();
    updateDealControls();
    updateDiscountFilterUi();
    syncPromoBulkContext();
    state.items = activeMlbs.slice(0, PAGE_SIZE).map((id) => ({
      id,
      item_id: id,
      status: result.itemStatuses?.[id] || result.status || "candidate",
    }));
    renderTabela(state.items);
    renderPaginacao();
    syncManualWizardPercent(state.listMode.percent);

    state.manualWizard = {
      percent: state.listMode.percent,
      quantity: null,
      stockMin: null,
      stockMax: null,
      verified: true,
      loading: false,
      eligibleTotal: Number(result.eligible || 0),
      scope: "all",
      promotionId: state.selectedCard.id,
      promotionType: state.selectedCard.type,
      status: currentWizardStatusKey(),
      mlb: null,
      mlbsKey: listModeMlbsKey(activeMlbs),
    };
    applyOperationModeUi();
    state.paging.total = Number(result.eligible || 0);
    syncPromoBulkMeta({
      filteredTotal: state.manualWizard.eligibleTotal,
      manualPercent: state.manualWizard.percent,
      manualFlow: true,
      filterLimit: state.manualWizard.percent,
    });
    renderManualApplyWizard();
    atualizarFaixaSelecaoCampanha();
    window.JobsPanel?.show?.();
    const applied = await aplicarTodosFiltrados();
    if (applied === false) {
      setListModeStatus(`Nao foi possivel iniciar o job para ${result.name || result.id}.`, "warn");
      return;
    }
    setListModeStatus(`Job iniciado para ${result.name || result.id} com ${Number(result.eligible || 0).toLocaleString("pt-BR")} MLB(s) elegiveis.`, "success");
  } catch (err) {
    setListModeStatus(err?.message || "Falha ao iniciar o job da campanha selecionada.", "warn");
    throw err;
  } finally {
    state.listMode.applyingCampaignId = null;
    renderListModeResults();
  }
}

async function distributeListModeAcrossCampaigns() {
  if (!isListOperationMode()) return;
  if (state.listMode.applyingCampaignId) {
    setListModeStatus("Aguarde o job atual ser preparado antes de iniciar outra aplicacao.", "warn");
    return;
  }
  const percent = Number(state.listMode.percent || 0);
  if (!isValidManualPromoPercent(percent)) {
    setListModeStatus("Informe e valide um desconto antes de distribuir.", "warn");
    document.getElementById("listModePercentInput")?.focus();
    return;
  }

  const { plan, rejected, assignedTotal } = buildListModeDistributionPlan();
  if (!plan.length || assignedTotal <= 0) {
    setListModeStatus("Nao ha campanhas compativeis suficientes para distribuir.", "warn");
    return;
  }

  const summary = plan
    .map(({ row, mlbs }) => `- ${row.name || row.id}: ate ${mlbs.length} MLB(s)`)
    .join("\n");
  const rejectedText = rejected.length
    ? `\n\n${rejected.length} MLB(s) ficarao fora por nao terem campanha compativel.`
    : "";
  const ok = window.confirm(
    `Distribuir ${assignedTotal} MLB(s) entre ${plan.length} campanha(s)?\n\n${summary}${rejectedText}\n\nCada MLB sera enviado para no maximo uma campanha. O Mercado Livre ainda valida a elegibilidade antes de aplicar.`,
  );
  if (!ok) return;

  const btn = document.querySelector("[data-list-distribute-campaigns]");
  if (btn) {
    btn.disabled = true;
    btn.classList.add("is-loading");
  }

  const account = await ensurePromoPanelAccount({ force: true }).catch(() => ({
    key: null,
    label: null,
  }));
  const started = [];
  const skipped = [];
  const failed = [];

  try {
    window.JobsPanel?.show?.();
    for (let i = 0; i < plan.length; i += 1) {
      const { row, mlbs } = plan[i];
      const type = String(row.type || "").toUpperCase();
      const campaignName = row.name || row.id || "Campanha";
      setListModeStatus(`Preparando distribuicao ${i + 1}/${plan.length}: ${campaignName}...`, "loading");

      const prepResult = await window.PromoHttp?.postSelectionPrepare?.({
        promotion_id: row.id,
        promotion_type: type,
        status: null,
        mlbs,
        percent_max: percent,
      });
      const expectedTotal =
        prepResult?.ok && Number.isFinite(Number(prepResult?.data?.total))
          ? Number(prepResult.data.total)
          : 0;
      const selectionToken =
        prepResult?.ok && prepResult?.data?.token
          ? String(prepResult.data.token)
          : null;
      const selectionIds =
        prepResult?.ok && Array.isArray(prepResult?.data?.ids)
          ? prepResult.data.ids
              .map((id) => String(id || "").trim().toUpperCase())
              .filter(Boolean)
          : null;

      if (expectedTotal <= 0) {
        skipped.push({ row, reason: "sem elegiveis apos validacao" });
        continue;
      }

      const localJobId =
        window.JobsPanel?.addLocalJob?.({
          title: `Distribuindo ${type} • ${campaignName}`,
          accountKey: account.key || null,
          accountLabel: account.label || null,
          state: `queued 0/${expectedTotal}`,
          progress: 0,
        }) || null;

      const options = {
        dryRun: false,
        expected_total: expectedTotal,
      };
      if (type === "SELLER_CAMPAIGN") options.seller_manual_percent = percent;
      if (type === "DEAL" || type === "DOD" || type === "LIGHTNING") {
        options.deal_manual_percent = percent;
      }

      if (
        !selectionToken &&
        (!Array.isArray(selectionIds) || selectionIds.length === 0)
      ) {
        if (localJobId) {
          window.JobsPanel?.updateLocalJob?.(localJobId, {
            state: "selecao segura indisponivel",
            progress: 0,
            errors: 1,
            completed: true,
          });
        }
        failed.push({
          row,
          error:
            "A selecao validada nao ficou disponivel no servidor. Nenhum anuncio foi alterado.",
        });
        continue;
      }

      const response = selectionToken
        ? await fetch(withPromoBase("/api/promocoes/jobs/apply-mass"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({
              token: selectionToken,
              action: "apply",
              promotion_name: campaignName,
              values: options,
            }),
          })
        : await fetch(withPromoBase("/api/promocoes/jobs/apply-list"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({
              promotion_id: row.id,
              promotion_type: type,
              promotion_name: campaignName,
              status: null,
              percent_max: percent,
              selection_ids: selectionIds,
              options,
            }),
          });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !(data?.success === true || data?.job_id)) {
        if (localJobId) {
          window.JobsPanel?.updateLocalJob?.(localJobId, {
            state: data?.error || `erro HTTP ${response.status}`,
            progress: 0,
            errors: 1,
            completed: true,
          });
        }
        failed.push({ row, error: data?.error || `HTTP ${response.status}` });
        continue;
      }

      const realId = data?.job_id ? String(data.job_id) : null;
      if (realId) {
        JobTitleCache.set(realId, `Distribuindo ${type} • ${campaignName}`);
        if (localJobId) window.JobsPanel?.replaceId?.(localJobId, realId);
        window.JobsPanel?.updateLocalJob?.(realId, {
          label: `Distribuindo ${type} • ${campaignName}`,
          accountKey: data?.account?.key || account.key || null,
          accountLabel: data?.account?.label || account.label || null,
          state: `active 0/${expectedTotal}`,
          progress: 0,
        });
      }
      started.push({ row, total: expectedTotal, jobId: realId });
    }

    JobsWatcher.start?.();
    const tone = failed.length ? "warn" : "success";
    setListModeStatus(
      `Distribuicao iniciada: ${started.length} job(s), ${skipped.length} campanha(s) sem elegiveis, ${failed.length} erro(s).`,
      tone,
    );
    notifyPromocoes(
      `Distribuicao iniciada.\n\nJobs: ${started.length}\nSem elegiveis: ${skipped.length}\nErros: ${failed.length}\nFora da distribuicao: ${rejected.length}`,
    );
  } catch (err) {
    console.error("[listMode] erro ao distribuir campanhas:", err);
    setListModeStatus(err?.message || "Falha ao distribuir entre campanhas.", "warn");
    notifyPromocoes(err?.message || "Falha ao distribuir entre campanhas.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
    renderListModeResults();
  }
}

function invalidateManualApplyWizard({ keepPercent = true } = {}) {
  const prevPercent = keepPercent ? state.manualWizard.percent : null;
  const prevQuantity = keepPercent ? state.manualWizard.quantity : null;
  const prevStockMin = keepPercent ? state.manualWizard.stockMin : null;
  const prevStockMax = keepPercent ? state.manualWizard.stockMax : null;
  const prevListRaw = keepPercent ? state.manualWizard.listRaw || "" : "";
  const prevListOpen = keepPercent ? !!state.manualWizard.listOpen : false;
  const prevListDiagnostics = keepPercent ? state.manualWizard.listDiagnostics || null : null;
  state.manualWizard = {
    percent: prevPercent,
    quantity: prevQuantity,
    stockMin: prevStockMin,
    stockMax: prevStockMax,
    listRaw: prevListRaw,
    listOpen: prevListOpen,
    listDiagnostics: prevListDiagnostics,
    verified: false,
    loading: false,
    eligibleTotal: null,
    scope: keepPercent ? state.manualWizard?.scope || "all" : "all",
    promotionId: state.selectedCard?.id || null,
    promotionType: state.selectedCard?.type || null,
    status: currentWizardStatusKey(),
    mlb: state.mlbFilter || null,
    mlbsKey: manualWizardListKey() || listModeMlbsKey(),
    selectionToken: null,
    selectionIds: null,
  };
  renderManualApplyWizard();
}

function syncManualWizardPercent(percent) {
  const pct = round2(percent);
  const mode = getGuidedApplyMode();
  resetDealRangeDrafts();
  state.manualWizard.percent = pct;
  state.maxDesc = pct;
  if (mode === "deal") {
    state.dealManualPercent = pct;
    state.sellerManualPercent = null;
  } else if (mode === "seller") {
    state.sellerManualPercent = pct;
    state.dealManualPercent = null;
  } else if (mode === "smart" || mode === "pre_negotiated") {
    state.dealManualPercent = null;
    state.sellerManualPercent = null;
  }
  syncPromoBulkMeta({
    manualFlow: true,
    manualPercent: pct,
    filterLimit: pct,
  });
}

function isManualWizardVerifiedForCurrent() {
  const wizard = state.manualWizard || {};
  const currentPercent = getCurrentApplyPercent();
  const samePercent =
    Number.isFinite(Number(wizard.percent)) &&
    Number.isFinite(Number(currentPercent)) &&
    Number(wizard.percent) === Number(currentPercent);
  const sameLightningConfig =
    !isLightningSelected() ||
    (Number(wizard.quantity || 0) === Number(getManualWizardQuantity() || 0) &&
      Number(wizard.stockMin || 0) === Number(state.manualWizard?.stockMin || 0) &&
      Number(wizard.stockMax || 0) === Number(state.manualWizard?.stockMax || 0));
  return (
    !!wizard.verified &&
    samePercent &&
    sameLightningConfig &&
    String(wizard.promotionId || "") === String(state.selectedCard?.id || "") &&
    String(wizard.promotionType || "").toUpperCase() ===
      String(state.selectedCard?.type || "").toUpperCase() &&
    String(wizard.status || "all") === currentWizardStatusKey() &&
    String(wizard.mlb || "") === String(state.mlbFilter || "") &&
    String(wizard.mlbsKey || "") === (manualWizardListKey() || listModeMlbsKey())
  );
}

function setManualWizardBadge(id, text, tone = "") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else el.removeAttribute("data-tone");
}

function getManualWizardCopy(mode) {
  const isSmart = mode === "smart";
  const isPreNegotiated = mode === "pre_negotiated";
  const isCapFlow = isSmart || isPreNegotiated;
  const isLightning = isLightningSelected();
  return {
    titlePrefix: isPreNegotiated
      ? "Aceitar pre-acordos na campanha"
      : isSmart
        ? "Aplicar ofertas Smart na campanha"
        : "Aplicar desconto na campanha",
    stepFilter: isCapFlow ? "Definir teto" : "Filtrar elegiveis",
    stepPercent: isPreNegotiated
      ? "Verificar pre-acordos"
      : isSmart
        ? "Verificar candidatos"
        : isLightning
          ? "Definir desconto e unidades"
          : "Definir desconto",
    fieldLabel: isPreNegotiated
      ? "Qual desconto maximo pre-acordado voce aceita?"
      : isSmart
        ? "Qual desconto maximo voce aceita aplicar?"
        : "Qual % voce deseja aplicar?",
    hint: isPreNegotiated
      ? "O Mercado Livre ja definiu o preco e o offer_id do pre-acordo. A Davantti apenas aceita candidatos cujo desconto base seja menor ou igual ao teto informado; nenhum novo preco e calculado."
      : isSmart
        ? "A Smart ja traz ofertas sugeridas pelo Mercado Livre. A Davantti aplica apenas candidatos cujo desconto atual seja menor ou igual ao teto informado."
        : isLightning
          ? "A verificacao considera a faixa de desconto aceita. Na aplicacao, a mesma quantidade sera enviada para todos os anuncios do escopo escolhido."
          : "A verificacao considera a faixa minima e maxima aceita pelo Mercado Livre para cada anuncio.",
    idle: isPreNegotiated
      ? "Informe o teto maximo de desconto para verificar quais pre-acordos candidatos podem ser aceitos."
      : isSmart
        ? "Informe o teto maximo de desconto para verificar quais ofertas Smart candidatas podem ser aplicadas."
        : isLightning
          ? "Informe a porcentagem e a quantidade de unidades para verificar os anuncios elegiveis."
          : "Informe a porcentagem desejada para verificar quais anuncios aceitam esse desconto.",
    typed: isPreNegotiated
      ? "Teto informado. Clique em Verificar elegiveis para validar os pre-acordos candidatos."
      : isSmart
        ? "Teto informado. Clique em Verificar elegiveis para liberar a aplicacao das ofertas Smart."
        : isLightning
          ? "Percentual e unidades informados. Clique em Verificar elegiveis para liberar a aplicacao em massa."
          : "Percentual informado. Clique em Verificar elegiveis para liberar a aplicacao em massa.",
    verifying: isPreNegotiated
      ? "Revalidando offer_id, preco pre-acordado e desconto base..."
      : isSmart
        ? "Verificando ofertas Smart candidatas dentro do teto informado..."
        : "Verificando faixas aceitas pelo Mercado Livre...",
    verified: isPreNegotiated
      ? "Pre-acordos elegiveis ate {percent}. Escolha abaixo se deseja aceitar todos, os selecionados ou apenas os desta pagina."
      : isSmart
        ? "Ofertas Smart elegiveis ate {percent}. Escolha abaixo se deseja aplicar em todas, nas selecionadas ou apenas nesta pagina."
        : isLightning
          ? "Elegiveis verificados para {percent} e {quantity} unidade(s) por anuncio. Escolha o escopo abaixo."
          : "Elegiveis verificados para {percent}. Escolha abaixo se deseja aplicar em todos, nos selecionados ou apenas nesta pagina.",
    none: isPreNegotiated
      ? "Nenhum pre-acordo candidato elegivel ate {percent} com os filtros atuais."
      : isSmart
        ? "Nenhuma oferta Smart elegivel ate {percent} com os filtros atuais."
        : "Nenhum anuncio elegivel para {percent} com os filtros atuais.",
    eligibleBadge: isPreNegotiated
      ? "Pre-acordos: nao verificado"
      : isSmart
        ? "Ofertas: nao verificado"
        : "Elegiveis: nao verificado",
    discountBadge: isCapFlow ? "Teto: nao definido" : "Desconto: nao definido",
    discountValue: isCapFlow ? "Teto maximo: ate {percent}" : "{percent} de desconto",
    applyButton: isPreNegotiated
      ? "Aceitar pre-acordos"
      : isSmart
        ? "Aplicar ofertas Smart"
        : "Aplicar no ML",
    selectedMissing: isPreNegotiated
      ? "Informe o teto maximo antes de aceitar os pre-acordos selecionados."
      : isSmart
        ? "Informe o teto maximo de desconto antes de aplicar as ofertas selecionadas."
        : "Informe a porcentagem de desconto antes de aplicar os itens selecionados.",
    allHint: isPreNegotiated
      ? "Aceitar {count} pre-acordos dentro do teto de {percent} via lote filtrado."
      : isSmart
        ? "Aplicar ofertas Smart em {count} dentro do teto de {percent} via lote completo filtrado."
        : isLightning
          ? "Aplicar {percent} com {quantity} unidade(s) em {count} via lote completo filtrado."
          : "Aplicar {percent} em {count} via lote completo filtrado.",
    selectedHint: isPreNegotiated
      ? "Aceitar somente os {count} pre-acordos selecionados dentro do teto de {percent}."
      : isSmart
        ? "Aplicar ofertas Smart dentro do teto de {percent} somente nos {count}."
        : isLightning
          ? "Aplicar {percent} com {quantity} unidade(s) somente nos {count}."
          : "Aplicar {percent} somente nos {count}.",
    pageHint: isPreNegotiated
      ? "Aceitar os {count} pre-acordos elegiveis visiveis nesta pagina dentro do teto de {percent}."
      : isSmart
        ? "Aplicar ofertas Smart dentro do teto de {percent} nos {count} visiveis nesta pagina."
        : isLightning
          ? "Aplicar {percent} com {quantity} unidade(s) nos {count} visiveis nesta pagina."
          : "Aplicar {percent} nos {count} elegiveis visiveis nesta pagina.",
  };
}

function fillWizardCopy(template, values = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) =>
    values[key] == null ? "" : String(values[key]),
  );
}

function formatWizardCount(value, singular = "item", plural = "itens") {
  const n = Number(value || 0);
  return `${n.toLocaleString("pt-BR")} ${n === 1 ? singular : plural}`;
}

function currentManualWizardScope() {
  const checked = document.querySelector('input[name="manualWizardScope"]:checked');
  const scope = checked?.value || state.manualWizard?.scope || "all";
  return ["all", "selected", "page"].includes(scope) ? scope : "all";
}

function setManualWizardScope(scope) {
  const safeScope = ["all", "selected", "page"].includes(scope) ? scope : "all";
  state.manualWizard.scope = safeScope;
  document.querySelectorAll('input[name="manualWizardScope"]').forEach((input) => {
    input.checked = input.value === safeScope;
  });
  renderManualApplyWizard();
}

function renderManualApplyWizard() {
  const host = document.getElementById("manualApplyWizard");
  const shell = document.getElementById("campaignWorkspace");
  if (!host) return;

  const mode = getGuidedApplyMode();
  const hasGuidedFlow = !!state.selectedCard && !!mode;
  shell?.classList.toggle("manual-flow-active", hasGuidedFlow);

  if (!hasGuidedFlow) {
    host.classList.add("hidden");
    return;
  }

  host.classList.remove("hidden");

  const copy = getManualWizardCopy(mode);
  const campaignName = state.selectedCard?.name || state.selectedCard?.id || "campanha";
  const title = document.getElementById("manualWizardTitle");
  const status = document.getElementById("manualWizardStatus");
  const input = document.getElementById("manualWizardPercentInput");
  const quantityField = document.getElementById("manualWizardQuantityField");
  const quantityInput = document.getElementById("manualWizardQuantityInput");
  const advanced = document.getElementById("manualWizardAdvanced");
  const stockMinInput = document.getElementById("manualWizardStockMinInput");
  const stockMaxInput = document.getElementById("manualWizardStockMaxInput");
  const listPanel = document.getElementById("manualWizardMlbList");
  const listInput = document.getElementById("manualWizardMlbListInput");
  const listCounter = document.getElementById("manualWizardMlbListCounter");
  const listCsvBtn = document.getElementById("manualWizardMlbListCsv");
  const quantityBadge = document.getElementById("manualWizardQuantityBadge");
  const fieldLabel = document.getElementById("manualWizardPercentLabel");
  const wizardHint = document.getElementById("manualWizardHint");
  const verifyBtn = document.getElementById("btnManualWizardVerify");
  const applyBtn = document.getElementById("manualWizardApplyBtn");
  const removeBtn = document.getElementById("manualWizardRemoveBtn");
  const hint = document.getElementById("manualWizardActionHint");
  const stepApply = document.getElementById("manualWizardStepApply");
  const stepFilterLabel = document.getElementById("manualWizardStepFilterLabel");
  const stepPercentLabel = document.getElementById("manualWizardStepPercentLabel");
  const selectedCount = selectedTableCount();
  const verified = isManualWizardVerifiedForCurrent();
  const verifying = !!state.manualWizard?.loading;
  const eligibleTotal = verified ? Number(state.manualWizard.eligibleTotal || 0) : 0;
  const pageEligibleCount = Array.isArray(state.items) ? state.items.length : 0;
  const percent = Number(state.manualWizard.percent || getCurrentApplyPercent() || 0);
  const hasPercent = Number.isFinite(percent) && percent > 0 && percent < 100;
  const isLightning = isLightningSelected();
  const listSupported = isManualWizardListSupported() && !isLightning;
  const listMlbs = manualWizardListMlbs();
  const listActive = listSupported && listMlbs.length > 0;
  const quantity = getManualWizardQuantity();
  const hasQuantity = !isLightning || quantity != null;
  const hasRequiredValues = hasPercent && hasQuantity;
  const scope = currentManualWizardScope();
  const formattedPercent = hasPercent ? fmtPerc(percent, 2) : "";

  if (title) title.textContent = `${copy.titlePrefix} "${campaignName}"`;
  if (fieldLabel) fieldLabel.textContent = copy.fieldLabel;
  if (wizardHint) wizardHint.textContent = copy.hint;
  if (stepFilterLabel) stepFilterLabel.textContent = copy.stepFilter;
  if (stepPercentLabel) stepPercentLabel.textContent = copy.stepPercent;
  if (input && document.activeElement !== input) {
    input.value = hasPercent ? String(percent) : "";
  }
  quantityField?.classList.toggle("hidden", !isLightning);
  quantityBadge?.classList.toggle("hidden", !isLightning);
  advanced?.classList.toggle("hidden", !isLightning);
  listPanel?.classList.toggle("hidden", !listSupported);
  if (listPanel && listSupported) listPanel.open = !!state.manualWizard.listOpen || listActive;
  if (listInput && document.activeElement !== listInput) {
    listInput.value = listSupported ? state.manualWizard.listRaw || "" : "";
  }
  if (listCounter) {
    const rawTokens = manualWizardListRawTokenCount();
    const invalidCount = Math.max(0, rawTokens - listMlbs.length);
    listCounter.textContent = listActive
      ? `${formatWizardCount(listMlbs.length, "MLB identificado", "MLBs identificados")}${invalidCount ? ` • ${invalidCount} ignorado(s)` : ""}`
      : "0 MLBs identificados";
  }
  if (listCsvBtn) {
    const hasDiagnostics =
      listActive &&
      Array.isArray(state.manualWizard?.listDiagnostics) &&
      state.manualWizard.listDiagnostics.length > 0;
    listCsvBtn.classList.toggle("hidden", !hasDiagnostics);
    listCsvBtn.disabled = !hasDiagnostics;
  }
  if (quantityInput && document.activeElement !== quantityInput) {
    quantityInput.value = isLightning && quantity != null ? String(quantity) : "";
  }
  if (stockMinInput && document.activeElement !== stockMinInput) {
    stockMinInput.value = isLightning && state.manualWizard.stockMin != null
      ? String(state.manualWizard.stockMin)
      : "";
  }
  if (stockMaxInput && document.activeElement !== stockMaxInput) {
    stockMaxInput.value = isLightning && state.manualWizard.stockMax != null
      ? String(state.manualWizard.stockMax)
      : "";
  }

  if (status) {
    status.removeAttribute("data-tone");
    if (verifying) {
      status.textContent = copy.verifying;
      status.dataset.tone = "warn";
    } else if (verified && eligibleTotal > 0) {
      status.textContent = fillWizardCopy(copy.verified, {
        percent: formattedPercent,
        quantity,
      });
      if (listActive) {
        status.textContent = `${status.textContent} Lista ativa: ${formatWizardCount(listMlbs.length, "MLB informado", "MLBs informados")}.`;
      }
      status.dataset.tone = "success";
    } else if (verified && eligibleTotal <= 0) {
      status.textContent = fillWizardCopy(copy.none, { percent: formattedPercent });
      status.dataset.tone = "warn";
    } else if (isLightning && hasPercent && !hasQuantity) {
      status.textContent = "Informe também quantas unidades deseja aplicar em cada anúncio.";
      status.dataset.tone = "warn";
    } else if (hasRequiredValues) {
      status.textContent = copy.typed;
      status.dataset.tone = "warn";
    } else {
      status.textContent = copy.idle;
    }
  }

  setManualWizardBadge(
    "manualWizardEligibleBadge",
    verifying
      ? "Verificando..."
      : verified
      ? `${formatWizardCount(eligibleTotal, "elegivel", "elegiveis")}`
      : copy.eligibleBadge,
    verifying ? "blue" : verified ? (eligibleTotal > 0 ? "blue" : "orange") : "",
  );
  setManualWizardBadge(
    "manualWizardDiscountBadge",
    hasPercent
      ? fillWizardCopy(copy.discountValue, { percent: formattedPercent })
      : copy.discountBadge,
    hasPercent ? "green" : "",
  );
  if (isLightning) {
    setManualWizardBadge(
      "manualWizardQuantityBadge",
      hasQuantity
        ? `${quantity.toLocaleString("pt-BR")} unidade${quantity === 1 ? "" : "s"} por anuncio`
        : "Unidades: nao definido",
      hasQuantity ? "green" : "",
    );
  }
  setManualWizardBadge(
    "manualWizardSelectedBadge",
    formatWizardCount(selectedCount, "selecionado", "selecionados"),
    selectedCount > 0 ? "blue" : "",
  );

  setText(
    "manualWizardScopeAllTitle",
    listActive ? "Aplicar em todos os elegiveis da lista" : "Aplicar em todos os elegiveis",
  );
  setText(
    "manualWizardScopeAllDesc",
    listActive ? "Somente MLBs informados que passaram na verificacao" : "Todos os itens que passaram na verificacao",
  );
  setText(
    "manualWizardScopeSelectedTitle",
    listActive ? "Aplicar apenas nos selecionados da lista" : "Aplicar apenas nos selecionados na tabela",
  );
  setText(
    "manualWizardScopeSelectedDesc",
    listActive ? "Somente itens da lista marcados manualmente abaixo" : "Somente os itens marcados manualmente abaixo",
  );
  setText(
    "manualWizardScopePageTitle",
    listActive ? "Aplicar apenas nesta pagina da lista" : "Aplicar apenas nesta pagina",
  );
  setText(
    "manualWizardScopePageDesc",
    listActive ? "Somente elegiveis da lista visiveis na pagina atual" : "Somente os elegiveis visiveis na pagina atual",
  );

  const canApplyAll =
    !verifying && scope === "all" && verified && eligibleTotal > 0 && hasRequiredValues;
  const canApplySelected =
    !verifying && scope === "selected" && selectedCount > 0 && hasRequiredValues;
  const canApplyPage =
    !verifying && scope === "page" && verified && pageEligibleCount > 0 && hasRequiredValues;
  const canApply = canApplyAll || canApplySelected || canApplyPage;

  const scopeMeta = {
    all: {
      label: "todos os elegiveis",
      count: eligibleTotal,
      disabled: verifying || !verified || eligibleTotal <= 0,
      hint:
        verified && eligibleTotal > 0
          ? fillWizardCopy(copy.allHint, {
              percent: formattedPercent,
              quantity,
              count: formatWizardCount(eligibleTotal, "elegivel", "elegiveis"),
            })
          : "Verifique os elegiveis para liberar a aplicacao em todos.",
    },
    selected: {
      label: "selecionados",
      count: selectedCount,
      disabled: verifying || selectedCount <= 0 || !hasRequiredValues,
      hint:
        selectedCount > 0
          ? fillWizardCopy(copy.selectedHint, {
              percent: formattedPercent,
              quantity,
              count: formatWizardCount(selectedCount, "item marcado", "itens marcados"),
            })
          : "Marque itens na tabela para aplicar apenas neles.",
    },
    page: {
      label: "esta pagina",
      count: pageEligibleCount,
      disabled: verifying || !verified || pageEligibleCount <= 0 || !hasRequiredValues,
      hint:
        verified && pageEligibleCount > 0
          ? fillWizardCopy(copy.pageHint, {
              percent: formattedPercent,
              quantity,
              count: formatWizardCount(pageEligibleCount),
            })
          : "Verifique os elegiveis para aplicar apenas a pagina atual.",
    },
  };

  document.querySelectorAll(".manual-apply-scope__option").forEach((option) => {
    const radio = option.querySelector('input[name="manualWizardScope"]');
    const value = radio?.value || "all";
    const meta = scopeMeta[value] || scopeMeta.all;
    const active = value === scope;
    option.classList.toggle("is-active", active);
    option.classList.toggle("is-disabled", meta.disabled);
    if (radio) radio.checked = active;
  });

  setText("manualWizardScopeAllCount", formatWizardCount(eligibleTotal));
  setText("manualWizardScopeSelectedCount", formatWizardCount(selectedCount, "marcado", "marcados"));
  setText("manualWizardScopePageCount", formatWizardCount(pageEligibleCount));

  if (verifyBtn) {
    verifyBtn.disabled = verifying || !hasRequiredValues;
    verifyBtn.classList.toggle("is-loading", verifying);
    verifyBtn.textContent = verifying
      ? "Verificando..."
      : listActive
        ? "Verificar lista"
        : "Verificar elegiveis";
  }

  if (applyBtn) {
    applyBtn.disabled = !canApply;
    applyBtn.textContent = listActive ? "Aplicar lista no ML" : copy.applyButton;
  }

  if (removeBtn) {
    const canRemoveSelected = scope === "selected" && selectedCount > 0;
    const canRemovePage = scope === "page" && pageEligibleCount > 0;
    const canRemoveAll = scope === "all" && verified && eligibleTotal > 0;
    removeBtn.classList.remove("hidden");
    removeBtn.disabled = verifying || !(canRemoveSelected || canRemovePage || canRemoveAll);
  }

  if (hint) {
    hint.textContent = scopeMeta[scope]?.hint || "Escolha o escopo da aplicacao antes de continuar.";
  }

  stepApply?.classList.toggle("manual-apply-step--ready", canApply);
}

async function verifyManualApplyEligibility() {
  if (state.manualWizard?.loading) return;

  if (!state.selectedCard || !isManualApplyFlowSelected()) {
    notifyPromocoes("Selecione uma campanha Deal, Seller, Smart, Pre-acordo ou Lightning.");
    return;
  }
  const input = document.getElementById("manualWizardPercentInput");
  const raw = input?.value?.trim();
  const pct = raw === "" || raw == null ? null : Number(String(raw).replace(",", "."));
  if (!isValidManualPromoPercent(pct)) {
    notifyPromocoes(manualPromoPercentMessage());
    input?.focus();
    return;
  }
  const quantityInput = document.getElementById("manualWizardQuantityInput");
  const quantityRaw = quantityInput?.value?.trim();
  const quantity =
    quantityRaw === "" || quantityRaw == null ? null : Number(quantityRaw);
  if (
    isLightningSelected() &&
    (!Number.isFinite(quantity) || quantity < 5 || !Number.isInteger(quantity))
  ) {
    notifyPromocoes("Informe uma quantidade valida de unidades. O minimo para oferta relampago e 5.");
    quantityInput?.focus();
    return;
  }
  const manualListMlbs = manualWizardListMlbs();
  const manualListActive = isManualWizardListSupported() && manualListMlbs.length > 0;
  if (isManualWizardListSupported() && manualWizardListRawTokenCount() > 0 && !manualListActive) {
    notifyPromocoes("Cole ao menos 1 MLB valido para verificar a lista.");
    document.getElementById("manualWizardMlbListInput")?.focus();
    return;
  }
  if (manualListMlbs.length > MANUAL_WIZARD_LIST_MAX_MLBS) {
    notifyPromocoes(`Informe no maximo ${MANUAL_WIZARD_LIST_MAX_MLBS} MLBs por verificacao de lista.`);
    document.getElementById("manualWizardMlbListInput")?.focus();
    return;
  }
  const stockFilters = getManualWizardStockFilters();
  if (isLightningSelected() && stockFilters.error) {
    notifyPromocoes(stockFilters.error);
    stockFilters.focus?.focus();
    return;
  }

  syncManualWizardPercent(pct);
  if (isLightningSelected()) syncManualWizardQuantity(quantity);
  if (isLightningSelected()) {
    syncManualWizardStockFilters(stockFilters.min, stockFilters.max);
  }
  state.manualWizard.verified = false;
  state.manualWizard.loading = true;
  state.manualWizard.eligibleTotal = null;
  renderManualApplyWizard();

  let keepLoadingForJob = false;
  try {
    if (manualListActive) {
      try {
        keepLoadingForJob = await startManualWizardListValidationJob({
          pct,
          mlbs: manualListMlbs,
        });
      } catch (err) {
        console.warn("[manualApplyWizard] falha ao iniciar job de lista:", err);
        notifyPromocoes(err?.message || "Falha ao iniciar a validacao da lista.");
      }
      return;
    }

    const body = {
      promotion_id: state.selectedCard.id,
      promotion_type: state.selectedCard.type,
      status: filtroToStatusParam() || null,
      mlb: state.mlbFilter || null,
      mlbs: activeListModeMlbs(),
      percent_max: pct,
      stock_min: isLightningSelected() ? stockFilters.min : null,
      stock_max: isLightningSelected() ? stockFilters.max : null,
      lightning_stock: isLightningSelected() ? quantity : null,
    };

    let total = null;
    let selectionToken = null;
    let selectionIds = null;
    try {
      const prepResult = await window.PromoHttp?.postSelectionPrepare?.(body);
      const data = prepResult?.data || {};
      if (!prepResult?.ok) {
        throw new Error(data?.error || "Nao foi possivel preparar os elegiveis.");
      }
      total = prepResult?.ok && typeof data.total === "number" ? data.total : null;
      selectionToken = prepResult?.ok && data.token ? String(data.token) : null;
      selectionIds = prepResult?.ok && Array.isArray(data.ids)
        ? [...new Set(data.ids.map((id) => String(id || "").trim().toUpperCase()).filter(Boolean))]
        : null;
    } catch (err) {
      console.warn("[manualApplyWizard] falha ao verificar elegiveis:", err);
      notifyPromocoes(err?.message || "Falha ao verificar os elegiveis da campanha.");
      return;
    }

    if (total == null) {
      total = Number(state.items?.length || state.paging?.total || 0);
    }

    state.manualWizard = {
      percent: round2(pct),
      quantity: isLightningSelected() ? quantity : null,
      stockMin: isLightningSelected() ? stockFilters.min : null,
      stockMax: isLightningSelected() ? stockFilters.max : null,
      verified: true,
      loading: false,
      eligibleTotal: Number(total || 0),
      scope: state.manualWizard?.scope || "all",
      promotionId: state.selectedCard.id,
      promotionType: state.selectedCard.type,
      status: currentWizardStatusKey(),
      mlb: state.mlbFilter || null,
      mlbsKey: manualListActive ? manualWizardListKey(manualListMlbs) : listModeMlbsKey(),
      listRaw: state.manualWizard?.listRaw || "",
      listOpen: !!state.manualWizard?.listOpen || manualListActive,
      listDiagnostics: manualListActive
        ? buildManualWizardListDiagnostics({
            eligibleIds: selectionIds || [],
            percent: pct,
          })
        : null,
      selectionToken,
      selectionIds,
    };
    if (selectionIds) {
      const eligibleIds = new Set(selectionIds);
      state.items = (Array.isArray(state.items) ? state.items : []).filter((item) =>
        eligibleIds.has(String(item?.id || item?.item_id || "").trim().toUpperCase()),
      );
      renderTabela(state.items);
    }
    state.paging.total = Number(total || state.paging.total || 0);

    syncPromoBulkMeta({
      filteredTotal: state.manualWizard.eligibleTotal,
      manualPercent: state.manualWizard.percent,
      manualFlow: true,
      filterLimit: state.manualWizard.percent,
    });

    renderPaginacao();
    if (manualListActive) {
      await carregarItensPagina(1, true);
    }
  } finally {
    if (state.manualWizard && !keepLoadingForJob) state.manualWizard.loading = false;
    renderManualApplyWizard();
  }
}

async function applyFromManualWizard() {
  if (!state.selectedCard || !isManualApplyFlowSelected()) return;
  const mode = getGuidedApplyMode();
  const copy = getManualWizardCopy(mode);

  const input = document.getElementById("manualWizardPercentInput");
  const raw = input?.value?.trim();
  const pct = raw === "" || raw == null ? null : Number(String(raw).replace(",", "."));
  if (Number.isFinite(pct) && pct > 0 && pct < 100) {
    syncManualWizardPercent(pct);
  }
  const quantityInput = document.getElementById("manualWizardQuantityInput");
  const quantityRaw = quantityInput?.value?.trim();
  const quantity =
    quantityRaw === "" || quantityRaw == null ? null : Number(quantityRaw);
  if (isLightningSelected()) {
    if (!Number.isFinite(quantity) || quantity < 5 || !Number.isInteger(quantity)) {
      notifyPromocoes("Informe uma quantidade valida de unidades. O minimo para oferta relampago e 5.");
      quantityInput?.focus();
      return;
    }
    syncManualWizardQuantity(quantity);
  }

  const scope = currentManualWizardScope();
  const selectedCount = selectedTableCount();
  if (scope === "selected") {
    if (
      (mode === "smart" || mode === "pre_negotiated" || isLightningSelected()) &&
      !isManualWizardVerifiedForCurrent()
    ) {
      notifyPromocoes(
        isLightningSelected()
          ? "Verifique os elegiveis antes de aplicar a oferta relampago nos selecionados."
          : mode === "pre_negotiated"
            ? "Verifique os elegiveis antes de aceitar os pre-acordos selecionados."
            : "Verifique os elegiveis antes de aplicar ofertas Smart selecionadas.",
      );
      input?.focus();
      return;
    }
    if (getCurrentApplyPercent() == null && state.maxDesc == null) {
      notifyPromocoes(copy.selectedMissing);
      input?.focus();
      return;
    }
    if (selectedCount <= 0) {
      notifyPromocoes("Selecione ao menos 1 item na tabela para aplicar apenas nos selecionados.");
      return;
    }
    const bulkApplyBtn = document.getElementById("selApplyBtn");
    if (bulkApplyBtn) {
      bulkApplyBtn.click();
    } else if (typeof window.aplicarLoteSelecionados === "function") {
      await window.aplicarLoteSelecionados();
    }
    return;
  }

  if (scope === "page") {
    if (!isManualWizardVerifiedForCurrent() || !Array.isArray(state.items) || state.items.length <= 0) {
      notifyPromocoes("Verifique os elegiveis antes de aplicar apenas nesta pagina.");
      return;
    }
    document.querySelectorAll('#tbody input[type="checkbox"][data-mlb]').forEach((checkbox) => {
      checkbox.checked = true;
    });
    window.PromoBulk?.onHeaderToggle?.(true);
    atualizarFaixaSelecaoCampanha();
    renderManualApplyWizard();
    const bulkApplyBtn = document.getElementById("selApplyBtn");
    if (bulkApplyBtn) {
      bulkApplyBtn.click();
    } else if (typeof window.aplicarLoteSelecionados === "function") {
      await window.aplicarLoteSelecionados();
    }
    return;
  }

  if (!isManualWizardVerifiedForCurrent() || Number(state.manualWizard.eligibleTotal || 0) <= 0) {
    notifyPromocoes("Verifique os elegiveis antes de aplicar em massa.");
    return;
  }

  await aplicarTodosFiltrados();
}

function removeFromManualWizard() {
  if (!state.selectedCard || !isManualApplyFlowSelected()) return;
  if (
    String(state.selectedCard?.type || "").toUpperCase() === "PRE_NEGOTIATED" &&
    !window.confirm(
      "Atencao: ao remover um pre-acordo, o Mercado Livre informa que o anuncio deixa de ser candidato a essa oferta. Deseja continuar?",
    )
  ) {
    return;
  }
  const scope = currentManualWizardScope();

  if (scope === "selected") {
    if (selectedTableCount() <= 0) {
      notifyPromocoes("Selecione ao menos 1 item para remover da campanha.");
      return;
    }
    const bulkRemoveBtn = document.getElementById("selRemoveBtn");
    if (bulkRemoveBtn) {
      bulkRemoveBtn.click();
    } else if (typeof removerEmMassaSelecionados === "function") {
      removerEmMassaSelecionados().catch((err) => console.error(err));
    }
    return;
  }

  if (scope === "page") {
    const checkboxes = $$('#tbody input[type="checkbox"][data-mlb]');
    if (!checkboxes.length) {
      notifyPromocoes("Nenhum item visivel nesta pagina para remover.");
      return;
    }
    checkboxes.forEach((checkbox) => {
      checkbox.checked = true;
    });
    window.PromoBulk?.onHeaderToggle?.(true);
    atualizarFaixaSelecaoCampanha();
    renderManualApplyWizard();
    const bulkRemoveBtn = document.getElementById("selRemoveBtn");
    if (bulkRemoveBtn) {
      bulkRemoveBtn.click();
    } else if (typeof removerEmMassaSelecionados === "function") {
      removerEmMassaSelecionados().catch((err) => console.error(err));
    }
    return;
  }

  if (!isManualWizardVerifiedForCurrent() || Number(state.manualWizard.eligibleTotal || 0) <= 0) {
    notifyPromocoes("Verifique os elegiveis antes de remover em massa.");
    return;
  }

  removerTodosFiltrados({ skipConfirm: false }).catch((err) => console.error(err));
}

function updateSellerCampaignControls() {
  if (PromoSellerCampaign.updateControls) {
    PromoSellerCampaign.updateControls({ state });
    return;
  }

  const host = document.getElementById("sellerCampaignControls");
  const hint = document.getElementById("sellerCampaignPercentHint");
  const input = sellerManualPercentInput();
  const filterBadge = document.getElementById("sellerCampaignFilterBadge");
  const applyBadge = document.getElementById("sellerCampaignApplyBadge");
  if (!host) return;

  if (!isSellerCampaignSelected()) {
    host.classList.add("hidden");
    return;
  }

  host.classList.remove("hidden");
  const pct = getSellerManualPercent();
  const target = state.maxDesc != null ? Number(state.maxDesc) : null;
  if (input && document.activeElement !== input) {
    input.value = pct != null ? String(pct) : "";
  }

  if (hint) {
    hint.textContent =
      pct != null && target != null
        ? `Lista filtrada em ${target.toFixed(2)}%. O lote vai tentar aplicar ${pct.toFixed(2)}% nos itens selecionados.`
        : pct != null
          ? `Desconto pronto para envio: ${pct.toFixed(2)}%. Se quiser reduzir a lista antes, use o filtro acima.`
          : target != null
            ? `Lista filtrada em ${target.toFixed(2)}%. Agora defina o desconto a aplicar no lote.`
            : "Primeiro filtre a lista acima. Depois salve o desconto que sera aplicado na seller.";
  }
  setManualFlowBadge(
    filterBadge,
    target != null
      ? `Filtro da lista: ${target.toFixed(2)}%`
      : "Filtro da lista: nao definido",
    target != null ? "active" : "warn",
  );
  setManualFlowBadge(
    applyBadge,
    pct != null
      ? `Aplicar no ML: ${pct.toFixed(2)}%`
      : "Aplicar no ML: nao definido",
    pct != null ? "success" : "warn",
  );
}

function setSellerManualPercentFromUi() {
  if (PromoSellerCampaign.setManualPercentFromUi) {
    return PromoSellerCampaign.setManualPercentFromUi({ state, round2 });
  }

  const raw = sellerManualPercentInput()?.value?.trim();
  const n =
    raw === "" || raw == null ? null : Number(String(raw).replace(",", "."));
  if (n == null) {
    state.sellerManualPercent = null;
    resetDealRangeDrafts();
    updateSellerCampaignControls();
    return true;
  }
  if (!isValidManualPromoPercent(n)) {
    notifyPromocoes(manualPromoPercentMessage("Informe um desconto a aplicar valido"));
    return false;
  }
  if (
    state.maxDesc != null &&
    Number.isFinite(Number(state.maxDesc)) &&
    Number(n) > Number(state.maxDesc)
  ) {
    notifyPromocoes(
      `O desconto da seller nao pode ser maior que o filtro da lista (${round2(Number(state.maxDesc))}%).`,
    );
    return false;
  }
  state.sellerManualPercent = round2(n);
  resetDealRangeDrafts();
  updateSellerCampaignControls();
  return true;
}

function updateDealControls() {
  const host = document.getElementById("dealControls");
  const hint = document.getElementById("dealPercentHint");
  const input = dealManualPercentInput();
  const filterBadge = document.getElementById("dealFilterBadge");
  const applyBadge = document.getElementById("dealApplyBadge");
  if (!host) return;

  if (!isDealSelected()) {
    host.classList.add("hidden");
    return;
  }

  host.classList.remove("hidden");
  const pct = getDealManualPercent();
  const target = state.maxDesc != null ? Number(state.maxDesc) : null;
  if (input && document.activeElement !== input) {
    input.value = pct != null ? String(pct) : "";
    if (target != null && Number.isFinite(target)) {
      input.max = String(Math.min(target, window.PROMO_MANUAL_MAX_PERCENT));
    } else {
      input.max = String(window.PROMO_MANUAL_MAX_PERCENT);
    }
  }

  if (hint) {
    if (pct != null && target != null) {
      hint.textContent = `Lista filtrada em ${target.toFixed(2)}%. O lote vai tentar aplicar ${pct.toFixed(2)}% na deal.`;
    } else if (pct != null) {
      hint.textContent = `Desconto pronto para envio: ${pct.toFixed(2)}%. Se quiser reduzir a lista antes, use o filtro acima.`;
    } else if (target != null) {
      hint.textContent = `Lista filtrada em ${target.toFixed(2)}%. Agora salve o desconto a aplicar na deal.`;
    } else {
      hint.textContent =
        "Primeiro filtre a lista acima. Depois salve o desconto que sera aplicado na deal.";
    }
  }
  setManualFlowBadge(
    filterBadge,
    target != null
      ? `Filtro da lista: ${target.toFixed(2)}%`
      : "Filtro da lista: nao definido",
    target != null ? "active" : "warn",
  );
  setManualFlowBadge(
    applyBadge,
    pct != null
      ? `Aplicar no ML: ${pct.toFixed(2)}%`
      : "Aplicar no ML: nao definido",
    pct != null ? "success" : "warn",
  );
}

function setDealManualPercentFromUi() {
  const raw = dealManualPercentInput()?.value?.trim();
  const n =
    raw === "" || raw == null ? null : Number(String(raw).replace(",", "."));
  if (n == null) {
    state.dealManualPercent = null;
    resetDealRangeDrafts();
    updateDealControls();
    return true;
  }
  if (!isValidManualPromoPercent(n)) {
    notifyPromocoes(manualPromoPercentMessage("Informe um desconto a aplicar valido"));
    return false;
  }
  if (
    state.maxDesc != null &&
    Number.isFinite(Number(state.maxDesc)) &&
    Number(n) > Number(state.maxDesc)
  ) {
    notifyPromocoes(
      `O desconto da deal nao pode ser maior que o filtro da lista (${round2(Number(state.maxDesc))}%).`,
    );
    return false;
  }
  state.dealManualPercent = round2(n);
  resetDealRangeDrafts();
  updateDealControls();
  if (state.selectedCard) renderTabela(state.items || []);
  return true;
}

function resolveDealManualPrice(it, { silent = false } = {}) {
  const original = toNum(it?.original_price ?? it?.price ?? null);
  let percent = getDealManualPercent();

  if (percent == null && !silent) {
    const suggested =
      state.maxDesc != null && Number.isFinite(Number(state.maxDesc))
        ? String(round2(Number(state.maxDesc)))
        : "";
    const input = prompt(
      `Informe a % de desconto para ${it?.id || "o item"}:`,
      suggested,
    );
    if (!input) return null;
    const parsed = Number(String(input).replace(",", "."));
    if (!isValidManualPromoPercent(parsed)) {
      notifyPromocoes(manualPromoPercentMessage("Informe uma % valida"));
      return null;
    }
    if (state.maxDesc != null && parsed > Number(state.maxDesc)) {
      notifyPromocoes(
        `A % informada nao pode ser maior que o filtro da lista (${round2(Number(state.maxDesc))}%).`,
      );
      return null;
    }
    state.dealManualPercent = round2(parsed);
    updateDealControls();
    percent = getDealManualPercent();
  }

  if (percent == null) return null;
  if (!isDealPercentWithinRange(it, percent)) {
    const range = computeDealDiscountRange(it);
    if (!silent) {
      notifyPromocoes(
        `O item ${it?.id || ""} aceita apenas descontos entre ${fmtPerc(range.minPct ?? 0, 2)} e ${fmtPerc(range.maxPct ?? 0, 2)}.`,
      );
    }
    return null;
  }

  return computeDealPriceFromPercent(original, percent);
}

function resolveSellerCampaignDealPrice(it, { silent = false } = {}) {
  if (PromoSellerCampaign.resolveDealPrice) {
    return PromoSellerCampaign.resolveDealPrice(it, {
      state,
      toNum,
      round2,
      computeDealPriceFromPercent,
      silent,
    });
  }

  const original = toNum(it?.original_price ?? it?.price ?? null);
  let percent = getSellerManualPercent();

  if (percent == null && !silent) {
    const suggested = toNum(it?.discount_percentage);
    const input = prompt(
      `Informe a % de desconto para ${it?.id || "o item"}:`,
      suggested != null ? String(round2(suggested)) : "",
    );
    if (!input) return null;
    const parsed = Number(String(input).replace(",", "."));
    if (!isValidManualPromoPercent(parsed)) {
      notifyPromocoes(manualPromoPercentMessage("Informe uma % valida"));
      return null;
    }
    if (state.maxDesc != null && parsed > Number(state.maxDesc)) {
      notifyPromocoes(
        `A % informada nao pode ser maior que o filtro da lista (${round2(Number(state.maxDesc))}%).`,
      );
      return null;
    }
    state.sellerManualPercent = round2(parsed);
    updateSellerCampaignControls();
    percent = getSellerManualPercent();
  }

  if (percent == null) return null;
  if (!isDealPercentWithinRange(it, percent)) {
    const range = computeDealDiscountRange(it);
    if (!silent) {
      notifyPromocoes(
        `O item ${it?.id || ""} aceita apenas descontos entre ${fmtPerc(range.minPct ?? 0, 2)} e ${fmtPerc(range.maxPct ?? 0, 2)}.`,
      );
    }
    return null;
  }
  return computeDealPriceFromPercent(original, percent);
}

/** Normaliza nomenclaturas da API para comparações consistentes */
function normalizeStatus(s) {
  if (PromoState.normalizeStatus) {
    return PromoState.normalizeStatus(s);
  }
  s = String(s || "").toLowerCase();

  // compat/alias que às vezes aparece em integrações antigas
  if (s === "in_progress") return "pending";
  if (s === "scheduled") return "pending"; // normaliza "scheduled" para "pending"
  if (s === "programmed") return "pending"; // opcional (robustez)

  return s;
}

/** Deduplica por MLB escolhendo o "status real" com prioridade.
 *  started > pending > candidate > outros
 */
function dedupeByMLB(items, statusFilter) {
  if (PromoState.dedupeByMLB) {
    return PromoState.dedupeByMLB(items, statusFilter);
  }
  const rank = { started: 3, pending: 2, candidate: 1 };
  const pickRank = (st) => rank[normalizeStatus(st)] ?? 0;

  const map = new Map();
  for (const it of items) {
    const id = String(it?.id || "");
    if (!id) continue;

    const st = normalizeStatus(it.status);
    const cur = map.get(id);

    if (!cur || pickRank(st) > pickRank(cur.status)) {
      map.set(id, { ...it, status: st });
    }
  }

  let arr = [...map.values()];

  if (statusFilter) {
    const want = normalizeStatus(statusFilter);
    arr = arr.filter((x) => normalizeStatus(x.status) === want);
  }

  return arr;
}

// =====================================================
// ============ Hidratação de candidatos DEAL ==========
// =====================================================

/**
 * Para DEAL/SELLER_* quando um item candidate vem SEM
 * min/max, fazemos uma consulta pontual /items/:mlb
 * para tentar obter os campos e atualizar a linha.
 * Limita a 5 itens por chamada para evitar bursts.
 */
async function hydrateDealCandidateSuggestions(items, opts = {}) {
  const typeUp = (state.selectedCard?.type || "").toUpperCase();
  if (!["DEAL", "LIGHTNING"].includes(typeUp)) return;

  const targets = [];
  for (const it of items) {
    const st = normalizeStatus(it.status);
    const range = computeDealDiscountRange({
      ...it,
      promotion_type: typeUp,
    });
    const noSug = range.minPct == null || range.maxPct == null;
    if ((st === "candidate" || st === "pending") && noSug) targets.push(it.id);
  }
  if (!targets.length) return;

  let changed = false;
  for (const mlb of targets) {
    try {
      const resp = await getJSONAny(itemPromosPaths(mlb));
      const promos = Array.isArray(resp) ? resp : (resp?.results ?? []);
      const match = promos.find(
        (p) =>
          String(p?.id ?? p?.promotion_id ?? "") ===
          String(state.selectedCard?.id ?? ""),
      );
      if (!match) continue;

      const row = state.items.find((x) => String(x.id) === String(mlb));
      if (!row) continue;

      const min = toNum(match.min_discounted_price);
      const matchRange = computeDealDiscountRange({
        ...match,
        promotion_type: typeUp,
      });
      const max = matchRange.maxPrice;

      if ((min && min > 0) || (max && max > 0)) {
        if (min && min > 0) row.min_discounted_price = min;
        if (max && max > 0) row.max_discounted_price = max;

        changed = true;
      }
    } catch {
      // ignora
    }
  }

  if (changed && !opts.skipRender) {
    renderTabela(state.items);
    renderPaginacao();
    applyRebateHeaderTooltip();
  }
}

function statusLabel(st) {
  st = normalizeStatus(st);
  if (st === "started") return "started";
  if (st === "candidate") return "candidate";
  if (st === "pending") return "programado";
  return st || "—";
}

function statusClassName(st) {
  st = normalizeStatus(st);
  if (st === "started") return "promo-status promo-status--started";
  if (st === "pending") return "promo-status promo-status--pending";
  if (st === "candidate") return "promo-status promo-status--candidate";
  return "promo-status promo-status--neutral";
}

function hasDealSuggestionFields(it) {
  return (
    Number(it?.min_discounted_price) > 0 || Number(it?.max_discounted_price) > 0
  );
}

function isStrictDealCandidate(it) {
  if (PromoState.isStrictDealCandidate) {
    return PromoState.isStrictDealCandidate(it, state);
  }
  const typeUp = (state.selectedCard?.type || "").toUpperCase();
  if (typeUp !== "DEAL") return false;
  const st = normalizeStatus(it?.status);
  return (
    (st === "candidate" || st === "pending") && !hasDealSuggestionFields(it)
  );
}

// =====================================================
// ===================== Rebate helper =================
// =====================================================

/** Lê rebate (MELI/Seller) de diversos formatos do payload */
function pickRebate(obj) {
  if (PromoState.pickRebate) {
    return PromoState.pickRebate(obj, toNum);
  }
  const b = obj?.benefits || {};
  const meli = toNum(
    obj?.meli_percentage ?? obj?.meli_percent ?? b?.meli_percent,
  );
  const seller = toNum(
    obj?.seller_percentage ?? obj?.seller_percent ?? b?.seller_percent,
  );
  const type = b?.type || (meli != null ? "REBATE" : null);
  return { type, meli, seller };
}

// =====================================================
// ========= Cálculo de % de desconto por tipo =========
// =====================================================

/**
 * Calcula a % de desconto considerando o tipo de campanha
 * e as regras específicas para DEAL/SMART etc.
 */
function computeDescPct(it, benefitsGlobal) {
  if (PromoState.computeDescPct) {
    return PromoState.computeDescPct(it, benefitsGlobal, {
      state,
      toNum,
    });
  }
  const typeUp = (state.selectedCard?.type || "").toUpperCase();
  const original = toNum(it.original_price ?? it.price ?? null);
  const st = String(it.status || "").toLowerCase();

  if (isStrictDealCandidate(it)) return null;

  // PRE_NEGOTIATED: o ML ja pre-acordou o preco. O teto compara o desconto
  // base original_price -> price; rebate ML/Seller e boost ficam so na auditoria.
  if (typeUp === "PRE_NEGOTIATED") {
    const preOriginal = toNum(
      it.original_price ?? it.item_original_price ?? it.regular_amount ?? it.base_price,
    );
    const prePrice = toNum(
      it.deal_price ?? it.new_price ?? it._resolved_final_price ?? it.price,
    );
    if (
      preOriginal != null &&
      preOriginal > 0 &&
      prePrice != null &&
      prePrice > 0 &&
      prePrice <= preOriginal
    ) {
      return 100 * (1 - prePrice / preOriginal);
    }
    return toNum(it.discount_percentage);
  }

  // SMART / PRICE_MATCHING: soma MELI + Seller quando faltar % do ML
  if (isSmartLikePromotionType(typeUp)) {
    if (original != null) {
      const rb = pickRebate(it);
      const m =
        toNum(it.meli_percentage) ??
        toNum(it.rebate_meli_percent) ??
        toNum(rb.meli) ??
        toNum(benefitsGlobal?.meli_percent);
      const s =
        toNum(it.seller_percentage) ??
        toNum(rb.seller) ??
        toNum(benefitsGlobal?.seller_percent);
      const tot = toNum((m || 0) + (s || 0));
      if (toNum(it.discount_percentage) == null && (m != null || s != null))
        return tot;
    }
    return toNum(it.discount_percentage);
  }

  // DEAL / SELLER_* : usa heurística de resolução baseada em min/max
  if (isDealRangePromotionType(typeUp)) {
    const { pct } = resolveDealFinalAndPctFront({
      original_price: original,
      status: it.status,
      deal_price: it.deal_price ?? it.new_price,
      min_discounted_price: it.min_discounted_price,
      max_discounted_price: it.max_discounted_price,
      price: it.price,
      discount_percentage: it.discount_percentage,
    });

    const mlPct = toNum(it.discount_percentage);
    const isCandLike = st === "candidate" || st === "pending";

    if (isCandLike) return pct; // pode ficar null; melhor vazio que errado
    if (mlPct != null && mlPct > 70 && pct != null && Math.abs(mlPct - pct) > 5)
      return pct;

    return mlPct != null ? mlPct : pct;
  }

  // Fallback genérico
  const deal = toNum(it.deal_price ?? it.new_price ?? it._resolved_final_price ?? null);
  if (original != null && deal != null && original > 0) {
    return (1 - deal / original) * 100;
  }
  return toNum(it.discount_percentage);
}

// =====================================================
// === Resolver preço final/% para DEAL (Front-side) ===
// =====================================================

/**
 * Heurística única (espelha o back) para resolver preço final e % em DEAL/SELLER.
 */
function resolveDealFinalAndPctFront(raw) {
  if (PromoState.resolveDealFinalAndPctFront) {
    return PromoState.resolveDealFinalAndPctFront(raw);
  }
  const orig = Number(
    raw.original_price ?? raw.originalPrice ?? raw.price ?? 0,
  );
  const st = String(raw.status || "").toLowerCase();
  const typeUp = String(raw.promotion_type ?? raw.type ?? "").toUpperCase();
  const isDeal = typeUp === "DEAL" || typeUp === "LIGHTNING";

  const deal = Number(raw.deal_price ?? raw.new_price ?? 0);
  const minD = Number(raw.min_discounted_price ?? 0);
  const maxD = Number(raw.max_discounted_price ?? 0);
  const px = Number(raw.price ?? 0); // pode ser PREÇO FINAL ou DESCONTO em R$
  const mlPct = Number(raw.discount_percentage ?? NaN); // usado só para sanidade

  if (!orig || !isFinite(orig) || orig <= 0) {
    return { final: null, pct: null, estimated: false, source: null };
  }

  const GAP = 0.7; // valida "preço final" plausível
  const PCT_MIN = 5; // limite inferior seguro
  const PCT_MAX = 40; // limite superior seguro
  const isPlausibleFinal = (v) =>
    isFinite(v) && v > 0 && v < orig && (orig - v) / orig < GAP;
  const isPlausiblePct = (p) => isFinite(p) && p >= PCT_MIN && p <= PCT_MAX;

  const isCandLike = st === "candidate" || st === "pending";
  const noSuggestions =
    !(isFinite(minD) && minD > 0) && !(isFinite(maxD) && maxD > 0);

  let final = null;
  let estimated = false;
  let source = null;

  // 1) started => confiar no deal/new_price
  if (st === "started" && isPlausibleFinal(deal)) {
    final = deal;
    source = "Deal";
  }

  // 2) DEAL candidato/pendente: usar apenas a sugestão oficial do ML
  if (!final && isDeal && isCandLike && isPlausibleFinal(maxD)) {
    final = maxD;
    source = "Max";
  }

  // 3) demais promoções: faixa min/max
  if (!final) {
    if (!isDeal && isPlausibleFinal(minD)) {
      final = minD;
      source = "Min";
    }
    if (!final && !isDeal && isPlausibleFinal(maxD)) {
      final = maxD;
      source = "Max";
    }
  }

  // 4) candidate-like sem sugestões: usar PRICE como DESCONTO EM R$
  if (
    !final &&
    !isDeal &&
    isCandLike &&
    noSuggestions &&
    isFinite(px) &&
    px > 0
  ) {
    const pctFromPrice = (px / orig) * 100;
    if (isPlausiblePct(pctFromPrice)) {
      const candidateFinal = orig - px;
      if (isPlausibleFinal(candidateFinal)) {
        final = candidateFinal;
        source = "PriceÎ”R";
        estimated = true;
      }
    }
  }

  // 5) fallback (não candidate): aceitar px como final plausível
  if (!final && !isCandLike && isFinite(px) && px > 0 && isPlausibleFinal(px)) {
    final = px;
    source = "Price";
  }

  if (!final) return { final: null, pct: null, estimated: false, source: null };

  const pct = Math.max(0, Math.min(100, ((orig - final) / orig) * 100));
  return {
    final: Number(final.toFixed(2)),
    pct: Number(pct.toFixed(2)),
    estimated,
    source,
  };
}

// =====================================================
// ========= Escolha segura de deal price (UI) =========
// =====================================================

/**
 * safeDealPrice — usa a mesma heurística do resolve* para
 * garantir que “Novo preço” mostre um valor coerente.
 */
function safeDealPrice(it, original) {
  if (PromoState.safeDealPrice) {
    return PromoState.safeDealPrice(it, original, {
      state,
      toNum,
    });
  }
  const typeUp = (state.selectedCard?.type || "").toUpperCase();
  const isDealLike = isDealRangePromotionType(typeUp);
  if (!isDealLike) return toNum(it.deal_price ?? it.price ?? null);
  if (isStrictDealCandidate(it)) return null;

  const { final } = resolveDealFinalAndPctFront({
    original_price: toNum(original ?? it.original_price ?? it.price ?? null),
    status: it.status,
    deal_price: it.deal_price ?? it.new_price,
    min_discounted_price: it.min_discounted_price,
    max_discounted_price: it.max_discounted_price,
    price: it.price,
    discount_percentage: it.discount_percentage,
  });
  return final != null ? final : null;
}

// =====================================================
// ============== Helpers de cabeçalho Rebate ==========
// =====================================================

function hideLeadingRebateColumnIfPresent() {
  const table = getTable();
  if (!table) return;
  const ths = table.querySelectorAll("thead th");
  if (
    ths.length &&
    ths[0].textContent.trim().toLowerCase().startsWith("rebate")
  ) {
    table.classList.add("hide-leading-rebate");
  }
}
function getRebateHeaderTh() {
  const table = getTable();
  if (!table) return null;
  return [...table.querySelectorAll("thead th")].find((th) =>
    th.textContent.trim().toLowerCase().startsWith("rebate"),
  );
}
function applyRebateHeaderTooltip() {
  const th = getRebateHeaderTh();
  if (!th) return;
  const b = state.promotionBenefits || state.selectedCard?.benefits || null;

  let mlp = null,
    sp = null,
    type = b?.type || state.selectedCard?.type || "—";

  if (b) {
    mlp = b.meli_percent != null ? `${b.meli_percent}%` : null;
    sp = b.seller_percent != null ? `${b.seller_percent}%` : null;
  } else if (state.items?.length) {
    const set = new Set(
      state.items
        .map(
          (x) =>
            x.meli_percentage ?? x.rebate_meli_percent ?? pickRebate(x).meli,
        )
        .filter((v) => v != null),
    );
    mlp = set.size === 1 ? `${[...set][0]}%` : "varia por item";
  }

  const isRebate =
    b?.type === "REBATE" ||
    isSmartLikePromotionType(state.selectedCard?.type);
  const tooltip = `Tipo: ${type}\nMELI: ${mlp ?? "—"}\nSeller: ${sp ?? "—"}`;
  th.innerHTML = isRebate
    ? `<span class="badge badge-rebate" title="${esc(tooltip)}">REBATE</span>`
    : `<span class="tip" title="${esc(tooltip)}">?</span>`;
}

function sellerCampaignModal() {
  return PromoSellerCampaign.sellerCampaignModal
    ? PromoSellerCampaign.sellerCampaignModal()
    : document.getElementById("sellerCampaignModal");
}

function openSellerCampaignModal(campaign = null) {
  if (PromoSellerCampaign.openModal) {
    PromoSellerCampaign.openModal({ state, campaign });
  }
}

function closeSellerCampaignModal() {
  if (PromoSellerCampaign.closeModal) {
    PromoSellerCampaign.closeModal({ state });
  }
}

function buildSellerCampaignDates(startDate, finishDate) {
  if (PromoSellerCampaign.buildDates) {
    return PromoSellerCampaign.buildDates(startDate, finishDate);
  }
  return {
    start_date: `${startDate}T00:00:00`,
    finish_date: `${finishDate}T00:00:00`,
  };
}

async function submitSellerCampaignCreation() {
  if (PromoSellerCampaign.submitCreation) {
    return PromoSellerCampaign.submitCreation({
      state,
      withBase: withPromoBase,
      setLoading,
      carregarCards,
      selecionarCard,
    });
  }
  return false;
}

function toggleCardMenu(cardId) {
  const id = String(cardId || "");
  state.openCardMenuId = state.openCardMenuId === id ? null : id;
  renderCards();
}

async function editSellerCampaign(cardId) {
  const card = state.cards.find((c) => String(c.id) === String(cardId));
  if (!card) return;
  state.openCardMenuId = null;
  openSellerCampaignModal(card);
}

async function deleteSellerCampaign(cardId) {
  const card = state.cards.find((c) => String(c.id) === String(cardId));
  if (!card) return;

  state.openCardMenuId = null;
  const label = String(card.name || card.id || "esta campanha");
  if (!window.confirm(`Excluir seller campaign "${label}"?`)) return;

  setLoading(true, "Excluindo seller campaign...");
  try {
    const res = await fetch(
      withPromoBase(`/api/promocoes/promotions/${encodeURIComponent(card.id)}`),
      {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promotion_type: "SELLER_CAMPAIGN" }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || "Falha ao excluir seller campaign.");
    }

    if (String(state.selectedCard?.id || "") === String(card.id)) {
      clearCampaignSelection({ keepMlbFilter: true });
    }

    await carregarCards();
    setLoading(false, `Seller campaign ${label} excluída com sucesso.`);
  } catch (err) {
    console.error("[deleteSellerCampaign] erro:", err);
    setLoading(false, err?.message || "Falha ao excluir seller campaign.");
    notifyPromocoes(err?.message || "Falha ao excluir seller campaign.");
  }
}

// =====================================================
// ================ Eventos básicos da UI ==============
// =====================================================

document.addEventListener("click", async (ev) => {
  const t = ev.target;

  const modeBtn = t.closest?.("[data-promo-mode]");
  if (modeBtn) {
    ev.preventDefault();
    setOperationMode(modeBtn.dataset.promoMode || "campaign");
    return;
  }

  if (t.closest?.("#btnListModeSearch")) {
    ev.preventDefault();
    await findCompatibleCampaignsForList().catch((err) => {
      console.error("[listMode] erro ao buscar campanhas compativeis:", err);
      setListModeStatus(err?.message || "Falha ao buscar campanhas compativeis.", "warn");
    });
    return;
  }

  if (t.closest?.("[data-list-distribute-campaigns]")) {
    ev.preventDefault();
    await distributeListModeAcrossCampaigns();
    return;
  }

  const useListBtn = t.closest?.("[data-list-use-campaign]");
  if (useListBtn) {
    ev.preventDefault();
    await useListModeCampaign(useListBtn.dataset.listUseCampaign).catch((err) => {
      console.error("[listMode] erro ao usar campanha:", err);
      notifyPromocoes(err?.message || "Falha ao selecionar campanha da lista.");
    });
    return;
  }

  if (t.closest?.("#btnOpenSellerCampaignModal")) {
    ev.preventDefault();
    openSellerCampaignModal();
    return;
  }

  if (t.closest?.("#btnCloseSellerCampaignModal")) {
    ev.preventDefault();
    closeSellerCampaignModal();
    return;
  }

  if (t.closest?.("#btnCreateSellerCampaign")) {
    ev.preventDefault();
    await submitSellerCampaignCreation().catch((err) => console.error(err));
    return;
  }

  if (t.id === "sellerCampaignModal") {
    closeSellerCampaignModal();
    return;
  }

  if (t.closest?.("[data-card-menu-toggle]")) {
    ev.preventDefault();
    ev.stopPropagation();
    toggleCardMenu(
      t.closest("[data-card-menu-toggle]")?.dataset.cardMenuToggle,
    );
    return;
  }

  if (t.closest?.("[data-card-edit]")) {
    ev.preventDefault();
    ev.stopPropagation();
    await editSellerCampaign(t.closest("[data-card-edit]")?.dataset.cardEdit);
    return;
  }

  if (t.closest?.("[data-card-delete]")) {
    ev.preventDefault();
    ev.stopPropagation();
    await deleteSellerCampaign(
      t.closest("[data-card-delete]")?.dataset.cardDelete,
    );
    return;
  }

  if (!t.closest?.(".promo-campaign-card__menu")) {
    if (state.openCardMenuId) {
      state.openCardMenuId = null;
      renderCards();
    }
  }

  if (t.closest?.("#btnSellerManualPercent")) {
    ev.preventDefault();
    if (!setSellerManualPercentFromUi()) return;
    if (state.items?.length) renderTabela(state.items);
    atualizarFaixaSelecaoCampanha();
    return;
  }

  if (t.closest?.("#btnSellerManualPercentClear")) {
    ev.preventDefault();
    state.sellerManualPercent = null;
    const input = sellerManualPercentInput();
    if (input) input.value = "";
    updateSellerCampaignControls();
    if (state.items?.length) renderTabela(state.items);
    atualizarFaixaSelecaoCampanha();
    return;
  }

  if (t.closest?.("#btnDealManualPercent")) {
    ev.preventDefault();
    if (!setDealManualPercentFromUi()) return;
    if (state.items?.length) renderTabela(state.items);
    atualizarFaixaSelecaoCampanha();
    return;
  }

  if (t.closest?.("#btnDealManualPercentClear")) {
    ev.preventDefault();
    state.dealManualPercent = null;
    const input = dealManualPercentInput();
    if (input) input.value = "";
    updateDealControls();
    if (state.items?.length) renderTabela(state.items);
    atualizarFaixaSelecaoCampanha();
    return;
  }

  if (t.closest?.("#btnManualWizardVerify")) {
    ev.preventDefault();
    await verifyManualApplyEligibility().catch((err) => {
      console.error("[manualApplyWizard] erro ao verificar elegiveis:", err);
      notifyPromocoes(err?.message || "Falha ao verificar elegiveis.");
      renderManualApplyWizard();
    });
    return;
  }

  if (t.closest?.("#manualWizardMlbListClear")) {
    ev.preventDefault();
    state.manualWizard.listRaw = "";
    state.manualWizard.listOpen = false;
    state.manualWizard.verified = false;
    state.manualWizard.eligibleTotal = null;
    state.manualWizard.selectionToken = null;
    state.manualWizard.selectionIds = null;
    state.manualWizard.listDiagnostics = null;
    const listInput = document.getElementById("manualWizardMlbListInput");
    if (listInput) listInput.value = "";
    renderManualApplyWizard();
    return;
  }

  if (t.closest?.("#manualWizardMlbListCsv")) {
    ev.preventDefault();
    exportManualWizardListCsv();
    return;
  }

  if (t.closest?.("#manualWizardApplyBtn")) {
    ev.preventDefault();
    await applyFromManualWizard().catch((err) => {
      console.error("[manualApplyWizard] erro ao aplicar:", err);
      notifyPromocoes(err?.message || "Falha ao iniciar aplicacao.");
    });
    atualizarFaixaSelecaoCampanha();
    renderManualApplyWizard();
    return;
  }

  if (t.closest?.("#manualWizardRemoveBtn")) {
    ev.preventDefault();
    removeFromManualWizard();
    atualizarFaixaSelecaoCampanha();
    renderManualApplyWizard();
    return;
  }

  if (t.closest?.("#btnExportFilteredCsv")) {
    ev.preventDefault();
    await exportFilteredCsv().catch((err) => {
      console.error("[exportFilteredCsv] erro:", err);
      setLoading(false, err?.message || "Falha ao exportar CSV.");
      notifyPromocoes(err?.message || "Falha ao exportar CSV.");
    });
    return;
  }

  if (t.closest?.("#btnFiltrarItem")) {
    ev.preventDefault();
    const mlb = ($("#mlbFilter")?.value || "").trim().toUpperCase();
    state.mlbFilter = mlb;
    invalidateManualApplyWizard({ keepPercent: true });
    if (!mlb) {
      state.cardsFilteredIds = null;
      renderCards();
      return;
    }
    await filtrarCardsPorMLB(mlb);
    atualizarFaixaSelecaoCampanha();
    return;
  }

  if (t.closest?.("#btnLimparItem")) {
    ev.preventDefault();
    state.mlbFilter = "";
    state.cardsFilteredIds = null;
    invalidateManualApplyWizard({ keepPercent: true });
    const input = $("#mlbFilter");
    if (input) input.value = "";
    renderCards();
    atualizarFaixaSelecaoCampanha();
    return;
  }

  if (t.closest?.("#btnDebugMlb")) {
    ev.preventDefault();
    await runManualMlbDebug();
    return;
  }

  if (t.closest?.("#btnDebugMlbClear")) {
    ev.preventDefault();
    if (elDebugInput()) elDebugInput().value = "";
    updateDebugMlbMeta();
    setDebugMlbOutput("Aguardando debug.");
    return;
  }

  // Esses dois IDs são opcionais, mantidos por compatibilidade
  if (t.closest?.("#btnRemoverTodos")) {
    ev.preventDefault();
    await removerEmMassaSelecionados().catch((err) => console.error(err));
    atualizarFaixaSelecaoCampanha();
    return;
  }

  if (t.closest?.("#btnAplicarTodos")) {
    ev.preventDefault();
    await aplicarTodosFiltrados().catch((err) => console.error(err));
    atualizarFaixaSelecaoCampanha();
    return;
  }
});

document.addEventListener("change", async (ev) => {
  const r = ev.target;
  if (r?.id === "listModeTypeFilter") {
    state.listMode.typeFilter = String(r.value || "SELLER_CAMPAIGN").toUpperCase();
    state.listMode.selectedCampaignId = null;
    state.listMode.applyingCampaignId = null;
    state.listMode.results = [];
    resetListModeCampaignSelection();
    renderListModeResults();
    setListModeStatus("Tipo alterado. Clique em buscar campanhas compativeis para validar novamente.");
    return;
  }

  if (r.name === "filtro") {
    state.filtroParticipacao = r.value || "all";
    invalidateManualApplyWizard({ keepPercent: true });
    if (state.selectedCard) await carregarItensPagina(1, true);
    atualizarFaixaSelecaoCampanha();
    renderManualApplyWizard();
    return;
  }

  if (r.matches?.('#tbody input[type="checkbox"][data-mlb]')) {
    renderManualApplyWizard();
    return;
  }

  if (r.matches?.('input[name="manualWizardScope"]')) {
    setManualWizardScope(r.value);
    return;
  }
});

document.addEventListener(
  "toggle",
  (ev) => {
    if (ev.target?.id !== "manualWizardMlbList") return;
    state.manualWizard.listOpen = !!ev.target.open;
  },
  true,
);

document.addEventListener("input", (ev) => {
  const t = ev.target;
  if (t?.matches?.(".deal-range-slider")) {
    updateDealRangeRowFromSlider(t);
    return;
  }
  if (t?.matches?.("input[data-lightning-stock]")) {
    syncLightningStockInput(t);
    return;
  }
  if (["listModeMlbsInput", "listModePercentInput"].includes(t?.id)) {
    state.listMode.selectedCampaignId = null;
    state.listMode.applyingCampaignId = null;
    state.listMode.results = [];
    resetListModeCampaignSelection();
    renderListModeResults();
    setListModeStatus("Lista alterada. Clique em buscar campanhas compativeis para validar novamente.");
    return;
  }
  if (t?.id === "manualWizardMlbListInput") {
    state.manualWizard.listRaw = t.value || "";
    state.manualWizard.listOpen = true;
    state.manualWizard.verified = false;
    state.manualWizard.eligibleTotal = null;
    state.manualWizard.selectionToken = null;
    state.manualWizard.selectionIds = null;
    state.manualWizard.listDiagnostics = null;
    renderManualApplyWizard();
    return;
  }
  if (t?.id === "manualWizardQuantityInput") {
    const raw = t.value?.trim();
    const quantity = raw === "" || raw == null ? null : Number(raw);
    syncManualWizardQuantity(quantity);
    state.manualWizard.verified = false;
    state.manualWizard.eligibleTotal = null;
    state.manualWizard.listDiagnostics = null;
    renderManualApplyWizard();
    return;
  }
  if (["manualWizardStockMinInput", "manualWizardStockMaxInput"].includes(t?.id)) {
    const filters = getManualWizardStockFilters({ allowInvalid: true });
    syncManualWizardStockFilters(filters.min, filters.max);
    state.manualWizard.verified = false;
    state.manualWizard.eligibleTotal = null;
    state.manualWizard.listDiagnostics = null;
    renderManualApplyWizard();
    return;
  }
  if (t?.id !== "manualWizardPercentInput") return;
  const raw = t.value?.trim();
  const pct = raw === "" || raw == null ? null : Number(String(raw).replace(",", "."));
  const validPct = isValidManualPromoPercent(pct);
  state.manualWizard.percent = validPct ? round2(pct) : null;
  if (!validPct) {
    state.dealManualPercent = null;
    state.sellerManualPercent = null;
    state.maxDesc = null;
  }
  state.manualWizard.verified = false;
  state.manualWizard.eligibleTotal = null;
  state.manualWizard.listDiagnostics = null;
  renderManualApplyWizard();
});

document.addEventListener("keydown", async (ev) => {
  if (ev.key === "Enter" && ev.target?.id === "listModePercentInput") {
    ev.preventDefault();
    await findCompatibleCampaignsForList().catch((err) => {
      console.error("[listMode] erro ao buscar campanhas compativeis:", err);
      setListModeStatus(err?.message || "Falha ao buscar campanhas compativeis.", "warn");
    });
    return;
  }

  if (
    ev.key === "Enter" &&
    [
      "manualWizardPercentInput",
      "manualWizardQuantityInput",
      "manualWizardStockMinInput",
      "manualWizardStockMaxInput",
    ].includes(
      ev.target?.id,
    )
  ) {
    ev.preventDefault();
    await verifyManualApplyEligibility().catch((err) => {
      console.error("[manualApplyWizard] erro ao verificar elegiveis:", err);
      notifyPromocoes(err?.message || "Falha ao verificar elegiveis.");
      renderManualApplyWizard();
    });
    return;
  }

  if (ev.key === "Enter" && ev.target?.id === "mlbFilter") {
    ev.preventDefault();
    const mlb = ev.target.value.trim().toUpperCase();
    state.mlbFilter = mlb;
    invalidateManualApplyWizard({ keepPercent: true });
    if (!mlb) {
      state.cardsFilteredIds = null;
      renderCards();
      return;
    }
    await filtrarCardsPorMLB(mlb);
    atualizarFaixaSelecaoCampanha();
  }
});

/* ======================== Busca por MLB (cards do item) ======================== */

const ITEM_PROMO_TYPES = new Set([
  "SMART",
  "PRE_NEGOTIATED",
  "MARKETPLACE_CAMPAIGN",
  "DEAL",
  "DOD",
  "PRICE_MATCHING",
  "PRICE_MATCHING_MELI_ALL",
  "SELLER_CAMPAIGN",
  "PRICE_DISCOUNT",
  "LIGHTNING",
]);

const itemPromosPaths = (mlb) => [
  `/api/promocoes/items/${encodeURIComponent(mlb)}`,
];

async function buscarCardsDoItem(mlb) {
  for (const p of itemPromosPaths(mlb)) {
    try {
      const r = await fetch(p, { credentials: "same-origin" });
      if (!r.ok) continue;
      const arr = await r.json();

      const cards = extractList(arr)
        .filter(
          (c) =>
            c &&
            (c.id || c.name) &&
            ITEM_PROMO_TYPES.has(String(c.type || "").toUpperCase()),
        )
        .map((c) => ({
          id: c.id,
          type: String(c.type || "").toUpperCase(),
          name: c.name || c.id || "Campanha",
          status: c.status,
          start_date: c.start_date,
          finish_date: c.finish_date,
          benefits: c.benefits || null,
        }));

      return cards;
    } catch {
      /* tenta próxima rota */
    }
  }
  return [];
}

/* ======================== Tabs por tipo (Cards) ======================== */

const TAB_POLICY = {
  hideZeros: true,
  removeTypes: new Set([
    "MARKETPLACE_CAMPAIGN",
    "PRICE_DISCOUNT",
    "PRICE_MATCHING_MELI_ALL",
  ]),
};

const TYPE_LABELS = {
  DEAL: "Deal",
  SMART: "Smart",
  PRE_NEGOTIATED: "Pre-acordo",
  SELLER_CAMPAIGN: "Seller",
  DOD: "DOD",
  LIGHTNING: "Lightning",
  OTHER: "Outros",
};

const TYPE_TAB_ORDER = ["DEAL", "SMART", "PRE_NEGOTIATED", "SELLER_CAMPAIGN", "DOD", "LIGHTNING", "OTHER"];
const TYPE_TAB_ALLOWED = new Set(TYPE_TAB_ORDER);

function normalizeCardTypeForTabs(type) {
  const up = String(type || "").toUpperCase();

  // PRICE_MATCHING permanece agrupado em Smart; PRE_NEGOTIATED tem fluxo proprio.
  if (up === "PRICE_MATCHING") return "SMART";
  if (up === "PRE_NEGOTIATED") return "PRE_NEGOTIATED";

  // você já decidiu que PM(ML) e Marketplace somem também
  // (se você já filtrou no carregarCards, ótimo; aqui deixo seguro)
  if (up === "PRICE_MATCHING_MELI_ALL") return "REMOVED";
  if (up === "MARKETPLACE_CAMPAIGN") return "REMOVED";

  // Tabs dedicadas que você quer manter
  if (up === "SMART") return "SMART";
  if (up === "PRE_NEGOTIATED") return "PRE_NEGOTIATED";
  if (up === "DEAL") return "DEAL";
  if (up === "SELLER_CAMPAIGN") return "SELLER_CAMPAIGN";
  if (up === "DOD") return "DOD";
  if (up === "LIGHTNING") return "LIGHTNING";
  if (up === "PRICE_DISCOUNT") return "REMOVED";

  // qualquer outro tipo vira "OTHER" (opcional)
  return "OTHER";
}

function getCardsByActiveType(list) {
  const arr = Array.isArray(list) ? list : [];
  const active = TYPE_TAB_ALLOWED.has(String(state.activeTypeTab || "").toUpperCase())
    ? String(state.activeTypeTab).toUpperCase()
    : "DEAL";

  // Filtra usando a mesma normalização
  return arr.filter((card) => {
    const t = normalizeCardTypeForTabs(card?.type);

    // segurança: se cair em "REMOVED", não exibe nunca
    if (t === "REMOVED") return false;

    // se existir tab OTHER, só entra o que não for tab principal
    if (active === "OTHER") return t === "OTHER";

    // default: match direto
    return t === active;
  });
}

function updateTabsCounts(listAll) {
  const list = Array.isArray(listAll) ? listAll : [];

  const counts = {
    DEAL: 0,
    SMART: 0,
    SELLER_CAMPAIGN: 0,
    DOD: 0,
    LIGHTNING: 0,
    OTHER: 0,
  };

  for (const c of list) {
    const ty = normalizeCardTypeForTabs(c?.type);
    if (ty === "REMOVED") continue;
    counts[ty] = (counts[ty] || 0) + 1;
  }

  document.querySelectorAll("[data-count]").forEach((el) => {
    const k = String(el.getAttribute("data-count") || "").toUpperCase();
    if (!k) return;
    if (counts[k] == null) return;
    el.textContent = String(counts[k]);
  });

  const label = document.getElementById("promoTabsLabel");
  const meta = document.getElementById("promoTabsMeta");
  if (label) {
    label.textContent = TYPE_LABELS[state.activeTypeTab] || state.activeTypeTab;
  }
  if (meta) {
    const showing = getCardsByActiveType(list).length;
    meta.textContent = `${showing} de ${list.length} campanhas`;
  }
}

function setupTypeTabs() {
  const row = document.getElementById("promoTypeTabs");
  if (!row) return;

  // evita múltiplos binds se carregarCards chamar mais de uma vez
  if (row.dataset.bound === "1") return;
  row.dataset.bound = "1";

  row.addEventListener("click", (ev) => {
    const btn = ev.target.closest?.("button[data-type]");
    if (!btn) return;

    // Se estiver oculto/desabilitado, ignora
    if (btn.classList.contains("is-hidden") || btn.disabled) return;

    const type = String(btn.dataset.type || "DEAL").toUpperCase();
    if (!TYPE_TAB_ALLOWED.has(type)) return;

    state.activeTypeTab = type;

    if (state.selectedCard && normalizeCardTypeForTabs(state.selectedCard.type) !== type) {
      clearCampaignSelection({ keepMlbFilter: true });
    }

    row.querySelectorAll("button[data-type]").forEach((b) => {
      const isOn = String(b.dataset.type || "").toUpperCase() === type;
      b.classList.toggle("active", isOn);
      b.setAttribute("aria-selected", isOn ? "true" : "false");
    });

    renderCards();
    atualizarFaixaSelecaoCampanha();
  });
}

function setPromoTabsLoading(isLoading) {
  const tabs = document.getElementById("campaignModeTabs");
  if (!tabs) return;
  tabs.classList.toggle("is-loading", !!isLoading);
  tabs.setAttribute("aria-busy", isLoading ? "true" : "false");
}

const promotionCountCache = new Map();
const promotionCountInflight = new Map();
let promotionCountsRunning = false;

function getVisiblePromotionCardsForCounts() {
  const baseList = state.cardsFilteredIds
    ? state.cards.filter((c) => state.cardsFilteredIds.has(c.id))
    : state.cards;

  return getCardsByActiveType(baseList).filter(
    (card) =>
      card &&
      card.id &&
      card.type &&
      normalizeCardTypeForTabs(card.type) !== "REMOVED",
  );
}

function hasPromotionCounts(card) {
  const hasValue = (value) =>
    value !== null &&
    value !== undefined &&
    value !== "" &&
    Number.isFinite(Number(value));
  return hasValue(card?.eligible_items) || hasValue(card?.participating_items);
}

function getManualWizardQuantity() {
  const value = Number(state.manualWizard?.quantity);
  if (!Number.isFinite(value) || value < 5 || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function syncManualWizardQuantity(quantity) {
  const value = Number(quantity);
  state.manualWizard.quantity =
    Number.isFinite(value) && value >= 5 && Number.isInteger(value)
      ? value
      : null;
}

function parseOptionalStockFilter(input) {
  const raw = input?.value?.trim();
  if (raw === "" || raw == null) return { value: null, valid: true };
  const value = Number(raw);
  const valid = Number.isFinite(value) && value >= 5 && Number.isInteger(value);
  return { value: valid ? value : null, valid };
}

function getManualWizardStockFilters({ allowInvalid = false } = {}) {
  const minInput = document.getElementById("manualWizardStockMinInput");
  const maxInput = document.getElementById("manualWizardStockMaxInput");
  const minParsed = parseOptionalStockFilter(minInput);
  const maxParsed = parseOptionalStockFilter(maxInput);

  if (!allowInvalid && !minParsed.valid) {
    return {
      min: null,
      max: maxParsed.value,
      error: "O estoque inicial deve ser um numero inteiro maior ou igual a 5.",
      focus: minInput,
    };
  }
  if (!allowInvalid && !maxParsed.valid) {
    return {
      min: minParsed.value,
      max: null,
      error: "O estoque final deve ser um numero inteiro maior ou igual a 5.",
      focus: maxInput,
    };
  }
  if (
    !allowInvalid &&
    minParsed.value != null &&
    maxParsed.value != null &&
    maxParsed.value < minParsed.value
  ) {
    return {
      min: minParsed.value,
      max: maxParsed.value,
      error: "O estoque final deve ser maior ou igual ao estoque inicial.",
      focus: maxInput,
    };
  }
  return { min: minParsed.value, max: maxParsed.value, error: null };
}

function syncManualWizardStockFilters(min, max) {
  state.manualWizard.stockMin = Number.isInteger(min) && min >= 5 ? min : null;
  state.manualWizard.stockMax = Number.isInteger(max) && max >= 5 ? max : null;
}

function itemMatchesStockFilter(item) {
  if (!isLightningSelected()) return true;
  const min = state.manualWizard?.stockMin;
  const max = state.manualWizard?.stockMax;
  if (min == null && max == null) return true;
  const available = Number(item?.available_quantity);
  if (!Number.isFinite(available)) return false;
  if (min != null && available < min) return false;
  if (max != null && available > max) return false;
  return true;
}

function normalizePositiveInt(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function getLightningStockBounds(it) {
  const rawStock = it?.stock;
  const stockObj =
    rawStock && typeof rawStock === "object" && !Array.isArray(rawStock)
      ? rawStock
      : null;
  const min = Math.max(
    5,
    normalizePositiveInt(
      stockObj?.min ??
        it?.stock_min ??
        it?.min_stock ??
        it?.minimum_stock ??
        it?.min_quantity,
      null,
    ) ?? 5,
  );
  const max =
    normalizePositiveInt(
      stockObj?.max ??
        it?.stock_max ??
        it?.max_stock ??
        it?.maximum_stock ??
        it?.max_quantity ??
        it?.available_quantity,
      null,
    ) ?? null;
  return {
    min,
    max: max != null && max >= min ? max : null,
  };
}

function normalizeLightningStockValue(value, bounds) {
  let qty = normalizePositiveInt(value, null);
  if (qty == null) qty = bounds?.min ?? 1;
  qty = Math.max(bounds?.min ?? 1, qty);
  if (bounds?.max != null) qty = Math.min(bounds.max, qty);
  return qty;
}

function displayStockValue(it) {
  const rawStock = it?.stock;
  if (rawStock && typeof rawStock === "object" && !Array.isArray(rawStock)) {
    const bounds = getLightningStockBounds(it);
    return bounds.max != null ? bounds.max : bounds.min || "—";
  }
  return it?.available_quantity ?? rawStock ?? "—";
}

function displayAvailableStockValue(it) {
  const available = Number(it?.available_quantity);
  return Number.isFinite(available) ? Math.max(0, Math.floor(available)) : "—";
}

function findLightningStockInput(mlb) {
  const wanted = String(mlb || "").toUpperCase();
  return $$('input[data-lightning-stock][data-mlb]').find(
    (input) => String(input.dataset.mlb || "").toUpperCase() === wanted,
  );
}

function getLightningStockDraftKey(mlb) {
  return `${state.selectedCard?.id || "promo"}:${String(mlb || "").toUpperCase()}`;
}

function getLightningStockForItem(
  mlb,
  it,
  { readDom = true, useBulk = false } = {},
) {
  const bounds = getLightningStockBounds(it);
  const key = getLightningStockDraftKey(mlb);
  const domValue = readDom ? findLightningStockInput(mlb)?.value : null;
  const stored = state.lightningStockDrafts?.[key];
  const bulkValue = useBulk ? getManualWizardQuantity() : null;
  if (bulkValue != null) return bulkValue;
  const source =
    domValue != null && domValue !== ""
      ? domValue
      : stored != null
        ? stored
        : it?.promotion_stock ?? it?.selected_stock ?? it?.stock?.selected;
  return normalizeLightningStockValue(source, bounds);
}

function buildLightningStockControl(mlb, it) {
  const bounds = getLightningStockBounds(it);
  const key = getLightningStockDraftKey(mlb);
  const value = getLightningStockForItem(mlb, it, { readDom: false });
  state.lightningStockDrafts[key] = value;
  const maxAttr = bounds.max != null ? ` max="${esc(bounds.max)}"` : "";
  const hint =
    bounds.max != null
      ? `min ${bounds.min} / max ${bounds.max}`
      : `min ${bounds.min}`;
  return `<label class="lightning-stock-control">
    <span>Qtd. promo</span>
    <input type="number" inputmode="numeric" min="${esc(bounds.min)}"${maxAttr} step="1" value="${esc(value)}" data-lightning-stock data-mlb="${esc(mlb)}">
    <small>${esc(hint)}</small>
  </label>`;
}

function syncLightningStockInput(input) {
  const mlb = String(input?.dataset?.mlb || "").toUpperCase();
  if (!mlb) return;
  const it = state.items.find(
    (row) => String(row?.id || row?.item_id || "").toUpperCase() === mlb,
  );
  const bounds = getLightningStockBounds(it || {});
  const value = normalizeLightningStockValue(input.value, bounds);
  input.value = String(value);
  state.lightningStockDrafts[getLightningStockDraftKey(mlb)] = value;
}

function promotionCountKey(card) {
  return `${String(card?.id || "")}|${String(card?.type || "").toUpperCase()}`;
}

async function fetchPromotionCounts(card) {
  const key = promotionCountKey(card);
  if (promotionCountCache.has(key)) return promotionCountCache.get(key);
  if (promotionCountInflight.has(key)) return promotionCountInflight.get(key);

  const url = withPromoBase(
    `/api/promocoes/promotions/${encodeURIComponent(card.id)}/counts?promotion_type=${encodeURIComponent(
      String(card.type || "").toUpperCase(),
    )}`,
  );

  const request = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18000);
    let response;
    let data = {};
    try {
      response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      data = await response.json().catch(() => ({}));
    } catch (err) {
      if (err?.name === "AbortError") {
        throw new Error("Timeout ao carregar contagem da campanha");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    const counts = {
      eligible_items: Number(data.eligible_items || 0),
      participating_items: Number(data.participating_items || 0),
    };
    promotionCountCache.set(key, counts);
    return counts;
  })();

  promotionCountInflight.set(key, request);
  try {
    return await request;
  } finally {
    promotionCountInflight.delete(key);
  }
}

function applyPromotionCounts(card, counts) {
  if (!card || !counts) return;
  card.eligible_items = Number.isFinite(Number(counts.eligible_items))
    ? Number(counts.eligible_items)
    : 0;
  card.participating_items = Number.isFinite(Number(counts.participating_items))
    ? Number(counts.participating_items)
    : 0;
  delete card.__countsError;
}

function loadVisiblePromotionCounts() {
  if (promotionCountsRunning) return;

  const cards = getVisiblePromotionCardsForCounts().filter(
    (card) => !hasPromotionCounts(card) && !card.__countsError,
  );
  if (!cards.length) return;

  const pending = cards.filter((card) => !promotionCountInflight.has(promotionCountKey(card)));
  if (!pending.length) return;

  const workers = Math.min(4, pending.length);
  let cursor = 0;
  promotionCountsRunning = true;

  const runNext = async () => {
    const card = pending[cursor++];
    if (!card) return;
    try {
      const counts = await fetchPromotionCounts(card);
      applyPromotionCounts(card, counts);
    } catch (err) {
      card.__countsError = true;
      console.warn("[promo-counts] falha ao carregar contagem", card.id, err);
    } finally {
      renderCards();
      await runNext();
    }
  };

  void Promise.all(Array.from({ length: workers }, () => runNext())).finally(() => {
    promotionCountsRunning = false;
    if (
      getVisiblePromotionCardsForCounts().some(
        (card) => !hasPromotionCounts(card) && !card.__countsError,
      )
    ) {
      loadVisiblePromotionCounts();
    }
  });
}

function updatePromotionTableHeader(type) {
  const table = getTable();
  const headRow = table?.querySelector("thead tr");
  if (!headRow) return;

  const typeUp = String(type || "").toUpperCase();
  const isSmartLike = isSmartLikePromotionType(typeUp);
  const isDealLike = isDealRangePromotionType(typeUp);
  const isLightning = typeUp === "LIGHTNING";

  const checkbox = `<th style="width:44px;text-align:center">
    <input
      type="checkbox"
      id="checkAll"
      aria-label="Selecionar pagina"
      onchange="toggleTodos(this); window.PromoBulk && window.PromoBulk.onHeaderToggle(this.checked)"
    >
  </th>`;

  if (isSmartLike) {
    headRow.innerHTML = `${checkbox}
      <th>Anuncio / SKU</th>
      <th>Estoque</th>
      <th>Preco atual</th>
      <th>DESC.</th>
      <th>Rebate</th>
      <th>Novo preco</th>
      <th>Status</th>
      <th>Acoes</th>`;
    return;
  }

  if (isDealLike) {
    headRow.innerHTML = `${checkbox}
      <th>Anuncio</th>
      <th>Estoque</th>
      ${isLightning ? '<th class="lightning-quantity-head">Quantidade <small>min. 5</small></th>' : ""}
      <th>SKU</th>
      <th>Preco atual</th>
      <th>Desc. permitido</th>
      <th>Novo preco</th>
      <th>Status</th>
      <th>Acoes</th>`;
    return;
  }

  headRow.innerHTML = `${checkbox}
    <th>Anuncio</th>
    <th>Estoque</th>
    <th>SKU</th>
    <th>Preco atual</th>
    <th>DESC.</th>
    <th>Novo preco</th>
    <th>Status</th>
    <th>Acoes</th>`;
}

/* ======================== Cards ======================== */

// --- coloque extractList fora do carregarCards (ideal) ou mantenha aqui ---
function extractList(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;

  if (payload.data) {
    const v = payload.data;
    if (Array.isArray(v)) return v;
    if (Array.isArray(v.results)) return v.results;
    if (Array.isArray(v.users)) return v.users;
    if (Array.isArray(v.campaigns)) return v.campaigns;
    if (Array.isArray(v.items)) return v.items;
  }

  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.users)) return payload.users;
  if (Array.isArray(payload.campaigns)) return payload.campaigns;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.rows)) return payload.rows;

  for (const k of Object.keys(payload)) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  return [];
}

async function carregarCards() {
  const $cards = elCards();
  if (!$cards) return;

  setPromoTabsLoading(true);
  $cards.classList.add("promo-campaign-grid");
  $cards.innerHTML = `<div class="promo-empty-state"><h3>Carregando promoções…</h3><div class="muted">Aguarde</div></div>`;

  function applyTabsVisibility(listAllFilteredByMLB) {
    const counts = {
      DEAL: 0,
      SMART: 0,
      SELLER_CAMPAIGN: 0,
      DOD: 0,
      LIGHTNING: 0,
      OTHER: 0,
    };

    for (const c of listAllFilteredByMLB) {
      const ty = normalizeCardTypeForTabs(c.type);
      if (ty === "REMOVED") continue;
      counts[ty] = (counts[ty] || 0) + 1;
    }

    document.querySelectorAll("[data-count]").forEach((el) => {
      const k = String(el.getAttribute("data-count") || "").toUpperCase();
      if (!k) return;
      if (counts[k] == null) return;
      el.textContent = String(counts[k]);
    });

    const row = document.getElementById("promoTypeTabs");
    if (!row) return;

    row.querySelectorAll("button[data-type]").forEach((btn) => {
      const type = String(btn.dataset.type || "").toUpperCase();

      const isRemoved =
        TAB_POLICY.removeTypes.has(type) ||
        type === "ALL" ||
        type === "OWNED" ||
        type === "MARKETPLACE_CAMPAIGN" ||
        type === "PRICE_MATCHING" ||
        type === "PRICE_DISCOUNT" ||
        type === "PRICE_MATCHING_MELI_ALL";

      if (isRemoved) {
        btn.classList.add("is-hidden");
        btn.style.display = "none";
        return;
      }

      if (!TYPE_TAB_ALLOWED.has(type)) {
        btn.classList.add("is-hidden");
        btn.style.display = "none";
        return;
      }

      if (TAB_POLICY.hideZeros) {
        const n = counts[type] ?? 0;
        btn.style.display = n > 0 || type === "DOD" ? "" : "none";
      } else {
        btn.style.display = "";
      }

      btn.classList.remove("is-hidden");
    });

    const activeBtn = row.querySelector(
      `button[data-type="${state.activeTypeTab}"]`,
    );
    const activeHidden =
      !activeBtn || activeBtn.style.display === "none" || activeBtn.disabled;

    if (activeHidden) {
      const nextType =
        TYPE_TAB_ORDER.find((type) => {
          const btn = row.querySelector(`button[data-type="${type}"]`);
          return btn && btn.style.display !== "none" && !btn.disabled;
        }) || "DEAL";

      state.activeTypeTab = nextType;
      row.querySelectorAll("button[data-type]").forEach((b) => {
        const isOn = String(b.dataset.type || "").toUpperCase() === nextType;
        b.classList.toggle("active", isOn);
        b.setAttribute("aria-selected", isOn ? "true" : "false");
      });
    }
  }

  try {
    setupTypeTabs();

    const tryVariants = [
      (p) => `${p}?status=all`,
      (p) => `${p}?status=started,scheduled`,
      (p) => `${p}?status=started,pending`,
      (p) => `${p}?status=active,scheduled`,
      (p) => p,
    ];

    let data = null;
    let buildOk = null;

    for (const build of tryVariants) {
      try {
        data = await getJSONAny(usersPaths().map(build));
        const first = extractList(data);
        if (first.length) {
          buildOk = build;
          break;
        }
      } catch {
        // tenta a próxima variação
      }
    }

    if (!data) throw new Error("Sem resposta do /users");

    let all = extractList(data);

    const paging = data?.paging || null;
    const total = Number(paging?.total || all.length || 0);
    const limit = Number(paging?.limit || 0);
    let offset = Number(paging?.offset || 0);

    // Paginação preservando o mesmo "build" que funcionou (status=...)
    if (total > 0 && limit > 0 && all.length < total) {
      const maxLoops = 200;
      for (let i = 0; i < maxLoops; i++) {
        offset += limit;
        if (offset >= total) break;

        const pageData = await getJSONAny(
          usersPaths().map((p) => {
            const base = buildOk ? buildOk(p) : p;
            const join = base.includes("?") ? "&" : "?";
            return `${base}${join}limit=${encodeURIComponent(
              limit,
            )}&offset=${encodeURIComponent(offset)}`;
          }),
        );

        const pageItems = extractList(pageData);
        if (!pageItems.length) break;

        all.push(...pageItems);
        if (pageItems.length < limit) break;
        if (all.length >= total) break;
      }
    }

    const seen = new Set();
    all = all.filter((c) => {
      const id = String(c?.id || "");
      if (!id) return false;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    all = all.filter((c) => normalizeCardTypeForTabs(c.type) !== "REMOVED");

    state.cards = all;
    console.log(`[info] ${state.cards.length} cards carregados (total)`);

    if (state.mlbFilter) {
      await filtrarCardsPorMLB(state.mlbFilter);
    }

    const baseList = state.cardsFilteredIds
      ? state.cards.filter((c) => state.cardsFilteredIds.has(c.id))
      : state.cards;

    applyTabsVisibility(baseList);
    setPromoTabsLoading(false);

    renderCards();
  } catch (e) {
    const authMsg =
      e?.cause?.status === 401 || e?.cause?.status === 403
        ? "Sua sessão com o Mercado Livre expirou ou não é de usuário. Clique em “Trocar Conta” e reconecte."
        : "Não foi possível carregar promoções (ver console).";

    console.error("[/users] erro ao carregar cards:", e, e?.cause);
    $cards.innerHTML = `<div class="card"><h3>Falha</h3><pre class="muted">${esc(
      authMsg,
    )}</pre></div>`;
    setPromoTabsLoading(false);
  } finally {
    atualizarFaixaSelecaoCampanha();
  }
}

function renderCards() {
  const $cards = elCards();
  if (PromoCards.renderCards) {
    PromoCards.renderCards({
      mount: $cards,
      state,
      getCardsByActiveType,
      updateTabsCounts,
      normalizeCardTypeForTabs,
      typeLabels: TYPE_LABELS,
      esc,
      onSelectCard: selecionarCard,
    });
    destacarCardSelecionado();
    loadVisiblePromotionCounts();
    return;
  }

  $cards.classList.add("promo-campaign-grid");

  const baseList = state.cardsFilteredIds
    ? state.cards.filter((c) => state.cardsFilteredIds.has(c.id))
    : state.cards;

  updateTabsCounts(baseList);

  const list = getCardsByActiveType(baseList);

  if (!list.length) {
    const msg = state.mlbFilter
      ? `Nenhuma campanha (${
          TYPE_LABELS[state.activeTypeTab] || state.activeTypeTab
        }) oferece promoção para o item ${esc(state.mlbFilter)}.`
      : `Nenhuma promoção em ${
          TYPE_LABELS[state.activeTypeTab] || state.activeTypeTab
        }.`;
    $cards.innerHTML = `<div class="promo-empty-state"><h3>${msg}</h3></div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  list.forEach((c) => {
    const div = document.createElement("div");
    const isSellerCreated =
      String(c.type || "").toUpperCase() === "SELLER_CAMPAIGN";
    div.className = `promo-campaign-card${isSellerCreated ? " promo-campaign-card--seller" : ""}`;
    div.tabIndex = 0;

    const status = (c.status || "").toLowerCase();
    const pill =
      status === "started"
        ? '<span class="pill">started</span>'
        : `<span class="pill muted">${esc(c.status || "")}</span>`;
    const fini = c.finish_date
      ? new Date(c.finish_date).toLocaleDateString("pt-BR")
      : "";

    const benefits = c.benefits || null;
    const benefitsStr = benefits
      ? `Rebate MELI: ${benefits.meli_percent ?? "—"}% • Seller: ${
          benefits.seller_percent ?? "—"
        }%`
      : "";

    const isRebate =
      benefits?.type === "REBATE" ||
      isSmartLikePromotionType(c.type);
    const rebateTag = isRebate
      ? '<span class="badge badge-rebate">REBATE</span>'
      : "";

    const cardMenu = isSellerCreated
      ? `<div class="promo-campaign-card__menu">
          <button class="promo-campaign-card__menu-toggle" type="button" data-card-menu-toggle="${esc(
            c.id,
          )}" aria-label="Abrir ações da campanha">?</button>
          ${
            state.openCardMenuId === String(c.id)
              ? `<div class="promo-campaign-card__menu-popover">
                  <button type="button" data-card-edit="${esc(c.id)}">Editar</button>
                  <button type="button" data-card-delete="${esc(c.id)}">Excluir</button>
                </div>`
              : ""
          }
        </div>`
      : "";
    const sellerBadge = isSellerCreated
      ? '<span class="promo-campaign-card__eyebrow">Criada por você</span>'
      : "";
    const cardTitleClass = isSellerCreated
      ? "promo-campaign-card__title promo-campaign-card__title--seller"
      : "promo-campaign-card__title";

    div.innerHTML = `${cardMenu}
      ${sellerBadge}
      <h3 class="${cardTitleClass}">${esc(c.name || c.id || "Campanha")} ${rebateTag}</h3>
      <div class="muted card-subtitle">${esc(c.type || "")} ${pill}</div>
      <div class="muted">${fini ? "Até " + fini : ""}</div>
      ${
        benefitsStr
          ? `<div class="muted" style="margin-top:4px">${benefitsStr}</div>`
          : ""
      }`;

    div.addEventListener("click", (ev) => {
      if (ev.target?.closest?.(".promo-campaign-card__menu")) return;
      selecionarCard(c);
    });
    frag.appendChild(div);
  });

  $cards.innerHTML = "";
  $cards.appendChild(frag);
  destacarCardSelecionado();
}

function destacarCardSelecionado() {
  const $cards = elCards();
  if (PromoCards.highlightSelected) {
    PromoCards.highlightSelected({
      mount: $cards,
      state,
      getCardsByActiveType,
    });
    return;
  }

  $cards
    .querySelectorAll(".promo-campaign-card")
    .forEach((n) => n.classList.remove("promo-campaign-card--active"));

  const baseList = state.cardsFilteredIds
    ? state.cards.filter((c) => state.cardsFilteredIds.has(c.id))
    : state.cards;

  const list = getCardsByActiveType(baseList);

  const idx = list.findIndex((c) => c.id === state.selectedCard?.id);
  if (idx >= 0 && $cards.children[idx]) {
    $cards.children[idx].classList.add("promo-campaign-card--active");
  }
}

// Busca por MLB: filtra cards que possuem promoção para o item
async function filtrarCardsPorMLB(mlb) {
  try {
    const resp = await getJSONAny([
      `/api/promocoes/items/${encodeURIComponent(mlb)}`,
    ]);

    const promos = extractList(resp);

    const idsDoItem = new Set(promos.filter((p) => p && p.id).map((p) => p.id));

    state.cardsFilteredIds = new Set(
      state.cards.filter((c) => idsDoItem.has(c.id)).map((c) => c.id),
    );
    renderCards();

    updateTabsCounts(
      state.cards.filter((c) => state.cardsFilteredIds.has(c.id)),
    );

    const list = state.cards.filter((c) => state.cardsFilteredIds.has(c.id));
    if (list.length === 1) selecionarCard(list[0]);
  } catch (e) {
    console.warn("Falha ao buscar promoções do item (todas as rotas).", e);
    state.cardsFilteredIds = null;
    renderCards();
  }
}

/* ======================== Seleção de card / Tabela ======================== */

async function selecionarCard(card) {
  const previousCampaignId = String(state.selectedCard?.id || "");
  const nextCampaignId = String(card?.id || "");

  state.selectedCard = {
    id: card.id,
    type: (card.type || "").toUpperCase(),
    name: card.name || card.id,
    benefits: card.benefits || null,
  };

  if (previousCampaignId !== nextCampaignId) {
    resetCampaignOperationalState({ clearCard: false, keepMlbFilter: true });
  } else {
    invalidateManualApplyWizard({ keepPercent: false });
    state.promotionBenefits = null;
    state.paging = {
      total: 0,
      limit: PAGE_SIZE,
      tokensByPage: { 1: null },
      currentPage: 1,
      lastPageKnown: 1,
    };
  }

  destacarCardSelecionado();
  hideLeadingRebateColumnIfPresent();
  applyRebateHeaderTooltip();
  updateSelectedCampaignName();
  updateSellerCampaignControls();
  updateDealControls();
  updateDiscountFilterUi();
  applyOperationModeUi();

  syncPromoBulkContext();

  if (state.mlbFilter) {
    await carregarSomenteMLBSelecionado(); // modo busca unitária
  } else {
    await carregarItensPagina(1, true);
  }
}

function qsBuild(params) {
  if (PromoState.qsBuild) {
    return PromoState.qsBuild(params);
  }
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  return entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}
function filtroToStatusParam() {
  if (PromoState.filtroToStatusParam) {
    return PromoState.filtroToStatusParam(state);
  }
  const v = String(state.filtroParticipacao || "all").toLowerCase();

  // Participantes
  if (["yes", "participantes", "participante", "started"].includes(v)) {
    return "started";
  }

  // Não participantes
  if (
    [
      "non",
      "nao",
      "não",
      "nao_participantes",
      "nao-participantes",
      "candidate",
    ].includes(v)
  ) {
    return "candidate";
  }

  // Programados / Agendados
  if (
    ["prog", "programados", "agendados", "pending", "scheduled"].includes(v)
  ) {
    return "pending";
  }

  return "";
}

async function fetchPromotionItemsBatch({ token = null, statusParam = "" } = {}) {
  const qs = qsBuild({
    limit: PAGE_FETCH_BATCH_SIZE,
    ...(statusParam ? { status: statusParam } : {}),
    ...(token ? { search_after: token } : {}),
  });

  const data = await getJSONAny(
    itemsPaths(state.selectedCard.id, state.selectedCard.type, qs),
  );
  if (data?.promotion_benefits)
    state.promotionBenefits = data.promotion_benefits;
  return data;
}

async function collectFilteredItemsForPage(targetPage, statusParam = "") {
  const needed = Math.max(1, targetPage) * PAGE_SIZE;
  const filtered = [];
  const seen = new Set();
  let token = null;
  let hasMore = true;
  let rawTotal = 0;
  let scanned = 0;

  while (filtered.length < needed && hasMore && scanned < PAGE_FETCH_SCAN_LIMIT) {
    const data = await fetchPromotionItemsBatch({ token, statusParam });
    rawTotal = Number(data?.paging?.total ?? rawTotal ?? 0);
    const nextToken = data?.paging?.searchAfter || null;
    let batch = Array.isArray(data.results) ? data.results : [];

    batch = batch.map((x) => ({ ...x, status: normalizeStatus(x.status) }));
    batch = dedupeByMLB(batch, statusParam || "");

    if (state.mlbFilter) {
      const mlbUp = state.mlbFilter.toUpperCase();
      batch = batch.filter((x) => (x.id || "").toUpperCase() === mlbUp);
    }
    const listMlbSet = activeScopedMlbSet();
    if (listMlbSet) {
      batch = batch.filter((x) => listMlbSet.has(String(x.id || x.item_id || "").toUpperCase()));
    }

    state.items = batch;
    await hydrateDealCandidateSuggestions(state.items, { skipRender: true });
    batch = Array.isArray(state.items) ? state.items.slice() : [];

    batch = batch.filter((x) =>
      itemMatchesDiscountFilter(
        x,
        state.promotionBenefits || state.selectedCard?.benefits || null,
      ),
    );
    batch = batch.filter(itemMatchesStockFilter);

    for (const item of batch) {
      const id = String(item?.id || "").toUpperCase();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      filtered.push(item);
      if (filtered.length >= needed) break;
    }

    token = nextToken;
    hasMore = !!nextToken;
    scanned += 1;
  }

  const start = (Math.max(1, targetPage) - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);
  const estimatedTotal = hasMore
    ? Math.max(filtered.length + PAGE_SIZE, needed + PAGE_SIZE)
    : filtered.length;

  return {
    items: pageItems,
    total: state.manualWizard?.verified
      ? Number(state.manualWizard.eligibleTotal || estimatedTotal)
      : estimatedTotal || rawTotal || pageItems.length,
    scanned,
    hasMore,
  };
}

async function carregarItensPagina(pageNumber, reset = false) {
  const $body = elTbody();
  if (!state.selectedCard) {
    $body.innerHTML = `<tr><td colspan="9" class="muted">Clique em um card de promoção.</td></tr>`;
    setLoading(false, "Selecione uma campanha para carregar os itens.");
    return;
  }
  if (reset) {
    state.paging.tokensByPage = { 1: null };
    state.paging.currentPage = 1;
    state.paging.lastPageKnown = 1;
    $body.innerHTML = `<tr><td colspan="9" class="muted">Carregando itens…</td></tr>`;
  }

  state.loading = true;
  setLoading(
    true,
    `Carregando itens da campanha ${state.selectedCard?.name || state.selectedCard?.id || ""}...`,
  );
  renderPaginacao();

  const targetPage = Math.max(1, pageNumber | 0);
  let haveToken = state.paging.tokensByPage[targetPage] !== undefined;

  const statusParam = filtroToStatusParam();

  try {
    if (state.maxDesc != null) {
      const filled = await collectFilteredItemsForPage(targetPage, statusParam);
      state.items = filled.items;
      state.paging.total = Number(filled.total || state.items.length || 0);
      state.paging.currentPage = targetPage;
      state.paging.lastPageKnown = Math.max(
        state.paging.lastPageKnown || 1,
        targetPage + (filled.hasMore ? 1 : 0),
      );

      renderTabela(state.items);
      renderPaginacao();
      applyRebateHeaderTooltip();

      setLoading(
        false,
        `${state.items.length} item(ns) elegivel(is) carregado(s) na pagina ${targetPage}.`,
      );
      return;
    }

    while (!haveToken) {
      const prev = state.paging.lastPageKnown;
      const prevToken = state.paging.tokensByPage[prev] ?? null;

      const qs = qsBuild({
        limit: PAGE_SIZE,
        ...(statusParam ? { status: statusParam } : {}),
        ...(prevToken ? { search_after: prevToken } : {}),
      });

      const data = await getJSONAny(
        itemsPaths(state.selectedCard.id, state.selectedCard.type, qs),
      );

      const nextToken = data?.paging?.searchAfter || null;
      const total = data?.paging?.total ?? 0;
      if (data?.promotion_benefits)
        state.promotionBenefits = data.promotion_benefits;

      state.paging.total = total;
      state.paging.tokensByPage[prev + 1] = nextToken;
      state.paging.lastPageKnown = prev + 1;

      haveToken = state.paging.tokensByPage[targetPage] !== undefined;
      if (!nextToken) break;
    }

    const token = state.paging.tokensByPage[targetPage] ?? null;
    const qs = qsBuild({
      limit: PAGE_SIZE,
      ...(statusParam ? { status: statusParam } : {}),
      ...(token ? { search_after: token } : {}),
    });

    const data = await getJSONAny(
      itemsPaths(state.selectedCard.id, state.selectedCard.type, qs),
    );
    if (data?.promotion_benefits)
      state.promotionBenefits = data.promotion_benefits;

    let items = Array.isArray(data.results) ? data.results : [];

    items = items.map((x) => ({ ...x, status: normalizeStatus(x.status) }));
    items = dedupeByMLB(items, statusParam || "");

    if (state.mlbFilter) {
      const mlbUp = state.mlbFilter.toUpperCase();
      items = items.filter((x) => (x.id || "").toUpperCase() === mlbUp);
    }

    state.items = items;
    await hydrateDealCandidateSuggestions(state.items, { skipRender: true });
    items = Array.isArray(state.items) ? state.items.slice() : [];

    if (state.maxDesc != null) {
      items = items.filter((x) =>
        itemMatchesDiscountFilter(
          x,
          state.promotionBenefits || state.selectedCard?.benefits || null,
        ),
      );
    }

    state.items = items;
    state.paging.total = data?.paging?.total ?? state.paging.total;
    state.paging.currentPage = targetPage;

    renderTabela(state.items);
    renderPaginacao();
    applyRebateHeaderTooltip();

    setLoading(
      false,
      `${state.items.length} item(ns) carregado(s) na página ${targetPage}.`,
    );
  } catch (e) {
    const isAuth = e?.cause?.status === 401 || e?.cause?.status === 403;
    const authMsg = isAuth
      ? "Sua sessão com o Mercado Livre expirou ou não é de usuário. Clique em “Trocar Conta” e reconecte."
      : "Falha ao listar itens (ver console).";

    console.error("[carregarItensPagina] erro:", e, e?.cause);

    const code = e?.cause?.status ? ` (HTTP ${e.cause.status})` : "";
    const snippet = e?.cause?.body ? String(e.cause?.body).slice(0, 180) : "";
    $body.innerHTML =
      `<tr><td colspan="9" class="muted">${esc(authMsg + code)}</td></tr>` +
      (snippet
        ? `<tr><td colspan="9"><pre class="muted" style="white-space:pre-wrap">${esc(
            snippet,
          )}</pre></td></tr>`
        : "");
  } finally {
    state.loading = false;
    renderPaginacao();
    atualizarFaixaSelecaoCampanha();
    renderManualApplyWizard();
  }
}

function renderTabela(items) {
  const $body = elTbody();
  const table = getTable();
  const typeUp = (state.selectedCard?.type || "").toUpperCase();
  const isSmartLike = isSmartLikePromotionType(typeUp);
  const isDealLike = isDealRangePromotionType(typeUp);
  const isLightning = typeUp === "LIGHTNING";
  updatePromotionTableHeader(typeUp);
  table?.classList.toggle("table--smart-listing", isSmartLike);
  table?.classList.toggle("table--deal-listing", isDealLike);
  table?.classList.toggle("table--lightning-listing", isLightning);

  const selectedBefore = new Set(
    getSelecionados().map((mlb) => String(mlb || "").toUpperCase()),
  );
  const headerCheckbox = document.getElementById("checkAll");
  const headerWasChecked = !!headerCheckbox?.checked;
  if (!items?.length) {
    if (PromoTable.renderEmptyState) {
      PromoTable.renderEmptyState($body, "Nenhum item para esta página.");
    } else {
      $body.innerHTML = `<tr><td colspan="${isLightning ? 10 : 9}" class="muted">Nenhum item para esta página.</td></tr>`;
    }
    if (headerCheckbox) headerCheckbox.checked = false;
    window.PromoBulk?.onHeaderToggle?.(false);
    renderManualApplyWizard();
    return;
  }

  const benefitsGlobal =
    state.promotionBenefits || state.selectedCard?.benefits || null;

  const rows = items
    .map((it) => {
      const mlb = it.id || "";
      const est = displayStockValue(it);
      const availableStock = displayAvailableStockValue(it);
      const sku = it.seller_custom_field ?? it.sku ?? "—";
      const original = toNum(it.original_price ?? it.price ?? null);

      // Resolver base e % com o helper (traz flag estimated)
      const res = resolveDealFinalAndPctFront({
        original_price: original,
        promotion_type: typeUp,
        status: it.status,
        deal_price: it.deal_price ?? it.new_price,
        min_discounted_price: it.min_discounted_price,
        max_discounted_price: it.max_discounted_price,
        price: it.price,
        discount_percentage: it.discount_percentage,
      });

      const mlResolvedFinal =
        res.final ??
        toNum(it._resolved_final_price) ??
        safeDealPrice(
          {
            ...it,
            promotion_type: typeUp,
          },
          original,
        );
      const itemStatus = normalizeStatus(it.status);
      const isDealCandidateLike =
        typeUp === "DEAL" &&
        ["candidate", "pending", "scheduled"].includes(itemStatus);
      const dealRange =
        typeUp === "DEAL" ||
        typeUp === "SELLER_CAMPAIGN" ||
        typeUp === "LIGHTNING"
          ? computeDealDiscountRange({
              ...it,
              original_price: original,
            })
          : null;
      const dealManualPct =
        typeUp === "DEAL"
          ? getDealManualPercent()
          : typeUp === "SELLER_CAMPAIGN"
            ? getSellerManualPercent()
            : typeUp === "LIGHTNING"
              ? getDealManualPercent()
            : null;
      const dealManualAllowed =
        (typeUp === "DEAL" || typeUp === "SELLER_CAMPAIGN" || typeUp === "DOD" || typeUp === "LIGHTNING") &&
        dealManualPct != null
          ? isDealPercentWithinRange(
              {
                ...it,
                original_price: original,
              },
              dealManualPct,
            )
          : false;
      let basePrice = mlResolvedFinal;
      let descPct = isDealCandidateLike ? null : toNum(it.discount_percentage);

      if (isStrictDealCandidate(it)) {
        basePrice = null;
        descPct = null;
      }

      if (typeUp === "SELLER_CAMPAIGN") {
        const manualPct = getSellerManualPercent();
        const manualPrice =
          manualPct != null
            ? computeDealPriceFromPercent(original, manualPct)
            : null;
        if (manualPrice != null) {
          basePrice = manualPrice;
          it.__sellerManualPreview = true;
        } else {
          delete it.__sellerManualPreview;
        }
      }

      if (typeUp === "DEAL" && isDealCandidateLike) {
        if (dealManualAllowed) {
          basePrice = computeDealPriceFromPercent(original, dealManualPct);
          descPct = dealManualPct;
          it.__dealManualPreview = true;
        } else {
          delete it.__dealManualPreview;
          basePrice = null;
          descPct = null;
        }
      }

      if (isSmartLike && original != null) {
        const rb = pickRebate(it);
        const m =
          toNum(it.meli_percentage) ??
          toNum(it.rebate_meli_percent) ??
          toNum(rb.meli) ??
          toNum(benefitsGlobal?.meli_percent);

        const s =
          toNum(it.seller_percentage) ??
          toNum(rb.seller) ??
          toNum(benefitsGlobal?.seller_percent);

        const tot = toNum((m || 0) + (s || 0));
        if (descPct == null && (m != null || s != null)) descPct = tot;

        if (basePrice == null && descPct != null) {
          basePrice = original * (1 - descPct / 100);
        }

        // compat visual
        if (it.rebate_meli_percent == null && m != null)
          it.rebate_meli_percent = m;
      }

      if (isDealLike) {
        if (isDealCandidateLike) {
          descPct = res.pct != null ? res.pct : null;
        } else if (res.pct != null) {
          descPct = res.pct;
        }

        // correção de discrepância absurda
        if (
          descPct != null &&
          descPct > 70 &&
          basePrice != null &&
          original > 0
        ) {
          const recompute = (1 - basePrice / original) * 100;
          if (Math.abs(recompute - descPct) > 5) descPct = recompute;
        }
      } else if (
        descPct == null &&
        original != null &&
        basePrice != null &&
        original > 0
      ) {
        descPct = (1 - basePrice / original) * 100;
      }

      const precoAtual = original != null ? fmtMoeda(original) : "—";

      // “Novo preço” (heurístico)
      const novoPreco =
        basePrice != null
          ? res.estimated
            ? `˜ ${fmtMoeda(basePrice)}`
            : fmtMoeda(basePrice)
          : "—";
      const novoPrecoDisplay = novoPreco;

      let dealVisualControls = null;
      if (
        (typeUp === "DEAL" ||
          typeUp === "SELLER_CAMPAIGN" ||
          typeUp === "LIGHTNING") &&
        dealRange &&
        (dealRange.minPct != null || dealRange.maxPct != null)
      ) {
        const rangeDefaults = normalizeDealSliderRange(
          dealRange.minPct ?? 0,
          dealRange.maxPct ?? 99,
        );
        const visualKey = dealRangeDraftKey(mlb);
        const visualState = getDealRangeVisualState(visualKey, {
          ...rangeDefaults,
          defPct:
            dealManualPct != null
              ? dealManualPct
              : descPct != null
                ? descPct
                : Math.round((rangeDefaults.minPct + rangeDefaults.maxPct) / 2),
        });
        dealVisualControls = {
          key: visualKey,
          discount: buildDealDiscountControl({
            key: visualKey,
            minPct: visualState.minPct,
            maxPct: visualState.maxPct,
            defPct: visualState.defPct,
          }),
          price: buildDealPriceControl({
            key: visualKey,
            original,
            minPct: visualState.minPct,
            maxPct: visualState.maxPct,
            defPct: visualState.defPct,
          }),
        };
      } else if (
        (typeUp === "DEAL" ||
          typeUp === "SELLER_CAMPAIGN" ||
          typeUp === "LIGHTNING") &&
        descPct != null &&
        basePrice != null
      ) {
        dealVisualControls = {
          key: dealRangeDraftKey(mlb),
          discount: buildDealFixedDiscountControl({ pct: descPct }),
          price: buildDealFixedPriceControl({
            original,
            finalPrice: basePrice,
          }),
        };
      }

      const dealDescMeta = dealVisualControls?.discount || "";
      const dealPriceMeta = dealVisualControls?.price || "";

      const rb = pickRebate(it);
      const meliPct =
        it.meli_percentage != null
          ? Number(it.meli_percentage)
          : it.rebate_meli_percent != null
            ? Number(it.rebate_meli_percent)
            : rb.meli != null
              ? Number(rb.meli)
              : benefitsGlobal?.meli_percent != null
                ? Number(benefitsGlobal.meli_percent)
                : null;

      const hasRebate =
        isSmartLike &&
        (meliPct != null || rb.type === "REBATE" || rb.meli != null);

      const rebateCell = hasRebate
        ? `${
            meliPct != null ? fmtPerc(meliPct, 2) + " " : ""
          }<span class="pill green">REBATE</span>`
        : "—";

      const status = statusLabel(it.status);
      const statusClass = statusClassName(it.status);
      const smartStatusClass =
        normalizeStatus(it.status) === "started"
          ? "smart-status smart-status--started"
          : "smart-status";
      const stockClass =
        est === "—"
          ? "metric-chip metric-chip--stock is-empty"
          : "metric-chip metric-chip--stock";
      const stockCellContent =
        typeUp === "LIGHTNING"
          ? `<span class="${
              availableStock === "—"
                ? "metric-chip metric-chip--stock is-empty"
                : "metric-chip metric-chip--stock"
            }">${esc(availableStock)}</span>`
          : `<span class="${stockClass}">${esc(est)}</span>`;
      const lightningQuantityCell = typeUp === "LIGHTNING"
        ? `<td class="table-quantity-cell">${buildLightningStockControl(mlb, it)}</td>`
        : "";
      const skuClass =
        sku === "—"
          ? "metric-chip metric-chip--sku is-empty"
          : "metric-chip metric-chip--sku";

      if (isSmartLike) {
        return `<tr class="promo-table__row promo-table__row--smart">
          <td class="table-check-cell"><input type="checkbox" data-mlb="${esc(
            mlb,
          )}"></td>
          <td class="smart-product-cell">
            <strong class="smart-product-cell__mlb">${esc(mlb)}</strong>
            <span class="smart-product-cell__sku">SKU ${esc(sku)}</span>
          </td>
          <td class="table-stock-cell">${stockCellContent}</td>
          <td class="table-price-cell"><span class="smart-money">${precoAtual}</span></td>
          <td class="table-desc-cell"><span class="smart-discount-pill">${descPct != null ? fmtPerc(descPct, 2) : "—"}</span></td>
          <td class="table-rebate-cell"><span class="smart-rebate-pill">${meliPct != null ? fmtPerc(meliPct, 2) : "—"}</span></td>
          <td class="table-new-price-cell">
            <span class="smart-new-price">${novoPrecoDisplay}</span>
            <span class="smart-old-price">${precoAtual}</span>
          </td>
          <td class="table-status-cell"><span class="${smartStatusClass}">${esc(status)}</span></td>
          <td class="table-actions-cell">
            <div class="table-actions-stack table-actions-stack--smart">
              <button type="button" class="smart-apply-btn" onclick='aplicarUnico(${jsStr(
                mlb,
              )})'>Aplicar</button>
              <button type="button" class="btn ghost btn-remove-inline" onclick='removerUnicoDaCampanha(${jsStr(
                mlb,
              )})'>Remover</button>
            </div>
          </td>
        </tr>`;
      }

      if (isDealLike) {
        const allowedPct =
          dealManualPct != null
            ? dealManualPct
            : descPct != null
              ? descPct
              : dealRange?.minPct ?? null;
        const dealStatusClass =
          normalizeStatus(it.status) === "started"
            ? "smart-status smart-status--started"
            : "smart-status";
        const newPriceMain =
          basePrice != null
            ? `<span class="smart-new-price">${novoPrecoDisplay}</span>`
            : "";

        return `<tr class="promo-table__row promo-table__row--deal" data-deal-row-key="${esc(
          dealVisualControls?.key || dealRangeDraftKey(mlb),
        )}" data-deal-original="${esc(original ?? "")}">
          <td class="table-check-cell"><input type="checkbox" data-mlb="${esc(
            mlb,
          )}"></td>
          <td class="smart-product-cell">
            <strong class="smart-product-cell__mlb">${esc(mlb)}</strong>
            <span class="smart-product-cell__sku">SKU ${esc(sku)}</span>
          </td>
          <td class="table-stock-cell">${stockCellContent}</td>
          ${lightningQuantityCell}
          <td class="deal-sku-cell">${esc(sku)}</td>
          <td class="table-price-cell"><span class="smart-money">${precoAtual}</span></td>
          <td class="table-desc-cell">
            ${dealDescMeta || `<span class="deal-allowed-percent">${allowedPct != null ? fmtPerc(allowedPct, 2) : "—"}</span>`}
          </td>
          <td class="table-new-price-cell">
            ${dealPriceMeta || newPriceMain || '<span class="muted">—</span>'}
          </td>
          <td class="table-status-cell"><span class="${dealStatusClass}">${esc(status)}</span></td>
          <td class="table-actions-cell">
            <div class="table-actions-stack table-actions-stack--deal">
              <button type="button" class="smart-apply-btn" onclick='aplicarUnico(${jsStr(
                mlb,
              )})'>Aplicar</button>
              <button type="button" class="btn ghost btn-remove-inline" onclick='removerUnicoDaCampanha(${jsStr(
                mlb,
              )})'>Remover</button>
            </div>
          </td>
        </tr>`;
      }

      // IMPORTANTE: onclick seguro (não usa esc(), usa jsStr())
      return `<tr class="promo-table__row">
        <td class="table-check-cell" style="text-align:center"><input type="checkbox" data-mlb="${esc(
          mlb,
        )}"></td>
        <td class="table-id-cell">
          <div class="mlb-badge">
            <span class="mlb-badge__eyebrow">Anuncio</span>
            <strong class="mlb-badge__value">${esc(mlb)}</strong>
          </div>
        </td>
        <td class="table-stock-cell">${stockCellContent}</td>
        <td class="table-sku-cell"><span class="${skuClass}">${esc(sku)}</span></td>
        <td class="table-price-cell"><span class="table-cell-main table-cell-main--money">${precoAtual}</span></td>
        <td class="table-desc-cell"><span class="table-cell-main table-cell-main--percent">${descPct != null ? fmtPerc(descPct, 2) : "—"}</span>${dealDescMeta}</td>
        <td class="table-new-price-cell"><span class="table-cell-main table-cell-main--money">${novoPrecoDisplay}</span>${
          typeUp === "DEAL" || typeUp === "SELLER_CAMPAIGN" ? dealPriceMeta : ""
        }</td>
        <td class="table-status-cell"><span class="${statusClass}">${esc(status)}</span></td>
        <td class="table-actions-cell" style="text-align:right">
          <div class="table-actions-stack">
          <button type="button" class="btn primary" onclick='aplicarUnico(${jsStr(
            mlb,
          )})'>Aplicar</button>
          <button type="button" class="btn ghost" onclick='removerUnicoDaCampanha(${jsStr(
            mlb,
          )})'>Remover</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");

  $body.innerHTML = rows;

  const rowChecks = $$('#tbody input[type="checkbox"][data-mlb]');
  rowChecks.forEach((ch) => {
    if (selectedBefore.has(String(ch.dataset.mlb || "").toUpperCase())) {
      ch.checked = true;
    }
  });
  if (headerCheckbox) {
    const allChecked =
      rowChecks.length > 0 && rowChecks.every((ch) => ch.checked);
    headerCheckbox.checked =
      allChecked || (headerWasChecked && rowChecks.length > 0);
    if (!allChecked && selectedBefore.size < rowChecks.length) {
      headerCheckbox.checked = false;
    }
  }
  window.PromoBulk?.onHeaderToggle?.(!!headerCheckbox?.checked);

  if (window.PromoBulk && state.selectedCard) {
    window.PromoBulk.setContext({
      promotion_id: state.selectedCard.id,
      promotion_type: state.selectedCard.type,
      promotion_name: state.selectedCard.name || state.selectedCard.id,
      filtroParticipacao: state.filtroParticipacao,
      maxDesc: state.maxDesc,
      mlbFilter: state.mlbFilter,
      mlbsFilter: activeScopedMlbsForPrepare(),
    });
  }
  renderManualApplyWizard();
}

function updateSelectedCampaignName() {
  const el = document.getElementById("campName");
  if (PromoCards.updateSelectedCampaignName) {
    PromoCards.updateSelectedCampaignName({ state, element: el });
    return;
  }

  if (!el) return;
  if (state.selectedCard) {
    const name = state.selectedCard.name || state.selectedCard.id;
    el.textContent = `Campanha: “${name}”`;
    el.title = name;
  } else {
    el.textContent = "";
    el.removeAttribute("title");
  }
  updateDebugMlbMeta();
}

function syncPromoBulkContext() {
  if (PromoBulkBridge.sync) {
    PromoBulkBridge.sync(state);
    return;
  }

  if (!window.PromoBulk || !state.selectedCard) return;
  window.PromoBulk.setContext({
    promotion_id: state.selectedCard.id,
    promotion_type: state.selectedCard.type,
    promotion_name: state.selectedCard.name || state.selectedCard.id,
    filtroParticipacao: state.filtroParticipacao,
    maxDesc: state.maxDesc,
    mlbFilter: state.mlbFilter,
    mlbsFilter: activeScopedMlbsForPrepare(),
  });
}

function renderPaginacao() {
  const $pag = elPag();
  if (!$pag) return;
  if (PromoTable.renderPagination) {
    PromoTable.renderPagination({
      mount: $pag,
      paging: state.paging,
      pageSize: PAGE_SIZE,
      loading: state.loading,
      onPageName: "goPage",
    });
    return;
  }

  if (state.loading) return;
  $pag.innerHTML = "";
  const total = Number(state.paging.total || 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cur = state.paging.currentPage;

  const MAX_BTNS = 9;
  let start = Math.max(1, cur - Math.floor(MAX_BTNS / 2));
  let end = Math.min(pages, start + MAX_BTNS - 1);
  start = Math.max(1, end - MAX_BTNS + 1);

  const btn = (p, label = String(p), disabled = false, active = false) =>
    `<button class="page-btn${active ? " active" : ""}" ${
      disabled ? "disabled" : ""
    } onclick="goPage(${p})">${label}</button>`;

  let html = "";
  html += btn(Math.max(1, cur - 1), "‹", cur === 1);
  if (start > 1) {
    html += btn(1, "1", false, cur === 1);
    if (start > 2) html += `<span class="muted" style="padding:0 6px">…</span>`;
  }
  for (let p = start; p <= end; p++) {
    html += btn(p, String(p), false, p === cur);
  }
  if (end < pages) {
    if (end < pages - 1) {
      html += `<span class="muted" style="padding:0 6px">…</span>`;
    }
    html += btn(pages, String(pages), false, cur === pages);
  }
  html += btn(Math.min(pages, cur + 1), "›", cur === pages);

  $pag.innerHTML = html;
}

/* ======================== Busca unitária por MLB ======================== */

async function montarItemRapido(mlb) {
  // 1) Busca todas as promoções do item e localiza a campanha selecionada
  const resp = await getJSONAny([
    `/api/promocoes/items/${encodeURIComponent(mlb)}`,
  ]);

  const promos = extractList(resp);

  const sel = state.selectedCard;
  const match = promos.find((p) => p && p.id === sel?.id) || null;
  if (!match) return null;

  // 2) Tenta enriquecer com dados básicos do item
  let b = null;
  try {
    b = await getJSONAny([
      `/api/items/brief?ids=${encodeURIComponent(mlb)}`,
      `/api/items/basic?ids=${encodeURIComponent(mlb)}`,
    ]);
    if (Array.isArray(b)) {
      const hit = b.find((x) => x.id === mlb || x?.body?.id === mlb);
      b = hit?.body || hit || null;
    }
  } catch (_) {
    /* opcional */
  }

  // 3) Seleciona uma oferta relevante (se existir)
  const offer =
    Array.isArray(match.offers) && match.offers[0] ? match.offers[0] : {};

  // 4) Monta estrutura base para cálculo
  const tmp = {
    id: mlb,
    title: b?.title || match?.title || offer?.title || "—",
    available_quantity:
      b?.available_quantity ??
      offer?.available_quantity ??
      match?.available_quantity ??
      null,
    seller_custom_field:
      b?.seller_custom_field ??
      offer?.seller_custom_field ??
      match?.seller_custom_field ??
      null,

    // preços candidatos
    original_price: toNum(
      offer.original_price ?? match.original_price ?? b?.price ?? null,
    ),
    deal_price: toNum(
      offer.deal_price ??
        offer.new_price ??
        offer.price ??
        match.deal_price ??
        match.price ??
        match.new_price ??
        null,
    ),
    // desconto reportado (quando vier)
    discount_percentage: toNum(
      offer.discount_percentage ?? match.discount_percentage ?? null,
    ),

    // campos candidatos para DEAL/SELLER
    min_discounted_price: toNum(
      offer.min_discounted_price ?? match.min_discounted_price ?? null,
    ),
    max_discounted_price: toNum(
      offer.max_discounted_price ?? match.max_discounted_price ?? null,
    ),

    // rebate/percentuais
    meli_percentage: toNum(
      match.meli_percentage ?? offer.meli_percentage ?? null,
    ),
    seller_percentage: toNum(
      match.seller_percentage ?? offer.seller_percentage ?? null,
    ),

    // status do item nesta campanha
    status: normalizeStatus(offer?.status || match.status || "—"),

    // benefits brutos (se houver)
    benefits: match.benefits || offer.benefits || null,
  };

  const selectedTypeUp = String(state.selectedCard?.type || "").toUpperCase();
  if (
    selectedTypeUp === "DEAL" &&
    ["candidate", "pending"].includes(normalizeStatus(tmp.status))
  ) {
    tmp.deal_price = null;
  }

  // Se não tem available_quantity no brief, tenta um fallback neutro
  if (
    tmp.available_quantity == null &&
    typeof b?.available_quantity !== "number"
  ) {
    tmp.available_quantity = "—";
  }
  if (!tmp.seller_custom_field && b?.seller_custom_field == null) {
    tmp.seller_custom_field = "—";
  }

  // 5) Calcula % de desconto usando a mesma regra da tabela (corrige DEAL/SELLER)
  const benefitsGlobal =
    state.promotionBenefits || state.selectedCard?.benefits || null;
  let descPct = computeDescPct(tmp, benefitsGlobal);

  // 6) Se não tem deal_price mas já temos desconto e original, calculamos o deal
  if (tmp.deal_price == null && tmp.original_price != null && descPct != null) {
    tmp.deal_price = round2(tmp.original_price * (1 - descPct / 100));
  }

  // 7) Meli rebate visível (para célula REBATE)
  let rbMeli = tmp.meli_percentage;
  if (rbMeli == null) {
    const rb = pickRebate(tmp);
    rbMeli = toNum(rb.meli ?? benefitsGlobal?.meli_percent ?? null);
  }

  // 8) Retorna no formato esperado pela UI/tabela
  return {
    id: mlb,
    title: tmp.title || "—",
    available_quantity: tmp.available_quantity ?? "—",
    seller_custom_field: tmp.seller_custom_field ?? "—",
    original_price: tmp.original_price ?? null,
    deal_price: tmp.deal_price ?? null,
    discount_percentage: descPct ?? null,
    meli_percentage: tmp.meli_percentage ?? null,
    rebate_meli_percent: rbMeli != null ? Number(rbMeli) : null,
    status: tmp.status || "—",
    benefits: tmp.benefits || undefined,
  };
}

async function buscarItemNaCampanha(mlb) {
  const mlbUp = (mlb || "").toUpperCase();
  let token = null;
  const statusFlag = filtroToStatusParam();
  const shouldSendStatus = !!(statusFlag && statusFlag !== "__pending__");

  for (let i = 0; i < 200; i++) {
    const qsObj = { limit: 50 };
    if (shouldSendStatus) qsObj.status = statusFlag;
    if (token) qsObj.search_after = token;

    const data = await getJSONAny(
      itemsPaths(
        state.selectedCard.id,
        state.selectedCard.type,
        qsBuild(qsObj),
      ),
    );
    if (data?.promotion_benefits)
      state.promotionBenefits = data.promotion_benefits;

    let items = Array.isArray(data.results) ? data.results : [];
    items = items.map((x) => ({ ...x, status: normalizeStatus(x.status) }));
    if (statusFlag === "__pending__") {
      items = items.filter((x) => normalizeStatus(x.status) === "pending");
    }

    const found = items.find((it) => (it.id || "").toUpperCase() === mlbUp);
    if (found) return found;

    token = data?.paging?.searchAfter || null;
    if (!token) break;
  }
  return null;
}
/* ======================== Offer/Candidate helpers ======================== */

function isCandidateId(id) {
  return /^CANDIDATE-[A-Z0-9-]+$/i.test(String(id || ""));
}

function isStrictOfferIdPromotionType(type) {
  const t = String(type || "").toUpperCase();
  return t === "PRE_NEGOTIATED" || t === "UNHEALTHY_STOCK";
}

function getAllOfferLikeIds(it) {
  const set = new Set();
  const add = (v) => {
    if (v) set.add(String(v));
  };

  add(it?.offer_id);
  add(it?.candidate_id);
  add(it?.offer_candidate_id);
  add(it?.candidate?.id);
  add(it?.ref_id);

  if (Array.isArray(it?.offers)) {
    for (const o of it.offers) {
      add(o?.offer_id);
      add(o?.id);
      add(o?.candidate_id);
    }
  }
  return [...set];
}

function extractCandidateIdFromItem(it) {
  if (isCandidateId(it?.candidate_id)) return String(it.candidate_id);
  if (Array.isArray(it?.offers)) {
    const cand = it.offers.find(
      (o) => isCandidateId(o?.id) || isCandidateId(o?.candidate_id),
    );
    if (cand) return String(cand.candidate_id || cand.id);
  }
  if (isCandidateId(it?.offer_candidate_id))
    return String(it.offer_candidate_id);
  if (isCandidateId(it?.candidate?.id)) return String(it.candidate.id);
  if (isCandidateId(it?.ref_id)) return String(it.ref_id);
  return null;
}

async function buscarOfferIdViaBackend(mlb, opts = {}) {
  try {
    const data = await getJSONAny(offerIdsPaths(mlb, opts));
    const ids = Array.isArray(data?.offer_ids) ? data.offer_ids : [];
    const allowCandidateAsOffer = !!opts.allowCandidateAsOffer;
    return (
      ids.find((id) => !isCandidateId(id)) ||
      (allowCandidateAsOffer ? ids.find((id) => isCandidateId(id)) : null) ||
      null
    );
  } catch {
    return null;
  }
}

async function buscarOfferIdCandidate(mlb, opts = {}) {
  let token = null;
  const wanted = String(mlb || "").toUpperCase();
  const allowCandidateAsOffer = !!opts.allowCandidateAsOffer;
  for (let i = 0; i < 200; i++) {
    const qs = qsBuild({
      limit: 50,
      status: "candidate",
      ...(token ? { search_after: token } : {}),
    });
    const data = await getJSONAny(
      itemsPaths(state.selectedCard.id, state.selectedCard.type, qs),
    );
    const items = Array.isArray(data?.results) ? data.results : [];
    const found = items.find(
      (x) => String(x?.id || "").toUpperCase() === wanted,
    );
    if (found) {
      const ids = getAllOfferLikeIds(found);
      const cid = ids.find(isCandidateId) || null;
      const off =
        ids.find((id) => !isCandidateId(id)) ||
        (allowCandidateAsOffer ? ids.find(isCandidateId) : null) ||
        null;
      return { candidateId: cid, offerId: off };
    }
    token = data?.paging?.searchAfter || null;
    if (!token) break;
  }
  return { candidateId: null, offerId: null };
}

async function resolvePromotionOfferContext(
  mlb,
  it,
  { strictOffer = false } = {},
) {
  const typeUp = String(state.selectedCard?.type || "").toUpperCase();
  const isSmartLike = isSmartLikePromotionType(typeUp);
  const idsFromItem = getAllOfferLikeIds(it);
  let candidateId = extractCandidateIdFromItem(it);
  let offerId =
    idsFromItem.find((id) => !isCandidateId(id)) ||
    (isSmartLike ? idsFromItem.find((id) => isCandidateId(id)) : null) ||
    null;
  const allowCandidateAsOffer =
    isSmartLike ||
    (strictOffer && isStrictOfferIdPromotionType(state.selectedCard?.type));
  const lookupOpts = {
    promotion_id: state.selectedCard?.id || null,
    promotion_type: state.selectedCard?.type || null,
    candidate_id: candidateId || null,
    allowCandidateAsOffer,
  };

  if (!offerId) {
    offerId = await buscarOfferIdViaBackend(mlb, lookupOpts);
  }

  if ((!candidateId && !strictOffer) || !offerId) {
    const found = await buscarOfferIdCandidate(mlb, { allowCandidateAsOffer });
    candidateId = candidateId || found.candidateId;
    offerId = offerId || found.offerId;
  }

  return { candidateId, offerId };
}

/* ======================== Ações: aplicar/remover ======================== */

function calcDealPriceFromItem(it) {
  if (PromoActions.calcDealPriceFromItem) {
    return PromoActions.calcDealPriceFromItem(it, {
      state,
      toNum,
      round2,
      resolveDealFinalAndPctFront,
      resolveDealManualPrice,
    });
  }
  const orig = toNum(it.original_price ?? it.price ?? null);
  const typeUp = (state.selectedCard?.type || "").toUpperCase();

  if (typeUp === "DEAL" || typeUp === "DOD" || typeUp === "LIGHTNING") {
    const manual = resolveDealManualPrice(it, { silent: true });
    if (manual != null) return round2(manual);
  }

  if (isDealRangePromotionType(typeUp)) {
    const { final } = resolveDealFinalAndPctFront({
      original_price: orig,
      promotion_type: typeUp,
      status: it.status,
      deal_price: it.deal_price ?? it.new_price,
      min_discounted_price: it.min_discounted_price,
      max_discounted_price: it.max_discounted_price,
      price: it.price,
    });
    if (final != null) return round2(final);
    if (typeUp === "DEAL") return null;
  }

  // Demais tipos / fallback
  const deal = toNum(it.deal_price ?? null);
  let d = toNum(it.discount_percentage);
  if (!Number.isNaN(deal) && deal != null) return round2(deal);
  if (orig != null && d != null) return round2(orig * (1 - d / 100));
  return null;
}

/* --- aplicarUnico (orig) --- mantido para botões da UI (opera no item já visível) */
async function aplicarUnico(mlb, opts = {}) {
  const silent = !!opts.silent;
  if (!state.selectedCard) {
    if (!silent) notifyPromocoes("Selecione uma campanha.");
    return false;
  }

  const it = state.items.find(
    (x) => (x.id || "").toUpperCase() === (mlb || "").toUpperCase(),
  );
  if (!it) {
    if (!silent) notifyPromocoes("Item não encontrado na lista atual.");
    return false;
  }

  const selectedType = String(state.selectedCard?.type || "").toUpperCase();
  if (["DEAL", "SELLER_CAMPAIGN", "LIGHTNING", "SMART", "PRE_NEGOTIATED"].includes(selectedType)) {
    const isSmart = selectedType === "SMART";
    const isPreNegotiated = selectedType === "PRE_NEGOTIATED";
    const isCapBasedOffer = isSmart || isPreNegotiated;
    const draftPrice = !isCapBasedOffer && !silent ? getDealRangeDraftPriceForItem(mlb, it) : null;
    const draftPercent =
      draftPrice != null ? getDealRangeDraftForItem(mlb)?.defPct : null;
    const manualPercent = isCapBasedOffer
      ? null
      : draftPercent != null
        ? Number(draftPercent)
        : selectedType === "SELLER_CAMPAIGN"
          ? getSellerManualPercent()
          : getDealManualPercent();
    const offerPercentCap = isCapBasedOffer ? Number(getCurrentApplyPercent()) : null;
    if (isCapBasedOffer && !(offerPercentCap > 0)) {
      if (!silent) {
        notifyPromocoes(
          isPreNegotiated
            ? "Defina o teto maximo do pre-acordo antes de aceitar. Nenhum anuncio foi alterado."
            : "Defina o teto de desconto da Smart antes de aplicar. Nenhum anuncio foi alterado.",
        );
      }
      return false;
    }
    const lightningStock =
      selectedType === "LIGHTNING"
        ? getLightningStockForItem(mlb, it, {
            readDom: !silent,
            useBulk: silent,
          })
        : null;

    if (typeof window.PromoBulk?.applyIds !== "function") {
      if (!silent) {
        notifyPromocoes(
          "O motor seguro de aplicacao ainda nao esta disponivel. Nenhum anuncio foi alterado.",
        );
      }
      return false;
    }
    return window.PromoBulk.applyIds([mlb], {
      promotion_id: state.selectedCard.id,
      promotion_type: selectedType,
      promotion_name: state.selectedCard.name || state.selectedCard.id,
      status: null,
      percentMax: isCapBasedOffer ? offerPercentCap : manualPercent,
      manualPercent,
      lightningStock,
    });
  }

  const t = (state.selectedCard.type || "").toUpperCase();
  if (t === "PRICE_MATCHING_MELI_ALL") {
    if (!silent)
      notifyPromocoes(
        "Esta campanha (PRICE_MATCHING_MELI_ALL) é 100% gerida pelo ML. Aplicação manual indisponível.",
      );
    HUD.bump("errors");
    HUD.tickProcessed();
    return false;
  }

  const payloadBase = {
    promotion_id: state.selectedCard.id,
    promotion_type: t,
    promotion_name: state.selectedCard.name || state.selectedCard.id,
  };

  // inicia HUD se ainda não estiver visível
  if (!state.applySession.started) HUD.open(/* totalHint */ null);

  try {
    let payload = { ...payloadBase };

    if (t === "DOD") {
      let dealPrice = !silent ? getDealRangeDraftPriceForItem(mlb, it) : null;
      const requestedPercent =
        dealPrice != null ? getDealRangeDraftForItem(mlb)?.defPct : getDealManualPercent();
      if (dealPrice == null) dealPrice = calcDealPriceFromItem(it);
      if (dealPrice == null && !silent) {
        const entrada = prompt("Informe o NOVO preço (ex: 99.90):");
        if (!entrada) return false;
        const num = Number(String(entrada).replace(",", "."));
        if (Number.isNaN(num) || num <= 0)
          return (notifyPromocoes("Preço inválido."), false);
        dealPrice = round2(num);
      } else if (dealPrice == null) {
        HUD.tickProcessed();
        return false; // silencioso
      }
      payload.deal_price = dealPrice;
      attachManualPercentGuardPayload(payload, it, requestedPercent);
    } else if (isSmartLikePromotionType(t)) {
      const discountCap = getCurrentApplyPercent();
      if (discountCap != null) payload.max_discount_percent = discountCap;
      const status = normalizeStatus(it.status);
      if (status !== "candidate") {
        if (!silent)
          notifyPromocoes(
            `Este item não está candidato nesta campanha (status: ${
              status || "—"
            }).`,
          );
        HUD.bump("errors");
        HUD.tickProcessed();
        return false;
      }

      // tenta obter ids
      const strictOffer = isStrictOfferIdPromotionType(t);
      const { candidateId, offerId } = await resolvePromotionOfferContext(mlb, it, {
        strictOffer,
      });

      if ((strictOffer && !offerId) || (!strictOffer && !candidateId && !offerId)) {
        if (!silent) {
          notifyPromocoes(
            strictOffer
              ? "O Mercado Livre exige offer_id para aplicar PRE_NEGOTIATED/UNHEALTHY_STOCK, mas esse identificador não foi encontrado para o item."
              : "Candidato não encontrado para este item.",
          );
        }
        HUD.bump("errors");
        HUD.tickProcessed();
        return false;
      }

      // SMART/PRE_NEGOTIATED/PRICE_MATCHING: API atual exige offer_id.
      // Quando vier apenas CANDIDATE-*, enviamos esse valor como offer_id.
      const resolvedOfferId = strictOffer ? offerId : offerId || candidateId || null;
      if (resolvedOfferId) payload.offer_id = resolvedOfferId;
      if (candidateId) payload.candidate_id = candidateId;
    } else if (isStrictOfferIdPromotionType(t)) {
      const { offerId } = await resolvePromotionOfferContext(mlb, it, {
        strictOffer: true,
      });
      if (!offerId) {
        if (!silent) {
          notifyPromocoes(
            "O Mercado Livre exige offer_id para aplicar PRE_NEGOTIATED/UNHEALTHY_STOCK, mas esse identificador não foi encontrado para o item.",
          );
        }
        HUD.bump("errors");
        HUD.tickProcessed();
        return false;
      }
      payload.offer_id = offerId;
    } else {
      // tipos sem extra (MARKETPLACE_CAMPAIGN etc)
    }

    // função auxiliar para enviar
    const doPost = async (pl) => {
      const r = await fetch(
        withPromoBase(`/api/promocoes/items/${encodeURIComponent(mlb)}/apply`),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          credentials: "same-origin",
          body: JSON.stringify(pl),
        },
      );
      let respBody = null;
      try {
        respBody = await r.clone().json();
      } catch {
        respBody = {};
      }
      return { ok: r.ok, status: r.status, body: respBody };
    };

    // 1ª tentativa
    let res = await doPost(payload);

    // fallback: se 400 e mensagem sugerir problema com id -> tenta offer_id explícito
    const bodyMsg = String(
      res?.body?.message || res?.body?.error || "",
    ).toLowerCase();
    const shouldRetryWithOffer =
      !res.ok &&
      res.status === 400 &&
      !("offer_id" in payload) &&
      (bodyMsg.includes("offer") ||
        bodyMsg.includes("candidate") ||
        bodyMsg.includes("invalid") ||
        bodyMsg.includes("not found"));

    if (shouldRetryWithOffer) {
      const { offerId, candidateId } = await resolvePromotionOfferContext(mlb, it);
      const resolvedOfferId = offerId || candidateId || null;
      if (resolvedOfferId) {
        const retryPayload = { ...payload, offer_id: resolvedOfferId };
        res = await doPost(retryPayload);
      }
    }

    if (!res.ok) {
      const causes = Array.isArray(res?.body?.cause)
        ? res.body.cause
            .map((c) => c?.message || c?.code)
            .filter(Boolean)
            .join(" | ")
        : "";
      if (!silent) {
        notifyPromocoes(
          `Erro ao aplicar (${res.status}): ${
            res?.body?.message || res?.body?.error || "bad_request"
          }${causes ? "\nCausa: " + causes : ""}`,
        );
      }
      state.applySession.errors++;
      HUD.tickProcessed();
      return false;
    }

    // sucesso -> estatística
    const prevStatus = normalizeStatus(it.status);
    if (prevStatus === "candidate") state.applySession.added++;
    else state.applySession.changed++;
    // marca localmente como started
    it.status = "started";

    if (!silent) {
      notifyPromocoes("Aplicado com sucesso!");
      if (state.mlbFilter) await carregarSomenteMLBSelecionado();
      else await carregarItensPagina(state.paging.currentPage, true);
    }
    HUD.tickProcessed();
    return true;
  } catch (e) {
    console.error("Erro aplicarUnico:", e);
    state.applySession.errors++;
    if (!silent) notifyPromocoes("Falha ao aplicar (ver console).");
    HUD.tickProcessed();
    return false;
  }
}

window.aplicarUnico = aplicarUnico;

// Aplicacao remota item a item removida: todos os lotes usam o motor de jobs seguro.

async function iniciarJobRemocaoPromocao(mlbs, options = {}) {
  const items = Array.from(
    new Set(
      (Array.isArray(mlbs) ? mlbs : [mlbs])
        .map((id) => String(id || "").trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  if (!items.length) {
    notifyPromocoes("Nenhum item para remover.");
    return false;
  }

  const campaignName =
    state.selectedCard?.name ||
    state.selectedCard?.id ||
    document.getElementById("campName")?.textContent?.replace(/^Campanha:\s*[“"]?/, "").replace(/[”"]?$/, "").trim() ||
    "Campanha";
  const title = options.title || `Removendo promocao • ${campaignName}`;
  let account = { key: "", label: "" };
  try {
    account = await ensurePromoPanelAccount({ force: true });
  } catch {
    /* account context is optional for the local placeholder */
  }

  let localJobId = null;
  try {
    localJobId =
      window.JobsPanel?.addLocalJob?.({
        title,
        accountKey: account.key || null,
        accountLabel: account.label || null,
        state: `queued 0/${items.length}`,
        progress: 0,
      }) || null;
    window.JobsPanel?.show?.();
  } catch {
    /* painel opcional */
  }

  HUD.open(items.length, options.hudTitle || "Remocao em massa");

  try {
    const response = await fetch(withPromoBase("/api/promocoes/jobs/remove"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ items, delay_ms: Number(options.delayMs ?? 250) || 0 }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    if (payload.job_id) {
      const realId = String(payload.job_id);
      JobTitleCache.set(realId, title);
      if (localJobId) window.JobsPanel?.replaceId?.(localJobId, realId);
      window.JobsPanel?.updateLocalJob?.(realId, {
        label: title,
        accountKey: payload?.job?.accountKey || account.key || null,
        accountLabel: payload?.job?.accountLabel || account.label || null,
        state: `active 0/${items.length}`,
        progress: 0,
      });
    }

    state.applySession.removed += items.length;
    state.applySession.processed += items.length;
    HUD.render();
    JobsWatcher.start?.();
    atualizarFaixaSelecaoCampanha();
    renderManualApplyWizard();
    if (!options.silent) {
      notifyPromocoes(`Remocao iniciada para ${items.length} item(ns). Acompanhe no painel de processos.`);
    }
    return true;
  } catch (error) {
    console.error("Erro ao iniciar remocao de promocao:", error);
    if (localJobId) {
      window.JobsPanel?.updateLocalJob?.(localJobId, {
        state: `erro ao iniciar: ${error.message}`,
        progress: 0,
      });
    }
    state.applySession.errors++;
    HUD.render();
    notifyPromocoes("Erro ao iniciar remocao da promocao.");
    return false;
  }
}

async function removerTodosFiltrados(options = {}) {
  if (!state.selectedCard) {
    notifyPromocoes("Selecione uma campanha.");
    return false;
  }
  const items = await coletarTodosIdsFiltrados();
  if (!items.length) {
    notifyPromocoes("Nenhum item filtrado para remover.");
    return false;
  }
  if (!options.skipConfirm) {
    const ok = confirm(
      `Remover a promocao de ${items.length.toLocaleString("pt-BR")} item(ns) filtrado(s)?`,
    );
    if (!ok) return false;
  }
  return iniciarJobRemocaoPromocao(items, {
    title: `Removendo ${state.selectedCard?.type || ""} • ${
      state.selectedCard?.name || state.selectedCard?.id || "Campanha"
    }`,
    hudTitle: "Remocao em massa",
    silent: options.silent,
  });
}

/* --- Remoção em massa (abre HUD e atualiza contadores) --- */
async function removerEmMassaSelecionados() {
  if (PromoActions.removerEmMassaSelecionados) {
    return PromoActions.removerEmMassaSelecionados({
      state,
      HUD,
      withBase: withPromoBase,
      getSelecionados,
      atualizarFaixaSelecaoCampanha,
      coletarTodosIdsFiltrados,
    });
  }
  if (!state.selectedCard) {
    notifyPromocoes("Selecione uma campanha.");
    return;
  }

  let itens = getSelecionados();
  if (!itens.length) {
    const ok = confirm(
      "Nenhum item marcado. Deseja remover TODOS os itens filtrados da campanha?",
    );
    if (!ok) return;
    itens = await coletarTodosIdsFiltrados();
  }
  if (!itens.length) {
    notifyPromocoes("Nenhum item para remover.");
    return;
  }

  // abre HUD
  HUD.open(itens.length, "Remoção em massa");

  try {
    const r = await fetch(withPromoBase("/api/promocoes/jobs/remove"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ items: itens, delay_ms: 250 }),
    });
    const resp = await r.json().catch(() => ({}));
    if (!r.ok || !resp.ok) {
      console.error("Falha ao iniciar remoção em massa", r.status, resp);
      state.applySession.errors++;
      HUD.render();
      notifyPromocoes("Falha ao iniciar remoção em massa.");
      return;
    }
    // não sabemos a evolução do job aqui; apenas marcamos a intenção
    state.applySession.removed += itens.length;
    state.applySession.processed += itens.length;
    HUD.render();
    notifyPromocoes(`Remoção em massa iniciada para ${itens.length} item(ns).`);
  } catch (e) {
    console.error("Erro removerEmMassaSelecionados:", e);
    state.applySession.errors++;
    HUD.render();
    notifyPromocoes("Erro ao iniciar remoção em massa.");
  } finally {
    atualizarFaixaSelecaoCampanha();
  }
}

/* --- Aplicacao em massa: somente pelo motor seguro de jobs --- */
let promoApplySubmitPending = false;
async function aplicarTodosFiltrados() {
  if (!PromoActions.aplicarTodosFiltrados) {
    notifyPromocoes(
      "Motor seguro de aplicacao indisponivel. Nenhum anuncio foi alterado.",
    );
    return false;
  }
  if (promoApplySubmitPending) {
    notifyPromocoes(
      "Esta aplicacao ja esta sendo enviada. Aguarde o numero do job aparecer no painel.",
    );
    return false;
  }

  promoApplySubmitPending = true;
  const buttons = [
    document.getElementById("manualWizardApplyBtn"),
    document.getElementById("selApplyBtn"),
    ...Array.from(document.querySelectorAll(".smart-apply-btn")),
  ].filter(Boolean);
  const buttonStates = buttons.map((button) => ({
    button,
    disabled: button.disabled,
    text: button.textContent,
  }));
  buttons.forEach((button) => {
    button.disabled = true;
    button.classList.add("is-loading");
    if (button.id === "manualWizardApplyBtn" || button.id === "selApplyBtn") {
      button.textContent = "Criando job...";
    }
  });

  try {
    return await PromoActions.aplicarTodosFiltrados({
      state,
      HUD,
      withBase: withPromoBase,
      filtroToStatusParam,
      isSellerCampaignSelected,
      isDealSelected,
      getSellerManualPercent,
      getDealManualPercent,
      sellerManualPercentInput,
      dealManualPercentInput,
      JobTitleCache,
      JobsWatcher,
      coletarTodosIdsFiltrados,
      getPromoBulkState,
      atualizarFaixaSelecaoCampanha,
      isManualWizardVerifiedForCurrent,
      manualWizardListMlbs,
    });
  } finally {
    promoApplySubmitPending = false;
    buttonStates.forEach(({ button, disabled, text }) => {
      button.disabled = disabled;
      button.classList.remove("is-loading");
      button.textContent = text;
    });
    renderManualApplyWizard();
  }
}

async function goPage(n) {
  if (!n || n === state.paging.currentPage) return;
  await carregarItensPagina(n, false);
}
function toggleTodos(master) {
  $$("#tbody input[type='checkbox'][data-mlb]").forEach(
    (ch) => (ch.checked = master.checked),
  );
  if (window.PromoBulk) {
    window.PromoBulk.onHeaderToggle(!!master.checked);
  }
  atualizarFaixaSelecaoCampanha();
  renderManualApplyWizard();
}
function getSelecionados() {
  return $$("#tbody input[type='checkbox'][data-mlb]:checked").map(
    (el) => el.dataset.mlb,
  );
}

function getPromoBulkState() {
  return window.PromoBulk?.getState?.() || null;
}

function getCurrentApplyPercent() {
  if (isSellerCampaignSelected()) return getSellerManualPercent();
  if (isDealSelected()) return getDealManualPercent();
  if (isSmartApplyFlowSelected()) {
    const n = Number(state.maxDesc);
    if (!isValidManualPromoPercent(n)) return null;
    return n;
  }
  return null;
}

function syncPromoBulkMeta(meta = {}) {
  const isLightning =
    String(state.selectedCard?.type || "").toUpperCase() === "LIGHTNING";
  window.PromoBulk?.setMeta?.({
    ...meta,
    lightningStock: isLightning
      ? Number(state.manualWizard?.quantity || 0) || null
      : null,
  });
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function createCsvDownload(filename, header, rows) {
  const content = [header, ...rows]
    .map((cols) => cols.map((col) => csvEscape(col)).join(";"))
    .join("\r\n");
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  return { filename, url };
}

function exportRowsToCsv(filename, header, rows) {
  const download = createCsvDownload(filename, header, rows);
  const a = document.createElement("a");
  a.href = download.url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(download.url), 0);
}

function campaignFilenameSlug() {
  return String(state.selectedCard?.name || state.selectedCard?.id || "campanha")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "");
}

function exportManualWizardListCsv() {
  const diagnostics = Array.isArray(state.manualWizard?.listDiagnostics)
    ? state.manualWizard.listDiagnostics
    : [];
  if (!diagnostics.length) {
    notifyPromocoes("Verifique a lista antes de baixar o CSV.");
    return;
  }
  const header = [
    "Ordem",
    "Entrada",
    "MLB normalizado",
    "Resultado",
    "Aplicavel",
    "Motivo",
    "Campanha ID",
    "Campanha",
    "Tipo",
    "Filtro status",
    "Percentual",
  ];
  const rows = diagnostics.map((row) => [
    row.ordem,
    row.entrada,
    row.mlb,
    row.resultado,
    row.aplicavel,
    row.motivo,
    row.campanha_id,
    row.campanha_nome,
    row.campanha_tipo,
    row.filtro_status,
    row.percentual,
  ]);
  const filename = `${campaignFilenameSlug() || "campanha"}-diagnostico-lista-mlbs.csv`;
  exportRowsToCsv(filename, header, rows);
}

function getCampaignCsvSchema() {
  const typeUp = String(state.selectedCard?.type || "").toUpperCase();
  const baseHeader = [
    "MLB",
    "Titulo",
    "SKU",
    "Estoque total",
    "Preco atual",
    "Desconto atual",
    "Novo preco",
    "Status",
  ];

  if (isSmartLikePromotionType(typeUp)) {
    return {
      type: "smart",
      header: [
        ...baseHeader,
        "Rebate ML %",
        "Rebate seller %",
        "Rebate total %",
      ],
    };
  }

  if (isDealRangePromotionType(typeUp)) {
    const rangeHeader = [
      "Desconto minimo %",
      "Desconto maximo %",
      "Preco minimo",
      "Preco maximo",
      "Desconto definido %",
      "Preco definido",
    ];
    const lightningHeader =
      typeUp === "LIGHTNING"
        ? [
            "Qtd. promo minima",
            "Qtd. promo maxima",
            "Qtd. promo restante",
          ]
        : [];
    return {
      type: typeUp === "LIGHTNING" ? "lightning" : "range",
      header: [...baseHeader, ...rangeHeader, ...lightningHeader],
    };
  }

  return { type: "default", header: baseHeader };
}

function getCsvDefinedPercent(it, typeUp, descPct, range) {
  const manual =
    typeUp === "SELLER_CAMPAIGN"
      ? getSellerManualPercent()
      : ["DEAL", "DOD", "LIGHTNING"].includes(typeUp)
        ? getDealManualPercent()
        : null;
  if (manual != null && isDealPercentWithinRange(it, manual)) return manual;
  if (descPct != null) return descPct;
  return range?.minPct ?? null;
}

function csvStatusLabel(status) {
  const normalized = normalizeStatus(status);
  if (normalized === "candidate") return "Elegivel";
  if (normalized === "pending") return "Programado";
  if (normalized === "started") return "Participando";
  return statusLabel(status);
}

function buildCsvRowFromItem(it, schema = getCampaignCsvSchema()) {
  const benefitsGlobal =
    state.promotionBenefits || state.selectedCard?.benefits || null;
  const typeUp = String(state.selectedCard?.type || "").toUpperCase();
  const original = toNum(it.original_price ?? it.price ?? null);
  const descPct = computeDescPct(it, benefitsGlobal);
  const mlResolvedFinal = safeDealPrice(
    {
      ...it,
      promotion_type: typeUp,
    },
    original,
  );
  const basePrice = mlResolvedFinal;
  const rebate = pickRebate(it);
  const baseRow = [
    it.id || "",
    it.title || "",
    it.seller_custom_field ?? it.sku ?? "",
    it.available_quantity ?? "",
    original != null ? fmtMoeda(original) : "",
    descPct != null ? fmtPerc(descPct, 2) : "",
    basePrice != null ? fmtMoeda(basePrice) : "",
    csvStatusLabel(it.status),
  ];

  if (schema.type === "smart") {
    const meli = toNum(rebate?.meli);
    const seller = toNum(rebate?.seller);
    const total =
      meli != null || seller != null
        ? Number(meli || 0) + Number(seller || 0)
        : null;
    return [
      ...baseRow,
      meli != null ? fmtPerc(meli, 2) : "",
      seller != null ? fmtPerc(seller, 2) : "",
      total != null ? fmtPerc(total, 2) : "",
    ];
  }

  if (schema.type === "range" || schema.type === "lightning") {
    const range = computeDealDiscountRange({
      ...it,
      promotion_type: typeUp,
      original_price: original,
    });
    const definedPct = getCsvDefinedPercent(it, typeUp, descPct, range);
    const definedPrice =
      definedPct != null
        ? computeDealPriceFromPercent(original, definedPct)
        : basePrice;
    const row = [
      ...baseRow,
      range.minPct != null ? fmtPerc(range.minPct, 2) : "",
      range.maxPct != null ? fmtPerc(range.maxPct, 2) : "",
      range.minPrice != null ? fmtMoeda(range.minPrice) : "",
      range.maxPrice != null ? fmtMoeda(range.maxPrice) : "",
      definedPct != null ? fmtPerc(definedPct, 2) : "",
      definedPrice != null ? fmtMoeda(definedPrice) : "",
    ];
    if (schema.type === "lightning") {
      const stock = it.stock && typeof it.stock === "object" ? it.stock : {};
      row.push(
        stock.min ?? it.min_stock ?? "",
        stock.max ?? it.max_stock ?? "",
        stock.remaining_stock ?? it.remaining_stock ?? "",
      );
    }
    return row;
  }

  return baseRow;
}

async function collectFilteredItemsForCsv({ onProgress } = {}) {
  if (!state.selectedCard) return [];
  const statusParam = filtroToStatusParam();
  let token = null;
  const out = [];
  const seen = new Set();
  let total = 0;

  for (let i = 0; i < 500; i++) {
    const qs = qsBuild({
      limit: PAGE_SIZE,
      ...(statusParam ? { status: statusParam } : {}),
      ...(token ? { search_after: token } : {}),
    });

    const data = await getJSONAny(
      itemsPaths(state.selectedCard.id, state.selectedCard.type, qs),
    );
    total = Number(data?.paging?.total ?? total ?? 0);

    if (data?.promotion_benefits) {
      state.promotionBenefits = data.promotion_benefits;
    }

    let items = Array.isArray(data?.results) ? data.results : [];
    items = items.map((x) => ({ ...x, status: normalizeStatus(x.status) }));
    items = dedupeByMLB(items, statusParam || "");

    if (state.mlbFilter) {
      const mlbUp = state.mlbFilter.toUpperCase();
      items = items.filter((x) => (x.id || "").toUpperCase() === mlbUp);
    }

    if (state.maxDesc != null) {
      const benefitsGlobal =
        state.promotionBenefits || state.selectedCard?.benefits || null;
      items = items.filter((x) => itemMatchesDiscountFilter(x, benefitsGlobal));
    }

    for (const it of items) {
      const id = String(it?.id || "").toUpperCase();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(it);
    }

    token = data?.paging?.searchAfter || null;
    onProgress?.({
      page: i + 1,
      collected: out.length,
      total,
      progress:
        total > 0
          ? Math.min(95, Math.max(1, Math.round((out.length / total) * 95)))
          : 5,
    });
    if (!token) break;
  }

  out.sort((a, b) => sortByMLBAsc(a?.id || "", b?.id || ""));
  return out;
}

async function exportFilteredCsv() {
  if (!state.selectedCard) {
    notifyPromocoes("Selecione uma campanha.");
    return;
  }

  const bulkState = getPromoBulkState();
  const schema = getCampaignCsvSchema();
  const header = [
    ...schema.header,
    "Campanha ID",
    "Campanha nome",
    "Campanha tipo",
  ];

  let items = [];
  let suffix = "selecionados";
  let localJobId = null;
  let fullCampaignExport = false;
  const selectedIds = new Set(
    getSelecionados().map((mlb) => String(mlb || "").toUpperCase()),
  );

  if (bulkState?.global?.selectedAll || !selectedIds.size) {
    fullCampaignExport = true;
    suffix =
      state.mlbFilter || state.maxDesc != null || filtroToStatusParam()
        ? "campanha-filtrada"
        : "campanha-completa";
    const account = await ensurePromoPanelAccount({ force: false }).catch(
      () => ({}),
    );
    localJobId =
      window.JobsPanel?.addLocalJob?.({
        title: `Exportando CSV • ${state.selectedCard?.name || state.selectedCard?.id || "Campanha"}`,
        accountKey: account?.key || null,
        accountLabel: account?.label || null,
        state: "Carregando itens...",
        progress: 1,
      }) || null;
    window.JobsPanel?.show?.();
    try {
      items = await collectFilteredItemsForCsv({
        onProgress({ collected, total, progress }) {
          if (!localJobId) return;
          window.JobsPanel?.updateLocalJob?.(localJobId, {
            progress,
            state:
              total > 0
                ? `Carregando ${collected}/${total}`
                : `Carregando ${collected}`,
            processed: collected,
            total: total || null,
          });
        },
      });
    } catch (error) {
      if (localJobId) {
        window.JobsPanel?.updateLocalJob?.(localJobId, {
          progress: 100,
          state: "Falha ao gerar CSV",
          completed: true,
          errors: 1,
          error: error?.message || String(error),
        });
      }
      throw error;
    }
  } else {
    items = state.items.filter((it) =>
      selectedIds.has(String(it?.id || "").toUpperCase()),
    );
  }

  if (!items.length) {
    setLoading(false, "Nenhum item encontrado para exportar.");
    if (localJobId) {
      window.JobsPanel?.updateLocalJob?.(localJobId, {
        progress: 100,
        state: "Nenhum item encontrado",
        completed: true,
        errors: 1,
        error: "Nenhum item encontrado para exportar.",
      });
    }
    notifyPromocoes("Nenhum item encontrado para exportar.");
    return;
  }

  const rows = items.map((item) => [
    ...buildCsvRowFromItem(item, schema),
    state.selectedCard?.id || "",
    state.selectedCard?.name || "",
    state.selectedCard?.type || "",
  ]);
  const campaignSlug = campaignFilenameSlug();
  const filename = `${campaignSlug || "campanha"}-${suffix}.csv`;

  if (fullCampaignExport && localJobId) {
    const download = createCsvDownload(filename, header, rows);
    window.JobsPanel?.updateLocalJob?.(localJobId, {
      progress: 100,
      state: `Concluido • ${rows.length} itens`,
      processed: rows.length,
      total: rows.length,
      completed: true,
      errors: 0,
      reviewAction: {
        label: "Baixar CSV",
        url: download.url,
        filename,
      },
    });
    setLoading(false, `${rows.length} item(ns) prontos no painel de processos.`);
    return;
  }

  exportRowsToCsv(filename, header, rows);
  setLoading(false, `${rows.length} item(ns) exportado(s) em CSV.`);
}

async function coletarTodosIdsFiltrados() {
  if (PromoActions.coletarTodosIdsFiltrados) {
    return PromoActions.coletarTodosIdsFiltrados({
      state,
      PAGE_SIZE,
      itemsPaths,
      getJSONAny,
      normalizeStatus,
      dedupeByMLB,
      filtroToStatusParam,
      itemMatchesDiscountFilter,
      sortByMLBAsc,
      qsBuild,
    });
  }
  if (!state.selectedCard) return [];

  // Se tiver MLB específico, não precisa varrer páginas
  const only = (state.mlbFilter || "").trim().toUpperCase();
  if (only) return [only];
  const listMlbSet = activeScopedMlbSet();

  const statusParam = filtroToStatusParam();
  let token = null;

  const out = [];
  const seen = new Set();

  for (let i = 0; i < 500; i++) {
    const qs = qsBuild({
      limit: PAGE_SIZE,
      ...(statusParam ? { status: statusParam } : {}),
      ...(token ? { search_after: token } : {}),
    });

    const data = await getJSONAny(
      itemsPaths(state.selectedCard.id, state.selectedCard.type, qs),
    );

    if (data?.promotion_benefits)
      state.promotionBenefits = data.promotion_benefits;

    let items = Array.isArray(data?.results) ? data.results : [];
    items = items.map((x) => ({ ...x, status: normalizeStatus(x.status) }));
    items = dedupeByMLB(items, statusParam || "");

    // Aplica maxDesc aqui também, pra refletir “filtrados”
    if (state.maxDesc != null) {
      const benefitsGlobal =
        state.promotionBenefits || state.selectedCard?.benefits || null;

      items = items.filter((x) => itemMatchesDiscountFilter(x, benefitsGlobal));
    }

    for (const it of items) {
      const id = String(it?.id || "").toUpperCase();
      if (!id || seen.has(id)) continue;
      if (listMlbSet && !listMlbSet.has(id)) continue;
      seen.add(id);
      out.push(id);
    }

    token = data?.paging?.searchAfter || null;
    if (!token) break;
  }

  out.sort(sortByMLBAsc);
  return out;
}

async function removerUnicoDaCampanha(mlb) {
  const id = String(mlb || "").trim().toUpperCase();
  if (!id) return;
  const ok = confirm(`Remover a promocao do anuncio ${id}?`);
  if (!ok) return;
  await iniciarJobRemocaoPromocao([id], {
    title: `Removendo promocao • ${id}`,
    hudTitle: "Remocao unitária",
    delayMs: 0,
  });
}

window.goPage = goPage;
window.toggleTodos = toggleTodos;
window.removerUnicoDaCampanha = removerUnicoDaCampanha;
window.removerEmMassaSelecionados = removerEmMassaSelecionados;
window.removerTodosFiltrados = removerTodosFiltrados;
window.aplicarTodosFiltrados = aplicarTodosFiltrados;
/* ======================== Modo busca unitária (apenas 1 MLB) ======================== */
async function carregarSomenteMLBSelecionado() {
  const $body = elTbody();
  if (!state.selectedCard) {
    $body.innerHTML = `<tr><td colspan="9" class="muted">Selecione uma campanha.</td></tr>`;
    setLoading(false, "Selecione uma campanha para carregar os itens.");
    return;
  }
  const mlb = (state.mlbFilter || "").trim().toUpperCase();
  if (!mlb) {
    await carregarItensPagina(1, true);
    return;
  }

  try {
    state.loading = true;
    setLoading(true, `Carregando item ${mlb}...`);
    renderPaginacao();
    $body.innerHTML = `<tr><td colspan="9" class="muted">Carregando item ${esc(
      mlb,
    )}…</td></tr>`;

    const it = await montarItemRapido(mlb);
    if (!it) {
      $body.innerHTML = `<tr><td colspan="9" class="muted">Item ${esc(
        mlb,
      )} não localizado para esta campanha.</td></tr>`;
      state.items = [];
      state.paging = {
        total: 0,
        limit: PAGE_SIZE,
        tokensByPage: { 1: null },
        currentPage: 1,
        lastPageKnown: 1,
      };
      renderPaginacao();
      setLoading(false, `Item ${mlb} não localizado nesta campanha.`);
      return;
    }

    state.items = [it];
    await hydrateDealCandidateSuggestions(state.items, { skipRender: true });
    state.paging.total = 1;
    state.paging.currentPage = 1;
    state.paging.tokensByPage = { 1: null };
    renderTabela(state.items);
    renderPaginacao();
    applyRebateHeaderTooltip();
    setLoading(false, `Item ${mlb} carregado.`);
  } catch (e) {
    console.error("[carregarSomenteMLBSelecionado] erro:", e);
    $body.innerHTML = `<tr><td colspan="9" class="muted">Falha ao carregar ${esc(
      mlb,
    )} (ver console).</td></tr>`;
  } finally {
    state.loading = false;
    renderPaginacao();
    atualizarFaixaSelecaoCampanha();
    renderManualApplyWizard();
  }
}

// cole perto dos outros helpers de UI
async function atualizarFaixaSelecaoCampanha() {
  const manualFlow = isDealSelected() || isSellerCampaignSelected();
  const manualPercent = getCurrentApplyPercent();
  const filterLimit = state.maxDesc != null ? Number(state.maxDesc) : null;
  try {
    if (!state.selectedCard) {
      syncPromoBulkMeta({
        filteredTotal: null,
        manualPercent: null,
        manualFlow: false,
        filterLimit: null,
      });
      return;
    }

    syncPromoBulkMeta({
      filteredTotal: null,
      manualPercent,
      manualFlow,
      filterLimit,
    });

    // Deal/Seller só precisam preparar a campanha depois que existe uma
    // porcentagem para validar. Evita varrer toda a campanha em paralelo com
    // a verificação que o usuário acabou de solicitar.
    if (manualFlow && filterLimit == null) return;

    if (
      isManualWizardVerifiedForCurrent() &&
      Number(state.manualWizard?.percent) === Number(filterLimit) &&
      Number.isFinite(Number(state.manualWizard?.eligibleTotal))
    ) {
      syncPromoBulkMeta({
        filteredTotal: Number(state.manualWizard.eligibleTotal),
        manualPercent,
        manualFlow,
        filterLimit,
      });
      return;
    }

    const body = {
      promotion_id: state.selectedCard.id,
      promotion_type: state.selectedCard.type,
      status: filtroToStatusParam() || null,
      mlb: state.mlbFilter || null,
      percent_max: filterLimit,
      stock_min: isLightningSelected() ? state.manualWizard?.stockMin ?? null : null,
      stock_max: isLightningSelected() ? state.manualWizard?.stockMax ?? null : null,
      lightning_stock: isLightningSelected() ? getManualWizardQuantity() : null,
    };

    const prepResult = await window.PromoHttp?.postSelectionPrepare?.(body);
    const j = prepResult?.data || {};
    const totalFiltrados =
      prepResult?.ok && typeof j.total === "number" ? j.total : null;

    syncPromoBulkMeta({
      filteredTotal: totalFiltrados,
      manualPercent,
      manualFlow,
      filterLimit,
    });
  } catch (_) {
    syncPromoBulkMeta({
      filteredTotal: null,
      manualPercent,
      manualFlow,
      filterLimit,
    });
  }
}

/* ======================== Exports de utilidade no window ======================== */

window.__PromoState = state;
window.__JobsWatcher = JobsWatcher;
window.atualizarFaixaSelecaoCampanha = atualizarFaixaSelecaoCampanha;

/* ======================== Shims opcionais (evita erros se painel não existir) ======================== */

if (!window.JobsPanel) {
  window.JobsPanel = {
    addLocalJob(info) {
      const id = `local-${Date.now()}`;
      console.log(`JobsPanel shim: addLocalJob ${id} "${info?.title || ""}"`);
      return id;
    },
    updateLocalJob(id, data) {
      console.log(`JobsPanel shim: update ${id} -> ${JSON.stringify(data)}`);
    },
    replaceId(oldId, newId) {
      console.log(`JobsPanel shim: replace ${oldId} -> ${newId}`);
    },
    mergeApiJobs(list) {
      console.log("JobsPanel shim: mergeApiJobs", list);
    },
    show() {
      console.log("JobsPanel shim: show()");
    },
  };
}

if (!window.PromoBulk) {
  window.PromoBulk = {
    setContext(ctx) {
      console.log(`PromoBulk shim: context -> ${JSON.stringify(ctx)}`);
    },
    onHeaderToggle(all) {
      console.log(`PromoBulk shim: header toggle = ${all}`);
    },
  };
}

/* ======================== Guard rails para erros não-capturados ======================== */

window.addEventListener("unhandledrejection", (ev) => {
  try {
    console.error(
      `Promise rejeitada: ${ev.reason?.message || ev.reason || "erro"}`,
    );
  } catch {}
});

window.addEventListener("error", (ev) => {
  try {
    console.error(`Erro JS: ${ev.message} @ ${ev.filename}:${ev.lineno}`);
  } catch {}
});

/* ======================== Helpers de comparação e ordenação (se precisar) ======================== */

// Ordena por MLB asc de forma segura
function sortByMLBAsc(a, b) {
  const sa = String(a?.id || a).toUpperCase();
  const sb = String(b?.id || b).toUpperCase();
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

// Clamp numérico (utilitário eventual)
function clamp(n, min, max) {
  n = Number(n);
  if (!isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/* ======================== Experimentos / flags (mantido para toggles rápidos) ======================== */

const Flags = {
  dealPricePriceDeltaEnabled: true,
  jobsWatcherEnabled: true,
};

console.log("Flags ativas: " + JSON.stringify(Flags));

async function exportCSV() {
  const safeProgress = (cur, tot, opts) =>
    progressFab && typeof progressFab.progress === "function"
      ? progressFab.progress(cur, tot, opts)
      : null;

  try {
    setLoading(true);
    progressFab.show("Carregando dados para exportação…");

    const allRows = await fetchAllPages(
      ({ page, totalPages, withAds }) =>
        safeProgress(page, totalPages, { withAds }),
      { limit: 120, withAds: true, timeoutMs: 120000, strictAds: true },
    );

    progressFab.message("Gerando CSV…");

    const rowsForCsv = allRows.slice();
    if (state.sort === "share" || state.metric === "revenue") {
      rowsForCsv.sort(
        (a, b) => (b.revenue_cents || 0) - (a.revenue_cents || 0),
      );
    } else {
      rowsForCsv.sort((a, b) => (b.units || 0) - (a.units || 0));
    }

    const rowsFiltered = rowsForCsv.filter((r) => Number(r.units || 0) > 0);

    const uTotal = rowsFiltered.reduce((s, r) => s + (r.units || 0), 0);
    const rTotal = rowsFiltered.reduce((s, r) => s + (r.revenue_cents || 0), 0);

    const head = [
      "Índice",
      "MLB",
      "Título",
      "Unidades",
      "Unid. (%)",
      "Valor",
      "FATURAMENTO %",
      "PROMO",
      "% APLICADA",
      "ADS",
      "Cliq.",
      "Impr.",
      "Visit.",
      "Conv.",
      "Invest.",
      "ACOS",
      "Receita Ads",
      "Vendas 7D",
      "Vendas 15D",
      "Vendas 30D",
      "Vendas 40D",
      "Vendas 60D",
      "Vendas 90D",
    ];

    const rows = rowsFiltered.map((r) => {
      const unitShare = uTotal > 0 ? (r.units || 0) / uTotal : 0;
      const revShare = rTotal > 0 ? (r.revenue_cents || 0) / rTotal : 0;

      const promoActive = !!(r.promo && r.promo.active);
      const promoTxt = promoActive ? "Sim" : "Não";
      const promoPct =
        r.promo && r.promo.percent != null ? Number(r.promo.percent) : null;
      const promoPctCsv =
        promoActive && promoPct != null
          ? (promoPct * 100).toFixed(2).replace(".", ",") + "%"
          : "—";

      const ads = r.ads || {};
      const clicks = Number(ads.clicks || 0);
      const imps = Number(ads.impressions || 0);
      const spendC = Number(ads.spend_cents || 0);
      const aRevC = Number(ads.revenue_cents || 0);
      const acosVal = aRevC > 0 ? spendC / aRevC : null;
      const statusText = ads.status_text || (ads.in_campaign ? "Ativo" : "Não");

      const visits = Number(r.visits || r.visits_total || 0);
      const conv = visits > 0 ? Number(r.units || 0) / visits : null;

      return [
        r.curve || "-",
        r.mlb || "",
        (r.title || "").replace(/"/g, '""'),

        r.units || 0,
        (unitShare * 100).toFixed(2).replace(".", ",") + "%",
        (Number(r.revenue_cents || 0) / 100).toFixed(2).replace(".", ","),
        (revShare * 100).toFixed(2).replace(".", ",") + "%",

        promoTxt,
        promoPctCsv,

        statusText,
        clicks,
        imps,
        visits,
        conv != null ? (conv * 100).toFixed(2).replace(".", ",") + "%" : "—",

        (spendC / 100).toFixed(2).replace(".", ","),
        acosVal !== null
          ? (acosVal * 100).toFixed(2).replace(".", ",") + "%"
          : "—",
        (aRevC / 100).toFixed(2).replace(".", ","),

        Number(r.units_7d || 0),
        Number(r.units_15d || 0),
        Number(r.units_30d || 0),
        Number(r.units_40d || 0),
        Number(r.units_60d || 0),
        Number(r.units_90d || 0),
      ];
    });

    const data = [head, ...rows]
      .map((cols) => cols.map((c) => `"${String(c)}"`).join(";"))
      .join("\r\n");

    const blob = new Blob([data], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "curva_abc.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);

    progressFab.message("Concluído!");
    progressFab.done(true);
  } catch (e) {
    console.error(e);
    progressFab.message("Falha: " + (e?.message || e));
    progressFab.done(false);
    notifyPromocoes("Falha ao exportar CSV: " + (e?.message || e));
  } finally {
    setLoading(false);
  }
}

/* ======================== Boot ======================== */

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await ensurePromoPanelAccount({ force: true });
    await window.AccountBar?.ensure?.({ force: true });
  } catch {}
  applyPromoPanelVisibilityFilter();

  hideLeadingRebateColumnIfPresent();
  updateSelectedCampaignName();
  updateDebugMlbMeta();
  setDebugMlbOutput("Aguardando debug.");
  updateSellerCampaignControls();
  updateDealControls();
  updateDiscountFilterUi();
  applyOperationModeUi();
  setLoading(false, "Selecione uma campanha para carregar os itens.");
  HUD.reset();

  if (Flags.jobsWatcherEnabled) JobsWatcher.start();
  else JobsWatcher.stop();

  await carregarCards();
  atualizarFaixaSelecaoCampanha();
});
