(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const __APP_BASE__ =
    window.__APP_BASE_PATH__ ||
    ((location.pathname || "").startsWith("/ml/") ||
    (location.pathname || "") === "/ml"
      ? "/ml"
      : "");

  function withBase(path) {
    if (!__APP_BASE__) return path;
    if (!path) return __APP_BASE__;
    return path.startsWith("/") ? __APP_BASE__ + path : __APP_BASE__ + "/" + path;
  }

  const API_JOBS_CREATE = withBase("/api/analytics/filtro-anuncios/jobs");
  const API_JOBS_STATUS = (jobId) =>
    withBase(`/api/analytics/filtro-anuncios/jobs/${encodeURIComponent(jobId)}`);
  const API_JOBS_LIST = () =>
    withBase("/api/analytics/filtro-anuncios/jobs");
  const API_JOBS_ITEMS = (jobId) =>
    withBase(`/api/analytics/filtro-anuncios/jobs/${encodeURIComponent(jobId)}/items`);
  const API_JOBS_CSV = (jobId) =>
    withBase(`/api/analytics/filtro-anuncios/jobs/${encodeURIComponent(jobId)}/download.csv`);
  const API_JOBS_CANCEL = (jobId) =>
    withBase(`/api/analytics/filtro-anuncios/jobs/${encodeURIComponent(jobId)}/cancel`);

  const ACCOUNT_CURRENT_API = withBase("/api/account/current");
  const ACCOUNT_CLEAR_API = withBase("/api/account/clear");
  const SELECT_CONTA_URL = withBase("/select-conta");
  const DASHBOARD_STATUS_URL = withBase("/projecao-mensal#status");

  const TIMEOUT_MS = 60000;
  const POLL_MIN_MS = 800;
  const POLL_MAX_MS = 2500;
  const ITEMS_CACHE_TTL_MS = 10 * 60 * 1000;
  const ITEMS_CACHE_MAX_ENTRIES = 40;
  const ITEMS_CACHE_STORAGE_KEY = "filtro-anuncios:items-cache:v2";
  const COMMERCIAL_PERIOD_LIMIT_NO_LOOKUP_DAYS = 90;
  const COMMERCIAL_PERIOD_LIMIT_LOOKUP_DAYS = 180;
  const COMMERCIAL_PERIOD_LIMIT_ADVANCED_DAYS = 367;
  let jobsPanelInterval = null;
  let jobsPanelPollingPausedForAuth = false;
  let jobsPanelSyncInFlight = false;

  const state = {
    hasSearched: false,
    page: 1,
    limit: 50,
    total: 0,
    unique_mlb_total: null,
    loading: false,

    job_id: null,
    job_status: null,
    job_progress: 0,
    ui_progress: 0,

    date_from: "",
    date_to: "",
    allow_long_period: false,
    sales_op: "all",
    sales_value: "",
    status: "active",
    sales_no_sales_after: false,

    include_visits: false,
    include_ads: false,
    include_promos: false,
    include_category: false,
    detail_variations: false,

    envio: "all",
    tipo: "all",
    detalhes: "all",
    stock_op: "all",
    stock_value: "",

    q: "",
    sort_by: "sold_value",
    sort_dir: "desc",
    rows: [],
    current_account_key: "",
    current_account_label: "",
    lookup_type: "sku",
    sku_query: "",
  };

  let itemsPageCache = loadItemsPageCache();

  const DATE_HELP_DEFAULT = {
    fDateFrom: "Formato: dd/mm/yyyy. Limite normal: 90 dias sem busca especifica, 180 dias com MLB/SKU/EAN.",
    fDateTo: "Formato: dd/mm/yyyy. Para ate 1 ano, ative o modo avancado.",
  };

  const ACCOUNT_LABELS = {
    drossi: "DRossi Interiores",
    diplany: "Diplany",
    rossidecor: "Rossi Decor",
  };

  const BASE_COLUMNS = [
    { key: "mlb", label: "MLB" },
    { key: "sku", label: "SKU" },
    { key: "gtin", label: "EAN/GTIN" },
    { key: "nome_anuncio", label: "Nome anuncio", className: "col-title" },
    { key: "tipo", label: "Tipo" },
    { key: "envios", label: "Envios" },
    { key: "estoque", label: "Estoque", className: "num" },
    { key: "valor_venda", label: "Valor de Venda", className: "num" },
    { key: "qnt_vendas", label: "Qnt. Vendas", className: "num" },
    { key: "ultima_venda", label: "Ultima venda" },
  ];

  const OPTIONAL_COLUMNS = {
    category: [
      { key: "categoria_nome", label: "Categoria" },
      { key: "categoria_id", label: "ID categoria" },
    ],
    visits: [{ key: "visitas", label: "Visitas", className: "num" }],
    ads: [
      { key: "ads_em_campanha", label: "Em campanha" },
      { key: "ads_roas", label: "ROAS", className: "num" },
      { key: "ads_investimento", label: "Investimento", className: "num" },
      { key: "ads_cliques", label: "Cliques", className: "num" },
      { key: "ads_impressoes", label: "Impressoes", className: "num" },
    ],
    promos: [
      { key: "promo_ativa", label: "Promo" },
      { key: "promo_percentual", label: "% Promo", className: "num" },
      { key: "promo_preco_base", label: "Preco base", className: "num" },
      { key: "promo_preco_vigente", label: "Preco promo", className: "num" },
    ],
    variations: [
      { key: "variation_id", label: "ID variacao" },
      { key: "variation_name", label: "Variacao" },
    ],
  };

  const fmtMoney = (v) => {
    if (v === null || v === undefined || v === "") return "—";
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
  };

  const fmtInt = (v) => {
    if (v === null || v === undefined || v === "") return "—";
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return Math.round(n).toLocaleString("pt-BR");
  };

  const fmtRatio = (v) => {
    if (v === null || v === undefined || v === "") return "—";
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return `${n.toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}x`;
  };

  const fmtPct = (v) => {
    if (v === null || v === undefined || v === "") return "—";
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return `${n.toLocaleString("pt-BR", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}%`;
  };

  const safe = (v, fallback = "—") =>
    v === null || v === undefined || String(v).trim() === ""
      ? fallback
      : String(v);

  const debounce = (fn, ms = 250) => {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  function safeReadSessionStorage(key) {
    try {
      return window.sessionStorage?.getItem(key) || "";
    } catch (_) {
      return "";
    }
  }

  function safeWriteSessionStorage(key, value) {
    try {
      window.sessionStorage?.setItem(key, value);
      return true;
    } catch (_) {
      return false;
    }
  }

  function normalizeItemsPageCache(rawCache) {
    const now = Date.now();
    const normalized = {};
    const entries = rawCache && typeof rawCache === "object" ? Object.entries(rawCache) : [];

    for (const [key, entry] of entries) {
      if (!key || !entry || typeof entry !== "object") continue;
      const payload = entry.payload;
      if (!payload || typeof payload !== "object") continue;
      const expiresAt = Number(entry.expiresAt || 0);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
      normalized[key] = {
        payload,
        expiresAt,
        updatedAt: Number(entry.updatedAt || now) || now,
      };
    }

    const keys = Object.keys(normalized);
    if (keys.length <= ITEMS_CACHE_MAX_ENTRIES) return normalized;

    keys.sort(
      (a, b) =>
        Number(normalized[b]?.updatedAt || 0) - Number(normalized[a]?.updatedAt || 0),
    );
    const trimmed = {};
    keys.slice(0, ITEMS_CACHE_MAX_ENTRIES).forEach((k) => {
      trimmed[k] = normalized[k];
    });
    return trimmed;
  }

  function persistItemsPageCache() {
    itemsPageCache = normalizeItemsPageCache(itemsPageCache);
    safeWriteSessionStorage(ITEMS_CACHE_STORAGE_KEY, JSON.stringify(itemsPageCache));
  }

  function loadItemsPageCache() {
    const raw = safeReadSessionStorage(ITEMS_CACHE_STORAGE_KEY);
    if (!raw) return {};
    try {
      const normalized = normalizeItemsPageCache(JSON.parse(raw));
      safeWriteSessionStorage(ITEMS_CACHE_STORAGE_KEY, JSON.stringify(normalized));
      return normalized;
    } catch (_) {
      return {};
    }
  }

  function buildItemsCacheKey(jobId) {
    const normalizedJobId = String(jobId || "").trim();
    if (!normalizedJobId) return "";
    const page = Math.max(1, Number(state.page || 1) || 1);
    const limit = Math.max(1, Number(state.limit || 50) || 50);
    const q = String(state.q || "").trim().toLowerCase();
    const skuQuery = String(state.sku_query || "").trim().toLowerCase();
    const lookupType = String(state.lookup_type || "sku").trim().toLowerCase();
    return [
      normalizedJobId,
      `p=${page}`,
      `l=${limit}`,
      `q=${encodeURIComponent(q)}`,
      `lookup=${encodeURIComponent(lookupType)}`,
      `sku=${encodeURIComponent(skuQuery)}`,
    ].join("|");
  }

  function readItemsPageFromCache(jobId) {
    const key = buildItemsCacheKey(jobId);
    if (!key) return null;
    const entry = itemsPageCache[key];
    if (!entry) return null;
    if (Number(entry.expiresAt || 0) <= Date.now()) {
      delete itemsPageCache[key];
      persistItemsPageCache();
      return null;
    }
    const payload = entry.payload;
    if (!payload || typeof payload !== "object") return null;
    return {
      total: Number(payload.total || 0),
      unique_mlb_total:
        payload.unique_mlb_total === null || payload.unique_mlb_total === undefined
          ? null
          : Number(payload.unique_mlb_total || 0),
      data: Array.isArray(payload.data) ? payload.data : [],
    };
  }

  function writeItemsPageToCache(jobId, payload) {
    const key = buildItemsCacheKey(jobId);
    if (!key || !payload || typeof payload !== "object") return;
    itemsPageCache[key] = {
      payload: {
        total: Number(payload.total || 0),
        unique_mlb_total:
          payload.unique_mlb_total === null || payload.unique_mlb_total === undefined
            ? null
            : Number(payload.unique_mlb_total || 0),
        data: Array.isArray(payload.data) ? payload.data : [],
      },
      expiresAt: Date.now() + ITEMS_CACHE_TTL_MS,
      updatedAt: Date.now(),
    };
    persistItemsPageCache();
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatDateMask(value) {
    const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
    if (!digits) return "";
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  }

  function parseIsoDateLocal(value) {
    const m = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(y, mo - 1, d);
    if (
      Number.isNaN(dt.getTime()) ||
      dt.getFullYear() !== y ||
      dt.getMonth() !== mo - 1 ||
      dt.getDate() !== d
    ) {
      return null;
    }
    return dt;
  }

  function parseBrDateLocal(value) {
    const m = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    const dt = new Date(y, mo - 1, d);
    if (
      Number.isNaN(dt.getTime()) ||
      dt.getFullYear() !== y ||
      dt.getMonth() !== mo - 1 ||
      dt.getDate() !== d
    ) {
      return null;
    }
    return dt;
  }

  function formatBrDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
  }

  function toIsoDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function minAllowedFromIso() {
    const today = new Date();
    const min = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    min.setFullYear(min.getFullYear() - 1);
    return toIsoDate(min);
  }

  function daysBetweenInclusive(fromDate, toDate) {
    if (!(fromDate instanceof Date) || !(toDate instanceof Date)) return 0;
    const from = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
    const to = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
    return Math.floor((to.getTime() - from.getTime()) / 86400000) + 1;
  }

  function hasLookupTerm() {
    const inputValue = String($("#fSkuSearch")?.value || "").trim();
    return !!String(state.sku_query || inputValue).trim();
  }

  function commercialPeriodLimitDays() {
    if (state.allow_long_period) return COMMERCIAL_PERIOD_LIMIT_ADVANCED_DAYS;
    return hasLookupTerm()
      ? COMMERCIAL_PERIOD_LIMIT_LOOKUP_DAYS
      : COMMERCIAL_PERIOD_LIMIT_NO_LOOKUP_DAYS;
  }

  function commercialPeriodLimitLabel(days) {
    if (days >= COMMERCIAL_PERIOD_LIMIT_ADVANCED_DAYS) return "ate 1 ano";
    return `ate ${days} dias`;
  }

  function clearDateFeedback(inputId, helpId, fallbackText) {
    const input = $("#" + inputId);
    const help = $("#" + helpId);
    if (input) {
      input.classList.remove("is-invalid");
      input.removeAttribute("aria-invalid");
    }
    if (help) {
      help.classList.remove("is-invalid");
      help.textContent = fallbackText || "";
    }
  }

  function setDateFeedback(inputId, helpId, message, fallbackText) {
    const input = $("#" + inputId);
    const help = $("#" + helpId);
    const hasError = !!String(message || "").trim();
    if (input) {
      input.classList.toggle("is-invalid", hasError);
      if (hasError) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
    if (help) {
      help.classList.toggle("is-invalid", hasError);
      help.textContent = hasError ? String(message) : (fallbackText || "");
    }
  }

  function refreshDateStateFromInputs() {
    const fromRaw = String($("#fDateFrom")?.value || "").trim();
    const toRaw = String($("#fDateTo")?.value || "").trim();
    const fromDate = parseBrDateLocal(fromRaw);
    const toDate = parseBrDateLocal(toRaw);
    state.date_from = fromDate ? toIsoDate(fromDate) : "";
    state.date_to = toDate ? toIsoDate(toDate) : "";
  }

  function normalizeDateInputUi() {
    ["fDateFrom", "fDateTo"].forEach((id) => {
      const input = $("#" + id);
      if (!input) return;
      const raw = String(input.value || "").trim();
      if (!raw) return;

      const isoDate = parseIsoDateLocal(raw);
      if (isoDate) {
        input.value = formatBrDate(isoDate);
        return;
      }

      const brDate = parseBrDateLocal(raw);
      if (brDate) {
        input.value = formatBrDate(brDate);
        return;
      }

      input.value = formatDateMask(raw);
    });
  }

  function validateCommercialDates(opts = {}) {
    const silent = !!opts.silent;
    const fromInput = $("#fDateFrom");
    const toInput = $("#fDateTo");
    const fromRaw = String(fromInput?.value || "").trim();
    const toRaw = String(toInput?.value || "").trim();

    clearDateFeedback("fDateFrom", "fDateFromHelp", DATE_HELP_DEFAULT.fDateFrom);
    clearDateFeedback("fDateTo", "fDateToHelp", DATE_HELP_DEFAULT.fDateTo);

    if (!fromRaw && !toRaw) {
      state.date_from = "";
      state.date_to = "";
      return { ok: true, message: "" };
    }

    let firstError = "";

    if (!fromRaw || !toRaw) {
      firstError = "Informe o periodo completo: de e ate.";
      if (!fromRaw) {
        setDateFeedback(
          "fDateFrom",
          "fDateFromHelp",
          "Preencha a data inicial no formato dd/mm/yyyy.",
          DATE_HELP_DEFAULT.fDateFrom,
        );
      }
      if (!toRaw) {
        setDateFeedback(
          "fDateTo",
          "fDateToHelp",
          "Preencha a data final no formato dd/mm/yyyy.",
          DATE_HELP_DEFAULT.fDateTo,
        );
      }
      state.date_from = "";
      state.date_to = "";
      if (!silent) alert(firstError);
      return { ok: false, message: firstError };
    }

    const fromDate = parseBrDateLocal(fromRaw);
    const toDate = parseBrDateLocal(toRaw);

    if (!fromDate) {
      firstError = "Data inicial invalida. Use dd/mm/yyyy.";
      setDateFeedback("fDateFrom", "fDateFromHelp", firstError, DATE_HELP_DEFAULT.fDateFrom);
    }
    if (!toDate) {
      if (!firstError) firstError = "Data final invalida. Use dd/mm/yyyy.";
      setDateFeedback("fDateTo", "fDateToHelp", "Data final invalida. Use dd/mm/yyyy.", DATE_HELP_DEFAULT.fDateTo);
    }
    if (!fromDate || !toDate) {
      state.date_from = "";
      state.date_to = "";
      if (!silent && firstError) alert(firstError);
      return { ok: false, message: firstError || "Datas invalidas." };
    }

    const fromIso = toIsoDate(fromDate);
    const toIso = toIsoDate(toDate);
    const minIso = minAllowedFromIso();

    if (fromIso < minIso) {
      firstError = `A data inicial pode voltar no maximo 1 ano (minimo ${formatBrDate(parseIsoDateLocal(minIso))}).`;
      setDateFeedback("fDateFrom", "fDateFromHelp", firstError, DATE_HELP_DEFAULT.fDateFrom);
    }

    if (toIso < fromIso) {
      if (!firstError) firstError = "A data final nao pode ser menor que a data inicial.";
      setDateFeedback(
        "fDateTo",
        "fDateToHelp",
        "A data final nao pode ser menor que a data inicial.",
        DATE_HELP_DEFAULT.fDateTo,
      );
    }

    const periodDays = daysBetweenInclusive(fromDate, toDate);
    const maxDays = commercialPeriodLimitDays();
    const hardMaxDays = COMMERCIAL_PERIOD_LIMIT_ADVANCED_DAYS;

    if (periodDays > hardMaxDays) {
      if (!firstError) firstError = "O periodo maximo permitido e de 1 ano.";
      setDateFeedback(
        "fDateFrom",
        "fDateFromHelp",
        "Reduza o periodo para no maximo 1 ano.",
        DATE_HELP_DEFAULT.fDateFrom,
      );
      setDateFeedback(
        "fDateTo",
        "fDateToHelp",
        "Periodo acima de 1 ano nao e permitido.",
        DATE_HELP_DEFAULT.fDateTo,
      );
    } else if (periodDays > maxDays) {
      const lookupText = hasLookupTerm()
        ? "com busca especifica por MLB/SKU/EAN"
        : "sem busca especifica por MLB/SKU/EAN";
      firstError =
        `Periodo de ${periodDays} dias bloqueado: use ${commercialPeriodLimitLabel(maxDays)} ${lookupText}. ` +
        "Para consultar ate 1 ano, ative o modo avancado.";
      setDateFeedback(
        "fDateFrom",
        "fDateFromHelp",
        firstError,
        DATE_HELP_DEFAULT.fDateFrom,
      );
      setDateFeedback(
        "fDateTo",
        "fDateToHelp",
        "Ajuste o periodo ou ative o modo avancado.",
        DATE_HELP_DEFAULT.fDateTo,
      );
    }

    if (firstError) {
      state.date_from = "";
      state.date_to = "";
      if (!silent) alert(firstError);
      return { ok: false, message: firstError };
    }

    if (fromInput) fromInput.value = formatBrDate(fromDate);
    if (toInput) toInput.value = formatBrDate(toDate);
    state.date_from = fromIso;
    state.date_to = toIso;
    return { ok: true, message: "" };
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function fetchWithTimeout(url, opts = {}) {
    const ctl = new AbortController();
    const timeout = opts.timeout || TIMEOUT_MS;
    const id = setTimeout(() => ctl.abort(), timeout);
    const { timeout: _ignored, attempts: _attempts, baseDelay: _baseDelay, ...rest } = opts;

    try {
      return await fetch(url, {
        ...rest,
        signal: ctl.signal,
        cache: "no-store",
        credentials: "same-origin",
      });
    } finally {
      clearTimeout(id);
    }
  }

  async function readJsonSafe(resp) {
    const txt = await resp.text().catch(() => "");
    if (!txt) return {};
    try {
      return JSON.parse(txt);
    } catch {
      return { _raw: txt };
    }
  }

  function isTransientValkeyLoadingError(errorOrPayload) {
    if (errorOrPayload?.transientValkeyLoading) return true;
    if (errorOrPayload?.code === "VALKEY_LOADING" || errorOrPayload?.transient === true) return true;
    const text = String(
      errorOrPayload?.message ||
      errorOrPayload?.error ||
      errorOrPayload?.details ||
      errorOrPayload?._raw ||
      errorOrPayload ||
      "",
    );
    return /\bLOADING\b/i.test(text) && /Valkey|Redis|dataset|memory/i.test(text);
  }

  function isAccountAuthError(response, payload) {
    const redirect = String(payload?.redirect || "").toLowerCase();
    const text = String(payload?.error || payload?.message || "").toLowerCase();
    return (
      response?.status === 401 ||
      redirect.includes("select-conta") ||
      text.includes("conta oauth") ||
      text.includes("conta mercado livre")
    );
  }

  async function fetchJsonWithValkeyRetry(url, opts = {}) {
    const attempts = Math.max(1, Number(opts.attempts || 8));
    const baseDelay = Math.max(250, Number(opts.baseDelay || 900));
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await fetchWithTimeout(url, opts);
      const data = await readJsonSafe(response);
      const transientLoading =
        response.status >= 500 && isTransientValkeyLoadingError(data);

      if (!transientLoading) {
        return { response, data };
      }

      lastError = new Error("LOADING Valkey esta carregando os dados em memoria. Tentando novamente...");
      lastError.transientValkeyLoading = true;
      const waitMs = Math.min(6000, baseDelay * attempt);
      setJobStatusUI(true, `Banco temporariamente carregando dados. Nova tentativa em ${Math.ceil(waitMs / 1000)}s...`);
      await sleep(waitMs);
    }

    throw lastError || new Error("Valkey esta carregando os dados em memoria.");
  }

  function normalizeStatus(s) {
    const t = String(s || "").toLowerCase().trim();
    if (t === "concluído") return "concluido";
    return t;
  }

  function normalizePanelText(value) {
    return String(value || "").trim().toLowerCase();
  }

  function readShellAccountLabel() {
    const raw = String($("#account-current")?.textContent || "").trim();
    if (!raw) return "";
    if (/carregando|indispon|nao selecionada|nenhuma selecionada/i.test(raw)) return "";
    return raw;
  }

  function currentFiltroAccountScope() {
    const shellLabel = readShellAccountLabel();
    const key = normalizePanelText(state.current_account_key || "");
    const label = normalizePanelText(
      shellLabel || state.current_account_label || "",
    );
    return { key, label };
  }

  function shouldShowFiltroPanelJob(job) {
    const adapter = normalizePanelText(job?.adapter || job?.module || "");
    const id = normalizePanelText(job?.job_uid || job?.id || "");
    const title = normalizePanelText(job?.title || job?.label || "");
    const isFiltroNamespace =
      adapter === "filtro-anuncios" || id.startsWith("filtro-anuncios:");
    const hasOtherNamespace = /^[a-z0-9-]+:/.test(id) && !id.startsWith("filtro-anuncios:");
    const isFiltroJob = title.startsWith("filtro de anuncios");
    const isCsvExportJob = title.startsWith("exportacao csv");
    if (hasOtherNamespace && !isFiltroNamespace) return false;
    if (!isFiltroNamespace && !isFiltroJob && !isCsvExportJob) return false;

    const current = currentFiltroAccountScope();
    const jobAccountKey = normalizePanelText(
      job?.accountKey ||
      job?.account?.key ||
      job?.account?.meli_conta_id ||
      "",
    );
    const jobAccountLabel = normalizePanelText(
      job?.accountLabel || job?.account?.label || "",
    );

    if (!current.key && !current.label) return true;
    if (!jobAccountKey && !jobAccountLabel) return true;
    if (current.label && jobAccountLabel && current.label === jobAccountLabel)
      return true;
    if (current.key && jobAccountKey) return current.key === jobAccountKey;
    return false;
  }

  function applyFiltroPanelVisibilityFilter() {
    window.JobsPanel?.setAdapter?.("filtro-anuncios");
    window.JobsPanel?.setVisibilityFilter?.(shouldShowFiltroPanelJob);
  }

  function escapeHtml(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function getSalesValNumber() {
    const raw = (state.sales_value ?? "").toString().trim();
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function shouldShowSalesNoSalesAfter() {
    if (!hasCommercialPeriod()) return false;
    const op = String(state.sales_op || "all");
    const n = getSalesValNumber();
    if (op === "all") return false;
    if (n === null) return false;
    return (op === "lt" && n === 1) || n === 0;
  }

  function syncSalesNoSalesAfterFromUI() {
    const chk = $("#fSalesNoSalesAfter");
    state.sales_no_sales_after = !!(chk && chk.checked);
  }

  function setSalesNoSalesAfterUIVisible(visible) {
    const wrap = $("#fSalesNoSalesAfterWrap");
    const chk = $("#fSalesNoSalesAfter");

    if (wrap) wrap.style.display = visible ? "" : "none";
    if (chk) chk.disabled = !visible;

    if (!visible) {
      state.sales_no_sales_after = false;
      if (chk) chk.checked = false;
    } else {
      syncSalesNoSalesAfterFromUI();
    }
  }

  function updateSalesNoSalesAfterUI() {
    setSalesNoSalesAfterUIVisible(shouldShowSalesNoSalesAfter());
  }

  function stockFilterNeedsValue() {
    const op = String(state.stock_op || "all");
    return op === "gt" || op === "lt" || op === "eq";
  }

  function updateStockFilterUI() {
    const input = $("#fStockVal");
    const help = $("#fStockHelp");
    const needsValue = stockFilterNeedsValue();
    if (input) {
      input.style.display = needsValue ? "" : "none";
      input.disabled = !needsValue;
      if (!needsValue) {
        input.value = "";
        state.stock_value = "";
      }
      input.classList.remove("is-invalid");
      input.removeAttribute("aria-invalid");
    }
    if (help) {
      help.classList.remove("is-invalid");
      help.textContent =
        state.stock_op === "zero"
          ? "Lista anuncios com estoque disponivel igual a zero. Em anuncios com variacao, soma o estoque das variacoes."
          : "Considera o estoque disponivel atual retornado pelo Mercado Livre. Em anuncios com variacao, soma o estoque das variacoes.";
    }
  }

  function validateStockFilter() {
    updateStockFilterUI();
    if (!stockFilterNeedsValue()) return { ok: true, message: "" };

    const input = $("#fStockVal");
    const help = $("#fStockHelp");
    const raw = String(input?.value ?? state.stock_value ?? "").trim();
    const n = Number(raw);
    const valid = raw !== "" && Number.isInteger(n) && n >= 0;

    if (valid) {
      state.stock_value = String(n);
      if (input) input.value = String(n);
      return { ok: true, message: "" };
    }

    const message = "Informe uma quantidade de estoque valida.";
    if (input) {
      input.classList.add("is-invalid");
      input.setAttribute("aria-invalid", "true");
    }
    if (help) {
      help.classList.add("is-invalid");
      help.textContent = message;
    }
    alert(message);
    return { ok: false, message };
  }

  function hasCommercialPeriod() {
    return !!(state.date_from && state.date_to);
  }

  function updateCommercialPeriodPolicyUi() {
    const policy = $("#commercialPeriodPolicy");
    const mode = $("#commercialPeriodMode");
    const longWrap = $("#fAllowLongPeriodWrap");
    const hasLookup = hasLookupTerm();
    const limit = commercialPeriodLimitDays();

    if (policy) {
      policy.innerHTML = `
        <strong>Regra de periodo:</strong>
        sem MLB/SKU/EAN, consulte ate 90 dias. Com MLB/SKU/EAN informado, consulte ate 180 dias.
        Para ate 1 ano, use o modo avancado/exportacao assincrona.
      `;
    }

    if (mode) {
      const reason = state.allow_long_period
        ? "Modo avancado ativo: permitido ate 1 ano, mas a consulta pode demorar mais em contas grandes."
        : hasLookup
          ? "Busca especifica detectada: limite normal de ate 180 dias."
          : "Sem busca especifica: limite normal de ate 90 dias para evitar travamentos.";
      mode.textContent = reason;
    }

    if (longWrap) {
      longWrap.classList.toggle("is-enabled", !!state.allow_long_period);
      longWrap.setAttribute("data-limit-days", String(limit));
    }
  }

  function updateCommercialUiState() {
    const active = hasCommercialPeriod();
    const block = $("#commercialBlock");
    const help = $("#commercialHelp");
    const salesOp = $("#fSalesOp");
    const salesVal = $("#fSalesVal");

    if (block) block.classList.toggle("is-inactive", !active);
    if (help) {
      help.textContent = active
        ? "O filtro de vendas sera aplicado neste periodo."
        : "Preencha o periodo completo para ativar vendas, visitas e ads.";
    }

    if (salesOp) salesOp.disabled = !active;
    if (salesVal) salesVal.disabled = !active;

    if (!active) {
      state.sales_op = "all";
      state.sales_value = "";
      if (salesOp) salesOp.value = "all";
      if (salesVal) salesVal.value = "";
    }

    updateSalesNoSalesAfterUI();
    updateCommercialPeriodPolicyUi();
  }

  function updateHeavyExtrasNotice() {
    const el = $("#heavyExtrasNotice");
    if (!el) return;
    const enabledCount =
      Number(!!state.include_category) +
      Number(!!state.include_visits) +
      Number(!!state.include_ads) +
      Number(!!state.include_promos) +
      Number(!!state.detail_variations);
    el.style.display = enabledCount >= 2 ? "block" : "none";
  }

  function shouldAutoDetailVariations() {
    return hasLookupTerm();
  }

  function syncAutoDetailVariations() {
    const auto = shouldAutoDetailVariations();
    if (auto) state.detail_variations = true;

    const btn = $("#btnDetailVariations");
    if (btn) {
      setToggleBtn(btn, !!state.detail_variations);
      btn.classList.toggle("is-auto", auto);
      btn.title = auto
        ? "Ativado automaticamente porque a busca por SKU, EAN ou MLB precisa detalhar variacoes. Pode demorar mais em contas grandes."
        : "Detalha as variacoes dos anuncios. Pode demorar mais em contas grandes.";
    }

    const notice = $("#variationsAutoNotice");
    if (notice) notice.style.display = auto ? "block" : "none";
    updateHeavyExtrasNotice();
  }

  function getVisibleColumns() {
    const cols = BASE_COLUMNS.map((col) => {
      if (!hasCommercialPeriod() && col.key === "valor_venda") {
        return { ...col, label: "Preco atual" };
      }
      if (!hasCommercialPeriod() && col.key === "qnt_vendas") {
        return { ...col, label: "Vendidos" };
      }
      if (!hasCommercialPeriod() && col.key === "ultima_venda") {
        return { ...col, label: "Criado em" };
      }
      return col;
    });
    if (state.include_category) cols.push(...OPTIONAL_COLUMNS.category);
    if (state.include_visits) cols.push(...OPTIONAL_COLUMNS.visits);
    if (state.include_ads) cols.push(...OPTIONAL_COLUMNS.ads);
    if (state.include_promos) cols.push(...OPTIONAL_COLUMNS.promos);
    if (state.detail_variations) cols.push(...OPTIONAL_COLUMNS.variations);
    return cols;
  }

  function getColspan() {
    return Math.max(1, getVisibleColumns().length);
  }

  function renderTableHead() {
    const thead = $("#grid thead");
    if (!thead) return;
    const cols = getVisibleColumns();
    thead.innerHTML = `
      <tr>
        ${cols
          .map((col) => `<th class="${col.className || ""}">${escapeHtml(col.label)}</th>`)
          .join("")}
      </tr>
    `;
  }

  function setToggleBtn(btn, on) {
    if (!btn) return;
    btn.classList.toggle("active", !!on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.dataset.on = on ? "1" : "0";
  }

  function badgeHtml(on, yesText, noText) {
    const cls = on ? "yes" : "no";
    return `<span class="badge ${cls}">${escapeHtml(on ? yesText : noText)}</span>`;
  }

  function setLoading(on, msg = "") {
    state.loading = !!on;
    const btn = $("#btnPesquisar");
    if (btn) {
      btn.disabled = !!on;
      btn.textContent = on ? msg || "Processando..." : "Consultar base";
    }
  }

  function setJobStatusUI(show, text = "") {
    const wrap = $("#job-status");
    const txt = $("#job-status-text");
    if (!wrap) return;
    wrap.style.display = show ? "block" : "none";
    if (txt && text) txt.textContent = text;
  }

  async function syncJobsPanel() {
    if (!window.JobsPanel?.mergeApiJobs) return;
    if (jobsPanelPollingPausedForAuth) return;
    if (jobsPanelSyncInFlight) return;

    jobsPanelSyncInFlight = true;
    try {
      const { response: r, data } = await fetchJsonWithValkeyRetry(API_JOBS_LIST(), {
        timeout: TIMEOUT_MS,
        attempts: 3,
        baseDelay: 700,
      });
      if (isAccountAuthError(r, data)) {
        jobsPanelPollingPausedForAuth = true;
        if (jobsPanelInterval) {
          clearInterval(jobsPanelInterval);
          jobsPanelInterval = null;
        }
        setJobStatusUI(false);
        return;
      }
      if (!r.ok || data.ok === false || !Array.isArray(data.jobs)) return;
      window.JobsPanel.mergeApiJobs(data.jobs, { adapter: "filtro-anuncios" });
      window.JobsPanel.show?.();
    } catch (e) {
      if (String(e?.name || "").toLowerCase() === "aborterror") return;
      console.error("syncJobsPanel:", e);
    } finally {
      jobsPanelSyncInFlight = false;
    }
  }

  function resolveFiltroReviewAction(data, jobId, completed) {
    const explicit =
      data?.review_action && data.review_action.url
        ? {
            label: data.review_action.label || "Baixar CSV",
            url: data.review_action.url,
          }
        : null;
    if (explicit) return explicit;
    const directUrl = String(data?.download_csv_url || "").trim();
    if (directUrl) {
      return {
        label: Number(data?.errors || data?.error_count || 0) > 0 ? "Ver e corrigir" : "Baixar CSV",
        url: directUrl,
      };
    }
    if (!completed) return null;
    return {
      label: Number(data?.errors || data?.error_count || 0) > 0 ? "Ver e corrigir" : "Baixar CSV",
      url: API_JOBS_CSV(jobId),
    };
  }

  async function cancelJobFromPanel(job) {
    const id = String(job?.backendJobId || job?.id || "").trim();
    if (!id) return false;

    const canCancel = !job.completed;
    if (!canCancel) return false;

    const confirmed = window.confirm(
      `Cancelar o job ${id}? Se ele estiver na fila, o proximo job podera iniciar.`
    );
    if (!confirmed) return true;

    try {
      const r = await fetchWithTimeout(API_JOBS_CANCEL(id), {
        method: "POST",
        timeout: TIMEOUT_MS,
      });
      const data = await readJsonSafe(r);
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }

      window.JobsPanel?.updateLocalJob?.(id, {
        progress: 100,
        state: data.status === "cancelando" ? "cancelando" : "cancelado",
        completed: data.status === "cancelado",
      });

      await syncJobsPanel();
      return true;
    } catch (e) {
      console.error("cancelJobFromPanel:", e);
      alert("Erro ao cancelar job: " + (e.message || e));
      return true;
    }
  }

  function easeUiProgress(target) {
    const current = Number(state.ui_progress || 0);
    const next = Math.max(current, Math.min(100, Number(target || 0)));
    if (next <= current) return current;

    const diff = next - current;
    const step =
      diff >= 20 ? 6 :
      diff >= 10 ? 4 :
      diff >= 4 ? 2 :
      1;

    state.ui_progress = Math.min(next, current + step);
    return state.ui_progress;
  }

  function renderEmptyPrompt() {
    const tbody = $("#grid tbody");
    if (!tbody) return;
    tbody.innerHTML = `
      <tr>
        <td colspan="${getColspan()}" style="text-align:center; padding:22px; color:#64748b;">
          Clique em <b>Consultar</b> para carregar os anuncios.
        </td>
      </tr>`;
  }

  function renderLoadingRow(msg) {
    const tbody = $("#grid tbody");
    if (!tbody) return;
    const label = escapeHtml(msg || "Carregando resultados");
    tbody.innerHTML = `
      <tr class="table-loading-row">
        <td colspan="${getColspan()}" class="table-loading-cell">
          <div class="table-loading" role="status" aria-live="polite" aria-label="${label}">
            <span class="table-loading__spinner" aria-hidden="true"></span>
          </div>
        </td>
      </tr>`;
  }

  function renderRowCell(col, row) {
    switch (col.key) {
      case "mlb":
        return `<td title="${escapeHtml(safe(row.mlb))}">${escapeHtml(safe(row.mlb))}</td>`;
      case "sku":
        return `<td title="${escapeHtml(safe(row.sku))}">${escapeHtml(safe(row.sku))}</td>`;
      case "gtin":
        return `<td title="${escapeHtml(safe(row.gtin))}">${escapeHtml(safe(row.gtin))}</td>`;
      case "nome_anuncio": {
        const name = safe(row.nome_anuncio || row.title || row.nome);
        return `<td class="col-title" title="${escapeHtml(name)}">${escapeHtml(name)}</td>`;
      }
      case "tipo":
        return `<td>${escapeHtml(safe(row.tipo))}</td>`;
      case "envios":
        return `<td>${escapeHtml(safe(row.envios))}</td>`;
      case "estoque":
        return `<td class="num" title="${escapeHtml(row.estoque_origem === "variations" ? "Soma das variacoes" : "Estoque do anuncio")}">${escapeHtml(fmtInt(row.estoque))}</td>`;
      case "valor_venda":
        return `<td class="num">${escapeHtml(fmtMoney(hasCommercialPeriod() ? row.valor_venda : row.preco_atual))}</td>`;
      case "qnt_vendas":
        return `<td class="num">${escapeHtml(fmtInt(hasCommercialPeriod() ? row.qnt_vendas : row.vendidos_total))}</td>`;
      case "ultima_venda":
        return `<td>${escapeHtml(safe(hasCommercialPeriod() ? row.ultima_venda : row.date_created, "-"))}</td>`;
      case "categoria_nome":
        return `<td>${escapeHtml(safe(row.categoria_nome || row.category_name))}</td>`;
      case "categoria_id":
        return `<td>${escapeHtml(safe(row.categoria_id || row.category_id))}</td>`;
      case "visitas":
        return `<td class="num">${escapeHtml(fmtInt(row.visitas))}</td>`;
      case "ads_em_campanha":
        return `<td>${badgeHtml(!!row.ads_em_campanha, "Sim", "Nao")}</td>`;
      case "ads_roas":
        return `<td class="num">${escapeHtml(fmtRatio(row.ads_roas))}</td>`;
      case "ads_investimento":
        return `<td class="num">${escapeHtml(fmtMoney(row.ads_investimento))}</td>`;
      case "ads_cliques":
        return `<td class="num">${escapeHtml(fmtInt(row.ads_cliques))}</td>`;
      case "ads_impressoes":
        return `<td class="num">${escapeHtml(fmtInt(row.ads_impressoes))}</td>`;
      case "promo_ativa":
        return `<td>${badgeHtml(!!row.promo_ativa, "Sim", "Nao")}</td>`;
      case "promo_percentual":
        return `<td class="num">${escapeHtml(fmtPct(row.promo_percentual))}</td>`;
      case "promo_preco_base":
        return `<td class="num">${escapeHtml(fmtMoney(row.promo_preco_base))}</td>`;
      case "promo_preco_vigente":
        return `<td class="num">${escapeHtml(fmtMoney(row.promo_preco_vigente))}</td>`;
      case "variation_id":
        return `<td>${escapeHtml(safe(row.variation_id, "-"))}</td>`;
      case "variation_name":
        return `<td title="${escapeHtml(safe(row.variation_name, "-"))}">${escapeHtml(safe(row.variation_name, "-"))}</td>`;
      default:
        return `<td>${escapeHtml(safe(row[col.key]))}</td>`;
    }
  }

  function renderTable(rows) {
    renderTableHead();
    const tbody = $("#grid tbody");
    if (!tbody) return;

    if (!state.hasSearched) {
      renderEmptyPrompt();
      return;
    }

    if (!rows || rows.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="${getColspan()}" style="text-align:center; padding:22px; color:#64748b;">
            Nenhum resultado para os filtros selecionados.
          </td>
        </tr>`;
      return;
    }

    const cols = getVisibleColumns();
    tbody.innerHTML = rows
      .map((row) => `<tr>${cols.map((col) => renderRowCell(col, row)).join("")}</tr>`)
      .join("");
  }

  function renderPager() {
    const el = $("#pager");
    if (!el) return;
    const summaryEl = $("#queryResultSummary");

    if (!state.hasSearched) {
      el.innerHTML = `<div>Mostrando <b>0</b>-<b>0</b> de <b>0</b></div>`;
      if (summaryEl) summaryEl.textContent = "Aguardando consulta.";
      return;
    }

    const total = Number(state.total || 0);
    const page = Number(state.page || 1);
    const limit = Number(state.limit || 50);
    const pages = Math.max(1, Math.ceil(total / limit));
    const from = total === 0 ? 0 : (page - 1) * limit + 1;
    const to = Math.min(total, page * limit);

    const mkBtn = (label, p, disabled = false, active = false) => {
      const cls = ["pg-btn", disabled ? "disabled" : "", active ? "active" : ""]
        .filter(Boolean)
        .join(" ");
      const dis = disabled ? "disabled" : "";
      return `<button class="${cls}" data-page="${p}" ${dis} type="button">${label}</button>`;
    };

    const windowSize = 7;
    let start = Math.max(1, page - Math.floor(windowSize / 2));
    let end = Math.min(pages, start + windowSize - 1);
    start = Math.max(1, end - windowSize + 1);

    const parts = [];
    parts.push(`<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">`);
    const uniqueMlbTotal = Number(state.unique_mlb_total);
    const uniqueText =
      Number.isFinite(uniqueMlbTotal) && uniqueMlbTotal >= 0
        ? ` &bull; <b>${fmtInt(uniqueMlbTotal)}</b> anuncios unicos`
        : "";
    if (summaryEl) {
      const uniqueLabel =
        Number.isFinite(uniqueMlbTotal) && uniqueMlbTotal >= 0
          ? ` · ${fmtInt(uniqueMlbTotal)} anúncios únicos`
          : "";
      summaryEl.textContent = `${fmtInt(total)} linhas encontradas${uniqueLabel}.`;
    }
    parts.push(`<div>Mostrando <b>${from}</b>-<b>${to}</b> de <b>${fmtInt(total)}</b> linhas${uniqueText}</div>`);
    parts.push(`<div class="paginator">`);
    parts.push(mkBtn("«", 1, page <= 1));
    parts.push(mkBtn("‹", page - 1, page <= 1));

    if (start > 1) {
      parts.push(mkBtn("1", 1, false, page === 1));
      if (start > 2) parts.push(`<span style="padding:0 6px; opacity:.7;">...</span>`);
    }

    for (let p = start; p <= end; p++) {
      parts.push(mkBtn(String(p), p, false, p === page));
    }

    if (end < pages) {
      if (end < pages - 1) parts.push(`<span style="padding:0 6px; opacity:.7;">...</span>`);
      parts.push(mkBtn(String(pages), pages, false, page === pages));
    }

    parts.push(mkBtn("›", page + 1, page >= pages));
    parts.push(mkBtn("»", pages, page >= pages));
    parts.push(`</div></div>`);

    el.innerHTML = parts.join("");

    $$("#pager .pg-btn").forEach((b) => {
      b.addEventListener("click", () => {
        if (!state.hasSearched) return;
        if (b.classList.contains("disabled") || b.classList.contains("active")) return;
        const p = Number(b.dataset.page || 1);
        if (!Number.isFinite(p) || p < 1) return;
        state.page = p;
        loadItemsPage().catch(console.error);
      });
    });
  }

  function resetResultsUi() {
    state.hasSearched = false;
    state.page = 1;
    state.total = 0;
    state.unique_mlb_total = null;
    state.rows = [];
    state.job_id = null;
    state.job_status = null;
    state.job_progress = 0;
    state.ui_progress = 0;

    setJobStatusUI(false);
    renderTable([]);
    renderPager();
  }

  function applyResultShapeHints(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (list.some((row) => row?.variation_id || row?.variation_name)) {
      state.detail_variations = true;
      syncAutoDetailVariations();
    }
  }

  function updateJobIdInUrl(jobId) {
    try {
      const u = new URL(window.location.href);
      if (jobId) u.searchParams.set("job_id", String(jobId));
      else u.searchParams.delete("job_id");
      window.history.replaceState({}, "", u.toString());
    } catch (_) {}
  }

  function buildFiltersPayload() {
    const allowNoSalesAfter = shouldShowSalesNoSalesAfter();
    const hasPeriod = hasCommercialPeriod();
    return {
      date_from: state.date_from,
      date_to: state.date_to,
      allow_long_period: state.allow_long_period ? "1" : "0",
      status: state.status || "all",
      sales_op: hasPeriod ? state.sales_op || "all" : "all",
      sales_value: hasPeriod ? state.sales_value : "",
      sales_no_sales_after: allowNoSalesAfter ? !!state.sales_no_sales_after : false,
      include_visits: state.include_visits && hasPeriod ? "1" : "0",
      include_ads: state.include_ads && hasPeriod ? "1" : "0",
      include_promos: state.include_promos ? "1" : "0",
      include_category: state.include_category ? "1" : "0",
      detail_variations: state.detail_variations ? "1" : "0",
      envio: state.envio || "all",
      tipo: state.tipo || "all",
      detalhes: state.detalhes || "all",
      stock_op: state.stock_op || "all",
      stock_value: stockFilterNeedsValue() ? state.stock_value : "",
      sort_by: state.sort_by || "sold_value",
      sort_dir: state.sort_dir || "desc",
      lookup_type: state.lookup_type || "sku",
      sku_query: state.sku_query || "",
    };
  }

  function qsForItems() {
    const p = new URLSearchParams();
    p.set("page", String(state.page));
    p.set("limit", String(state.limit));
    if (state.q) p.set("q", state.q);
    if (state.lookup_type) p.set("lookup_type", state.lookup_type);
    if (state.sku_query) p.set("sku_query", state.sku_query);
    return p.toString();
  }

  async function createJob() {
    updateCommercialUiState();
    updateSalesNoSalesAfterUI();
    syncSalesNoSalesAfterFromUI();

    const payload = buildFiltersPayload();

    const r = await fetchWithTimeout(API_JOBS_CREATE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeout: TIMEOUT_MS,
    });

    const data = await readJsonSafe(r);
    if (!r.ok || data.ok === false) {
      const msg = (data && (data.message || data.error)) || `HTTP ${r.status}`;
      const err = new Error(msg);
      if (isTransientValkeyLoadingError(data)) err.transientValkeyLoading = true;
      throw err;
    }

    const jobId = data.job_id || data.id;
    if (!jobId) throw new Error("API nao retornou job_id.");
    window.JobsPanel?.updateLocalJob?.(String(jobId), {
      title: "Filtro de anuncios",
      state: "aguardando",
      progress: 0,
      completed: false,
      accountKey:
        String(data?.meli_conta_id || data?.account?.meli_conta_id || state.current_account_key || "").trim() ||
        null,
      accountLabel: data?.account?.label || null,
    });
    state.job_status = "aguardando";
    setLoading(true, "Aguardando...");
    syncJobsPanel().catch(console.error);
    return String(jobId);
  }

  async function pollJobUntilDone(jobId) {
    let wait = POLL_MIN_MS;
    setJobStatusUI(true, "Processando...");

    while (true) {
      const { response: r, data } = await fetchJsonWithValkeyRetry(API_JOBS_STATUS(jobId), {
        timeout: TIMEOUT_MS,
      });

      if (!r.ok || data.ok === false) {
        if (isAccountAuthError(r, data)) {
          throw new Error("Conta Mercado Livre nao carregada. Selecione a conta novamente para continuar.");
        }
        const msg = (data && (data.message || data.error)) || `HTTP ${r.status}`;
        throw new Error(msg);
      }

      const status = normalizeStatus(data.status);
      const progress = Number(data.progress ?? 0);
      const phaseRaw = String(data.progress_phase || "").trim();
      const phaseLooksRunning =
        !!phaseRaw && !/^(aguardando|na fila|pending|waiting)$/i.test(phaseRaw);
      const effectiveStatus =
        status === "aguardando" &&
        ((Number.isFinite(progress) && progress > 0) || phaseLooksRunning)
          ? "processando"
          : status;
      state.job_status = effectiveStatus;
      state.job_progress = Number.isFinite(progress) ? progress : 0;

      const pct = easeUiProgress(Math.max(0, Math.min(100, Math.round(state.job_progress))));
      const phase = phaseRaw;
      const processedRaw = Number(data.processed);
      const totalRaw = Number(data.total);
      const hasProcessed = Number.isFinite(processedRaw) && processedRaw >= 0;
      const hasTotal = Number.isFinite(totalRaw) && totalRaw > 0;
      const processedCount = hasProcessed ? Math.round(processedRaw) : null;
      const totalCount = hasTotal ? Math.round(totalRaw) : null;
      const runningState =
        phase
          ? hasProcessed && hasTotal
            ? `${phase}... ${fmtInt(processedCount)}/${fmtInt(totalCount)}`
            : `${phase}... ${pct}%`
          : `processando ${pct}%`;
      const isCompletedStatus = effectiveStatus === "concluido";
      const isCanceledStatus = effectiveStatus === "cancelado";
      const isFailedStatus =
        effectiveStatus === "erro" ||
        effectiveStatus === "failed" ||
        effectiveStatus === "falhou";
      const terminalStatus = isCompletedStatus || isCanceledStatus || isFailedStatus;
      setLoading(true, "Processando...");
      renderLoadingRow("Carregando resultados");
      setJobStatusUI(true, runningState);
      if (!terminalStatus) {
        window.JobsPanel?.updateLocalJob?.(jobId, {
          title: "Filtro de anuncios",
          state:
            effectiveStatus === "aguardando"
              ? "aguardando"
              : effectiveStatus === "cancelando"
                ? "cancelando"
                : runningState,
          progress: pct,
          processed: processedCount,
          total: totalCount,
          errors: Number(data.errors ?? data.error_count ?? 0),
          completed: false,
          accountKey:
            String(data?.account?.meli_conta_id || state.current_account_key || "").trim() || null,
          accountLabel: data?.account?.label || null,
        });
      }

      if (isCompletedStatus) {
        state.job_status = "concluido";
        state.ui_progress = 100;
        const reviewAction = resolveFiltroReviewAction(data, jobId, true);
        window.JobsPanel?.updateLocalJob?.(jobId, {
          title: "Filtro de anuncios",
          state: `concluido: ${Number(data.total || 0)} resultado(s)`,
          progress: 100,
          processed: Number(data.processed ?? data.total ?? 0),
          total: Number(data.total ?? 0),
          errors: Number(data.errors ?? data.error_count ?? 0),
          completed: true,
          reviewAction,
          downloadCsvUrl: reviewAction?.url || API_JOBS_CSV(jobId),
          accountKey:
            String(data?.account?.meli_conta_id || state.current_account_key || "").trim() || null,
          accountLabel: data?.account?.label || null,
        });
        setJobStatusUI(false);
        syncJobsPanel().catch(console.error);
        return true;
      }

      if (isCanceledStatus) {
        state.job_status = "cancelado";
        window.JobsPanel?.updateLocalJob?.(jobId, {
          title: "Filtro de anuncios",
          state: "cancelado",
          progress: 100,
          processed: Number(data.processed ?? data.total ?? 0),
          total: Number(data.total ?? 0),
          errors: Number(data.errors ?? data.error_count ?? 0),
          completed: true,
          reviewAction: null,
          downloadCsvUrl: null,
          accountKey:
            String(data?.account?.meli_conta_id || state.current_account_key || "").trim() || null,
          accountLabel: data?.account?.label || null,
        });
        setJobStatusUI(false);
        throw new Error("Job cancelado.");
      }

      if (isFailedStatus) {
        state.job_status = "erro";
        window.JobsPanel?.updateLocalJob?.(jobId, {
          title: "Filtro de anuncios",
          state: data.error || "erro",
          progress: 100,
          processed: Number(data.processed ?? data.total ?? 0),
          total: Number(data.total ?? 0),
          errors: Number(data.errors ?? data.error_count ?? 1),
          completed: true,
          reviewAction: null,
          downloadCsvUrl: null,
          error: data.error || "Job falhou.",
          accountKey:
            String(data?.account?.meli_conta_id || state.current_account_key || "").trim() || null,
          accountLabel: data?.account?.label || null,
        });
        setJobStatusUI(false);
        throw new Error(data.error || "Job falhou.");
      }

      await sleep(wait);
      wait = Math.min(POLL_MAX_MS, Math.round(wait * 1.35));
    }
  }

  async function loadItemsPage() {
    if (!state.job_id) return;

    const cached = readItemsPageFromCache(state.job_id);
    if (cached) {
      state.hasSearched = true;
      state.total = Number(cached.total || 0);
      state.unique_mlb_total =
        cached.unique_mlb_total === null || cached.unique_mlb_total === undefined
          ? null
          : Number(cached.unique_mlb_total || 0);
      state.rows = Array.isArray(cached.data) ? cached.data : [];
      applyResultShapeHints(state.rows);
      renderTable(state.rows);
      renderPager();
      setJobStatusUI(false);
      if (state.job_status === "concluido") setLoading(false);
      return;
    }

    setLoading(true, "Carregando...");
    renderLoadingRow("Carregando resultados");

    try {
      const url = `${API_JOBS_ITEMS(state.job_id)}?${qsForItems()}`;
      const { response: r, data } = await fetchJsonWithValkeyRetry(url, {
        timeout: TIMEOUT_MS,
        attempts: 10,
        baseDelay: 1200,
      });

      if (r.status === 202) {
        await pollJobUntilDone(state.job_id);
        return await loadItemsPage();
      }

      if (!r.ok || data.ok === false) {
        const msg = (data && (data.message || data.error)) || `HTTP ${r.status}`;
        throw new Error(msg);
      }

      state.hasSearched = true;
      state.total = Number(data.total ?? 0);
      state.unique_mlb_total =
        data.unique_mlb_total === null || data.unique_mlb_total === undefined
          ? null
          : Number(data.unique_mlb_total || 0);
      state.rows = Array.isArray(data.data) ? data.data : [];
      applyResultShapeHints(state.rows);
      writeItemsPageToCache(state.job_id, data);
      renderTable(state.rows);
      renderPager();
    } catch (e) {
      console.error("loadItemsPage:", e);
      state.hasSearched = true;
      state.total = 0;
      state.rows = [];
      renderTable([]);
      renderPager();

      const msg = isTransientValkeyLoadingError(e)
        ? "O banco de jobs ainda esta carregando em memoria. Aguarde alguns segundos e tente novamente."
        : String(e?.name || "").toLowerCase().includes("abort")
          ? "Timeout ao carregar dados. Tente reduzir o periodo e/ou filtrar Status."
          : "Erro ao carregar dados: " + (e.message || e);

      alert(msg);
    } finally {
      if (state.job_status === "concluido") setLoading(false);
      setJobStatusUI(false);
      syncJobsPanel().catch(console.error);
    }
  }

  async function runFilterFlow() {
    if (state.loading) return;
    const dateValidation = validateCommercialDates();
    updateCommercialUiState();
    if (!dateValidation.ok) return;
    const stockValidation = validateStockFilter();
    if (!stockValidation.ok) return;

    const startedAt = Date.now();
    const selectedExtras =
      Number(!!state.include_category) +
      Number(!!state.include_visits) +
      Number(!!state.include_ads) +
      Number(!!state.include_promos) +
      Number(!!state.detail_variations);
    const minLoadingMs =
      selectedExtras >= 2 ? 2200 : selectedExtras === 1 ? 1700 : 1200;

    // A busca rapida da tabela (q) e apenas um refinamento local da visualizacao.
    // Ao iniciar um novo job, ela deve voltar vazia para nao ocultar resultados novos.
    state.q = "";
    const searchInput = $("#fSearch");
    if (searchInput) searchInput.value = "";

    state.ui_progress = 0;
    state.unique_mlb_total = null;
    setLoading(true, "Criando job...");
    renderLoadingRow("Criando job...");
    setJobStatusUI(true, "Criando job...");

    try {
      const jobId = await createJob();
      if (!jobId) return;

      state.job_id = jobId;
      updateJobIdInUrl(jobId);
      state.page = 1;
      state.hasSearched = true;

      await pollJobUntilDone(jobId);
      await loadItemsPage();
    } catch (e) {
      console.error("runFilterFlow:", e);
      state.hasSearched = true;
      state.total = 0;
      state.unique_mlb_total = null;
      state.rows = [];
      renderTable([]);
      renderPager();
      setJobStatusUI(false);
      const msg = isTransientValkeyLoadingError(e)
        ? "O banco de jobs esta carregando em memoria. Aguarde alguns segundos e tente novamente."
        : e.message || e;
      alert("Erro: " + msg);
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < minLoadingMs) {
        await sleep(minLoadingMs - elapsed);
      }
      setLoading(false);
      setJobStatusUI(false);
    }
  }

  async function carregarContaAtual() {
    const currentEl = $("#account-current");
    try {
      const r = await fetchWithTimeout(ACCOUNT_CURRENT_API, { cache: "no-store" });
      const data = await r.json().catch(() => ({}));

      let shown = "Nao selecionada";
      if (data && (data.ok || data.success)) {
        state.current_account_key = String(
          data.accountKey || data.current?.id || "",
        ).trim();
        state.current_account_label = String(
          data.label ||
          data.current?.label ||
          ACCOUNT_LABELS[data.accountKey] ||
          data.accountKey ||
          "",
        ).trim();
        shown =
          state.current_account_label ||
          state.current_account_key ||
          "Desconhecida";

        window.__ACCOUNT__ = {
          ...(window.__ACCOUNT__ || {}),
          key: state.current_account_key || null,
          accountKey: state.current_account_key || null,
          meli_conta_id: state.current_account_key || null,
          label: state.current_account_label || null,
        };
      }

      if (currentEl) currentEl.textContent = shown;
      applyFiltroPanelVisibilityFilter();
    } catch (e) {
      if (currentEl) currentEl.textContent = "Indisponivel";
      applyFiltroPanelVisibilityFilter();
      console.error("carregarContaAtual:", e);
    }
  }

  async function trocarConta() {
    try {
      await fetchWithTimeout(ACCOUNT_CLEAR_API, {
        method: "POST",
        timeout: TIMEOUT_MS,
      });
    } catch (_) {}

    updateJobIdInUrl(null);
    resetResultsUi();
    window.location.href = SELECT_CONTA_URL;
  }

  function abrirStatusRapido() {
    window.location.href = DASHBOARD_STATUS_URL;
  }

  function bindFilters() {
    const lookupCopy = {
      sku: {
        label: "Pesquisa por SKU",
        placeholder: "Informe 1 SKU ou uma lista (separados por virgula)",
        help:
          "Busca por familia de SKU. Ex.: 100598 tambem localiza 100598-134 e 100598-136. Com variacoes detalhadas, cada variacao pode virar uma linha.",
      },
      ean: {
        label: "Pesquisa por EAN / GTIN",
        placeholder: "Informe 1 EAN, GTIN ou uma lista",
        help: "Verifica codigos GTIN, EAN, UPC, JAN, ISBN e codigo de barras cadastrados no anuncio.",
      },
      mlb: {
        label: "MLB para localizar SKU",
        placeholder: "Informe 1 MLB ou uma lista de MLBs",
        help: "A tela identifica o SKU do MLB informado e busca todos os anuncios com o mesmo SKU.",
      },
    };

    function updateLookupUiState() {
      const type = String(state.lookup_type || "sku").toLowerCase();
      const copy = lookupCopy[type] || lookupCopy.sku;
      const label = $("#fLookupLabel");
      const input = $("#fSkuSearch");
      const help = $("#fLookupHelp");
      if (label) label.textContent = copy.label;
      if (input) input.placeholder = copy.placeholder;
      if (help) help.textContent = copy.help;
    }

    const bind = (id, key) => {
      const el = $("#" + id);
      if (!el) return;
      const ev = el.tagName === "SELECT" ? "change" : "input";
      el.addEventListener(ev, () => {
        state[key] = el.value;
        if (key === "sales_op" || key === "sales_value") {
          updateSalesNoSalesAfterUI();
        }
        if (key === "date_from" || key === "date_to") {
          updateCommercialUiState();
        }
        if (key === "lookup_type") {
          updateLookupUiState();
          updateCommercialPeriodPolicyUi();
          syncAutoDetailVariations();
          validateCommercialDates({ silent: true });
        }
        if (key === "sku_query") {
          updateCommercialPeriodPolicyUi();
          syncAutoDetailVariations();
          validateCommercialDates({ silent: true });
        }
      });
    };

    bind("fLookupType", "lookup_type");
    bind("fSalesOp", "sales_op");
    bind("fSalesVal", "sales_value");
    bind("fStatus", "status");
    bind("fEnvio", "envio");
    bind("fTipo", "tipo");
    bind("fDetalhes", "detalhes");
    bind("fStockOp", "stock_op");
    bind("fStockVal", "stock_value");
    bind("fSkuSearch", "sku_query");

    const stockOp = $("#fStockOp");
    if (stockOp) {
      stockOp.addEventListener("change", () => {
        updateStockFilterUI();
      });
    }

    const bindDateInput = (id) => {
      const input = $("#" + id);
      if (!input) return;
      input.addEventListener("input", () => {
        const next = formatDateMask(input.value);
        if (input.value !== next) input.value = next;
        refreshDateStateFromInputs();
        updateCommercialUiState();
      });
      input.addEventListener("blur", () => {
        normalizeDateInputUi();
        validateCommercialDates({ silent: true });
        refreshDateStateFromInputs();
        updateCommercialUiState();
      });
    };

    bindDateInput("fDateFrom");
    bindDateInput("fDateTo");

    const chkSalesAfter = $("#fSalesNoSalesAfter");
    if (chkSalesAfter) {
      chkSalesAfter.addEventListener("change", () => {
        state.sales_no_sales_after = !!chkSalesAfter.checked;
      });
    }

    const chkLongPeriod = $("#fAllowLongPeriod");
    if (chkLongPeriod) {
      state.allow_long_period = !!chkLongPeriod.checked;
      chkLongPeriod.addEventListener("change", () => {
        state.allow_long_period = !!chkLongPeriod.checked;
        updateCommercialPeriodPolicyUi();
        validateCommercialDates({ silent: true });
        refreshDateStateFromInputs();
        updateCommercialUiState();
      });
    }

    const toggle = (btnId, key) => {
      const btn = $("#" + btnId);
      if (!btn) return;
      setToggleBtn(btn, !!state[key]);
      btn.addEventListener("click", () => {
        if (key === "detail_variations" && shouldAutoDetailVariations()) {
          state[key] = true;
          syncAutoDetailVariations();
          return;
        }
        state[key] = !state[key];
        setToggleBtn(btn, !!state[key]);
        updateHeavyExtrasNotice();
        if (state.job_id || state.hasSearched || state.rows.length) {
          resetResultsUi();
        } else {
          renderTable([]);
        }
      });
    };

    toggle("btnIncludeCategory", "include_category");
    toggle("btnIncludeVisits", "include_visits");
    toggle("btnIncludeAds", "include_ads");
    toggle("btnIncludePromos", "include_promos");
    toggle("btnDetailVariations", "detail_variations");

    const search = $("#fSearch");
    if (search) {
      search.addEventListener(
        "input",
        debounce(() => {
          state.q = search.value.trim();
          if (!state.hasSearched || !state.job_id) return;
          state.page = 1;
          loadItemsPage().catch(console.error);
        }, 350)
      );
    }

    const btn = $("#btnPesquisar");
    if (btn) {
      btn.addEventListener("click", () => {
        state.page = 1;
        runFilterFlow().catch(console.error);
      });
    }

    const btnStatus = $("#btn-status");
    if (btnStatus) btnStatus.addEventListener("click", abrirStatusRapido);

    const btnSwitch = $("#account-switch");
    if (btnSwitch) btnSwitch.addEventListener("click", trocarConta);

    updateSalesNoSalesAfterUI();
    updateStockFilterUI();
    updateCommercialUiState();
    updateLookupUiState();
    updateCommercialPeriodPolicyUi();
    updateHeavyExtrasNotice();
    syncAutoDetailVariations();
    renderTableHead();
    window.JobsPanel?.setCancelHandler?.(cancelJobFromPanel);
  }

  function setDefaultDates() {
    const fFrom = $("#fDateFrom");
    const fTo = $("#fDateTo");

    if (fFrom && !fFrom.value) fFrom.value = "";
    if (fTo && !fTo.value) fTo.value = "";

    normalizeDateInputUi();
    validateCommercialDates({ silent: true });
    refreshDateStateFromInputs();
  }

  async function resumeJobIfPresent() {
    let jobId = "";
    try {
      jobId = String(new URL(window.location.href).searchParams.get("job_id") || "").trim();
    } catch (_) {
      jobId = "";
    }
    if (!jobId) {
      state.job_id = null;
      return;
    }

    state.job_id = jobId;
    state.hasSearched = true;
    state.page = 1;
    setLoading(true, "Carregando...");
    renderLoadingRow("Carregando resultados");
    setJobStatusUI(true, "Retomando consulta...");

    try {
      const { response: r, data } = await fetchJsonWithValkeyRetry(API_JOBS_STATUS(jobId), {
        timeout: TIMEOUT_MS,
        attempts: 5,
        baseDelay: 900,
      });
      if (!r.ok || data.ok === false) {
        throw new Error(data?.error || data?.message || `HTTP ${r.status}`);
      }

      const status = normalizeStatus(data.status);
      state.job_status = status;
      state.job_progress = Number(data.progress || 0);

      if (status === "concluido") {
        await loadItemsPage();
        return;
      }

      if (status === "erro" || status === "failed" || status === "falhou") {
        throw new Error(data.error || "Job falhou.");
      }

      await pollJobUntilDone(jobId);
      await loadItemsPage();
    } catch (error) {
      console.error("resumeJobIfPresent:", error);
      state.hasSearched = true;
      state.total = 0;
      state.unique_mlb_total = null;
      state.rows = [];
      renderTable([]);
      renderPager();
      alert("Nao foi possivel retomar a consulta: " + (error.message || error));
    } finally {
      setLoading(false);
      setJobStatusUI(false);
    }
  }

  function startJobsPanelPolling() {
    jobsPanelPollingPausedForAuth = false;
    if (jobsPanelInterval) clearInterval(jobsPanelInterval);
    syncJobsPanel().catch(console.error);
    jobsPanelInterval = setInterval(() => {
      syncJobsPanel().catch(console.error);
    }, 5000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    applyFiltroPanelVisibilityFilter();
    setDefaultDates();
    bindFilters();
    carregarContaAtual();
    resetResultsUi();
    startJobsPanelPolling();
    resumeJobIfPresent().catch(console.error);
  });

  window.addEventListener("beforeunload", () => {
    if (jobsPanelInterval) clearInterval(jobsPanelInterval);
  });
})();
