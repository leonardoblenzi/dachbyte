(function bootstrapWorkspace() {
  const state = {
    period: "current_month",
    financeDateFrom: "",
    financeDateTo: "",
    lastSyncFeedback: [],
    session: readSession(),
    workspaceId: "",
    integration: null,
    adminUsers: [],
    adminWorkspaces: [],
    canAccessAdmin: false,
    patchNotesHistory: [],
    patchRecipients: [],
    catalogCacheNoticeShown: false,
    analytics: {
      dateFrom: "",
      dateTo: "",
      compareFrom: "",
      compareTo: "",
    },
    salesReport: {
      dateFrom: "",
      dateTo: "",
      orderIds: "",
      productIds: "",
      lastPayload: null,
    },
    abc: {
      dateFrom: "",
      dateTo: "",
      metric: "revenue",
      limit: 200,
      orderIds: "",
      productIds: "",
      lastPayload: null,
    },
    views: {
      catalog: { search: "", status: "", stockState: "", sort: "updated_desc", limit: 20, offset: 0, total: 0, selectedId: "" },
      orders: { search: "", status: "", dateFrom: "", dateTo: "", limit: 20, offset: 0, total: 0, selectedId: "" },
      finance: { search: "", status: "", dateFrom: "", dateTo: "", limit: 20, offset: 0, total: 0 },
      messaging: { search: "", status: "", unreadOnly: false, limit: 20, offset: 0, total: 0 },
    },
  };

  state.workspaceId = String(state.session?.user?.workspaceId || "").trim();
  state.canAccessAdmin = isMasterAdmin(state.session?.user);
  if (state.session?.user?.email) {
    persistSession(state.session);
  }

  applyAdminVisibility(state);
  bindTabs();
  bindQuickNavigation();
  bindThemeToggle();
  bindSidebarCollapse();
  hydrateSession(state);
  initializeDates(state);
  bindPeriodFilter(state);
  bindAnalyticsFilters(state);
  bindDashboardFilters(state);
  bindSyncActions(state);
  bindIntegrationActions(state);
  bindAdminSubTabs();
  bindAdminActions(state);
  bindDataExplorer(state);
  bindSalesReportActions(state);
  bindAbcActions(state);
  refreshWorkspace(state);
})();

const GET_RESPONSE_CACHE_TTL_MS = 120000;
const PRODUCT_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const PRODUCT_CACHE_PREFIX = "madeira-catalog-cache-v1";
const responseCache = new Map();
const inFlightGetRequests = new Map();

async function refreshWorkspace(state) {
  setText("workspace-status-text", "Atualizando indicadores");

  try {
    const requests = [
      fetchJson(buildScopedUrl(state, "api/integration/status")),
      fetchJson(buildDataUrl(state, "api/dashboard/overview", {
        period: state.period,
        dateFrom: state.analytics.dateFrom,
        dateTo: state.analytics.dateTo,
        compareFrom: state.analytics.compareFrom,
        compareTo: state.analytics.compareTo,
      })),
      fetchJson(buildDataUrl(state, "api/analytics/month-projection", {
        period: state.period,
        dateFrom: state.analytics.dateFrom,
        dateTo: state.analytics.dateTo,
        compareFrom: state.analytics.compareFrom,
        compareTo: state.analytics.compareTo,
      })),
      fetchJson(buildDataUrl(state, "api/analytics/abc", {
        period: state.period,
        dateFrom: state.abc.dateFrom,
        dateTo: state.abc.dateTo,
        metric: state.abc.metric,
        limit: state.abc.limit,
        orderIds: state.abc.orderIds,
        productIds: state.abc.productIds,
      })),
      fetchJson(buildDataUrl(state, "api/catalog/products", {
        search: state.views.catalog.search,
        status: state.views.catalog.status,
        stockState: state.views.catalog.stockState,
        sort: state.views.catalog.sort,
        limit: state.views.catalog.limit,
        offset: state.views.catalog.offset,
      })),
      fetchJson(buildDataUrl(state, "api/orders", {
        search: state.views.orders.search,
        status: state.views.orders.status,
        dateFrom: state.views.orders.dateFrom,
        dateTo: state.views.orders.dateTo,
        limit: state.views.orders.limit,
        offset: state.views.orders.offset,
      })),
      fetchJson(buildDataUrl(state, "api/finance/entries", {
        search: state.views.finance.search,
        status: state.views.finance.status,
        dateFrom: state.views.finance.dateFrom,
        dateTo: state.views.finance.dateTo,
        limit: state.views.finance.limit,
        offset: state.views.finance.offset,
      })),
      fetchJson(buildDataUrl(state, "api/messaging/threads", {
        search: state.views.messaging.search,
        status: state.views.messaging.status,
        unreadOnly: state.views.messaging.unreadOnly ? "true" : "",
        limit: state.views.messaging.limit,
        offset: state.views.messaging.offset,
      })),
      fetchJson(buildDataUrl(state, "api/sync/runs", { limit: 8 })),
      fetchJson(buildDataUrl(state, "api/patch-notes/history", { limit: 12 })).catch(() => ({
        ok: false,
        items: [],
      })),
    ];

    if (state.canAccessAdmin) {
      requests.push(
        fetchJson(buildAdminUrl(state, "api/admin/users")).catch((error) => ({
          ok: false,
          error: error.message,
          users: state.adminUsers || [],
        })),
        fetchJson(buildAdminUrl(state, "api/admin/workspaces")).catch(() => ({
          ok: false,
          items: state.adminWorkspaces || [],
          selectedWorkspaceId: state.workspaceId || "",
        })),
        fetchJson(buildAdminUrl(state, "api/admin/patch-notes/recipients")).catch(() => ({
          ok: false,
          users: state.patchRecipients || [],
          totalRecipients: (state.patchRecipients || []).length,
        })),
      );
    }

    const [
      integrationPayload,
      dashboard,
      projectionPayload,
      abcPayload,
      productsPayload,
      ordersPayload,
      financePayload,
      threadsPayload,
      syncRunsPayload,
      patchHistoryPayload,
      adminPayload,
      adminWorkspacesPayload,
      patchRecipientsPayload,
    ] = await Promise.all(requests);

    let effectiveProductsPayload = productsPayload;
    if (Number(productsPayload?.total || 0) > 0) {
      writeCatalogProductsCache(state, productsPayload);
      state.catalogCacheNoticeShown = false;
    } else {
      const cachedProductsPayload = readCatalogProductsCache(state);
      if (cachedProductsPayload) {
        effectiveProductsPayload = cachedProductsPayload;
        if (!state.catalogCacheNoticeShown) {
          appendSyncFeedback(
            state,
            "Catalog: usando cache local de produtos enquanto o catalogo remoto retorna vazio.",
          );
          state.catalogCacheNoticeShown = true;
        }
      }
    }

    state.integration = integrationPayload.integration || null;
    state.abc.lastPayload = abcPayload?.abc || null;
    renderIntegrationStatus(state, integrationPayload);
    renderWorkspace(
      state,
      dashboard,
      projectionPayload,
      abcPayload,
      effectiveProductsPayload,
      ordersPayload,
      financePayload,
      threadsPayload,
      syncRunsPayload,
    );
    await Promise.all([refreshProductDetail(state, effectiveProductsPayload.items || []), refreshOrderDetail(state, ordersPayload.items || [])]);

    state.patchNotesHistory = patchHistoryPayload?.items || [];
    renderPatchNotesHistory(state);

    if (state.canAccessAdmin) {
      state.adminUsers = adminPayload?.users || [];
      state.adminWorkspaces = adminWorkspacesPayload?.items || [];
      state.patchRecipients = patchRecipientsPayload?.users || [];
      renderAdminWorkspaceSelector(state, adminWorkspacesPayload);
      renderAdminCompanyIdentity(state, adminPayload?.workspace || dashboard.workspace || {});
      renderAdminStatus(state, adminPayload);
      renderAdminUsers(state);
      renderPatchRecipients(state);
    }

    renderSalesReportPreview(state.salesReport.lastPayload);
    setText("workspace-status-text", "Painel sincronizado e pronto");
  } catch (error) {
    renderFallback(state, error);
    setText("workspace-status-text", "Painel carregado com dados parciais");
  }
}

async function fetchJson(url, options) {
  const requestOptions = options && typeof options === "object" ? { ...options } : {};
  const cacheMode = requestOptions.cacheMode;
  delete requestOptions.cacheMode;

  const method = String(requestOptions.method || "GET").toUpperCase();
  const shouldUseGetCache = method === "GET" && cacheMode !== "no-store";
  const cacheKey = shouldUseGetCache ? buildRequestCacheKey(url, method) : null;

  if (cacheKey) {
    const cached = readResponseCache(cacheKey);
    if (cached !== undefined) return deepClonePayload(cached);

    const inFlight = inFlightGetRequests.get(cacheKey);
    if (inFlight) {
      const awaited = await inFlight;
      return deepClonePayload(awaited);
    }
  }

  const requestPromise = (async () => {
    const response = await fetch(url, requestOptions);
    const rawText = await response.text();
    const text = String(rawText || "").trim();
    let payload = null;

    if (text) {
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      const shouldParseJson =
        contentType.includes("application/json") ||
        text.startsWith("{") ||
        text.startsWith("[");

      if (shouldParseJson) {
        try {
          payload = JSON.parse(text);
        } catch (_error) {
          payload = null;
        }
      }
    }

    if (!response.ok) {
      if (response.status === 402 && isPaymentRequiredPayload(payload)) {
        redirectToSubscriptionRenewal();
      }
      const fallbackMessage = text
        ? text.slice(0, 180)
        : `Falha ao carregar dados (status ${response.status}).`;
      const error = new Error(payload?.error || payload?.message || fallbackMessage);
      error.status = response.status;
      error.payload = payload;
      error.raw = text || null;
      throw error;
    }

    if (payload && typeof payload === "object") return payload;
    return {
      ok: true,
      status: response.status,
      data: text || null,
    };
  })();

  if (!cacheKey) return requestPromise;

  inFlightGetRequests.set(cacheKey, requestPromise);
  try {
    const resolved = await requestPromise;
    writeResponseCache(cacheKey, resolved, GET_RESPONSE_CACHE_TTL_MS);
    return deepClonePayload(resolved);
  } finally {
    inFlightGetRequests.delete(cacheKey);
  }
}

function isPaymentRequiredPayload(payload) {
  const code = String(payload?.code || payload?.reason || "").toUpperCase();
  return (
    code === "PAYMENT_REQUIRED" ||
    code === "SUBSCRIPTION_INACTIVE" ||
    /payment|required|assinatura|subscription/i.test(
      String(payload?.error || payload?.message || ""),
    )
  );
}

function redirectToSubscriptionRenewal() {
  const path = String(window.location.pathname || "");
  if (path.includes("selecao-plataforma") || path.includes("login")) return;

  const key = "davantti_payment_required_redirect_at";
  const now = Date.now();
  const last = Number(sessionStorage.getItem(key) || 0);
  if (Number.isFinite(last) && now - last < 1500) return;

  sessionStorage.setItem(key, String(now));
  window.location.assign("/selecao-plataforma?subscription=expired");
}

function buildRequestCacheKey(url, method) {
  return `${String(method || "GET").toUpperCase()}::${String(url || "")}`;
}

function readResponseCache(cacheKey) {
  const entry = responseCache.get(cacheKey);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(cacheKey);
    return undefined;
  }
  return entry.payload;
}

function writeResponseCache(cacheKey, payload, ttlMs) {
  responseCache.set(cacheKey, {
    payload: deepClonePayload(payload),
    expiresAt: Date.now() + Math.max(1000, Number(ttlMs || GET_RESPONSE_CACHE_TTL_MS)),
  });
}

function clearWorkspaceRequestCache() {
  responseCache.clear();
  inFlightGetRequests.clear();
}

function deepClonePayload(payload) {
  if (payload == null || typeof payload !== "object") return payload;
  try {
    return JSON.parse(JSON.stringify(payload));
  } catch (_error) {
    return payload;
  }
}

function getCatalogProductsCacheKey(state) {
  const workspaceId = String(state?.workspaceId || "default").trim() || "default";
  return `${PRODUCT_CACHE_PREFIX}:${workspaceId}`;
}

function slimCatalogProductItem(item) {
  const product = item && typeof item === "object" ? item : {};
  return {
    id: product.id || null,
    sku: product.sku || null,
    title: product.title || null,
    status: product.status || null,
    currentPrice: Number(product.currentPrice || 0),
    stock: Number(product.stock || 0),
    revenueAmount: Number(product.revenueAmount || 0),
    categoryName: product.categoryName || null,
    lastSyncedAt: product.lastSyncedAt || null,
    updatedAt: product.updatedAt || null,
  };
}

function writeCatalogProductsCache(state, payload) {
  try {
    const items = Array.isArray(payload?.items) ? payload.items.slice(0, 800).map(slimCatalogProductItem) : [];
    const cacheEntry = {
      total: Number(payload?.total || items.length || 0),
      limit: Number(payload?.limit || items.length || 20),
      offset: Number(payload?.offset || 0),
      items,
      cachedAt: Date.now(),
    };
    localStorage.setItem(getCatalogProductsCacheKey(state), JSON.stringify(cacheEntry));
  } catch (_error) {
    // ignore local cache write failures
  }
}

function readCatalogProductsCache(state) {
  try {
    const raw = localStorage.getItem(getCatalogProductsCacheKey(state));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const cachedAt = Number(parsed.cachedAt || 0);
    if (!cachedAt || Date.now() - cachedAt > PRODUCT_CACHE_TTL_MS) return null;
    return {
      total: Number(parsed.total || 0),
      limit: Number(parsed.limit || 20),
      offset: Number(parsed.offset || 0),
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch (_error) {
    return null;
  }
}

function bindTabs() {
  const tabs = Array.from(document.querySelectorAll("[data-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-panel]"));

  function activate(tabName) {
    tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabName));
    panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === tabName));
    history.replaceState(null, "", `#${tabName}`);
  }

  tabs.forEach((tab) => tab.addEventListener("click", () => activate(tab.dataset.tab)));

  const initial = window.location.hash.replace("#", "");
  if (initial && tabs.some((tab) => tab.dataset.tab === initial && !tab.hidden)) {
    activate(initial);
  }
}

function bindThemeToggle() {
  document.body.classList.add("theme-light");
  document.body.classList.remove("theme-dark");
}

function bindSidebarCollapse() {
  const button = document.getElementById("sidebar-collapse");
  const app = document.querySelector(".workspace-app");
  if (!button || !app) return;

  if (sessionStorage.getItem("madeira-sidebar-collapsed") === "true") {
    app.classList.add("sidebar-collapsed");
  }

  button.addEventListener("click", () => {
    app.classList.toggle("sidebar-collapsed");
    sessionStorage.setItem(
      "madeira-sidebar-collapsed",
      app.classList.contains("sidebar-collapsed") ? "true" : "false",
    );
  });
}

function readSession() {
  const keys = ["madeira-demo-session"];
  for (const key of keys) {
    try {
      const localValue = localStorage.getItem(key);
      if (localValue) {
        const parsed = JSON.parse(localValue);
        try {
          sessionStorage.setItem(key, JSON.stringify(parsed));
        } catch (_error) {
          // ignore
        }
        return parsed || {};
      }
    } catch (_error) {
      // ignore
    }

    try {
      const sessionValue = sessionStorage.getItem(key);
      if (sessionValue) return JSON.parse(sessionValue) || {};
    } catch (_error) {
      // ignore
    }
  }

  return {};
}

function persistSession(nextSession) {
  const serialized = JSON.stringify(nextSession || {});
  try {
    sessionStorage.setItem("madeira-demo-session", serialized);
  } catch (_error) {
    // ignore
  }
  try {
    localStorage.setItem("madeira-demo-session", serialized);
  } catch (_error) {
    // ignore
  }
}

function isMasterAdmin(user) {
  const email = String(user?.email || "").trim().toLowerCase();
  return Boolean(user?.isMaster) || email === "araphael.fialho@gmail.com";
}

function applyAdminVisibility(state) {
  document.querySelectorAll('[data-admin-only="true"]').forEach((element) => {
    element.hidden = !state.canAccessAdmin;
  });

  if (!state.canAccessAdmin && window.location.hash === "#admin") {
    window.location.hash = "#overview";
  }
}

function hydrateSession(state) {
  const session = state.session || {};
  if (session?.user?.name) setText("user-name", session.user.name);
  if (session?.user?.role) setText("user-role", normalizeLabel(session.user.role));
}

function initializeDates(state) {
  const range = getPresetDateRange(state.period || "current_month");
  state.financeDateTo = range.dateTo;
  state.financeDateFrom = range.dateFrom;
  state.views.orders.dateFrom = state.financeDateFrom;
  state.views.orders.dateTo = state.financeDateTo;
  state.views.finance.dateFrom = state.financeDateFrom;
  state.views.finance.dateTo = state.financeDateTo;
  state.analytics.dateFrom = state.financeDateFrom;
  state.analytics.dateTo = state.financeDateTo;
  state.abc.dateFrom = state.financeDateFrom;
  state.abc.dateTo = state.financeDateTo;
  state.abc.metric = state.abc.metric || "revenue";
  state.abc.limit = state.abc.limit || 200;
  state.salesReport.dateFrom = state.financeDateFrom;
  state.salesReport.dateTo = state.financeDateTo;

  const compareRange = getPreviousComparisonRange(state.financeDateFrom, state.financeDateTo);
  state.analytics.compareFrom = compareRange.dateFrom;
  state.analytics.compareTo = compareRange.dateTo;
  setInputValue("finance-date-from", state.financeDateFrom);
  setInputValue("finance-date-to", state.financeDateTo);
  setInputValue("orders-date-from", state.views.orders.dateFrom);
  setInputValue("orders-date-to", state.views.orders.dateTo);
  setInputValue("finance-filter-from", state.views.finance.dateFrom);
  setInputValue("finance-filter-to", state.views.finance.dateTo);
  setSelectValue("period-select", state.period);
  setSelectValue("analytics-period-select", state.period);
  setInputValue("analytics-date-from", state.analytics.dateFrom);
  setInputValue("analytics-date-to", state.analytics.dateTo);
  setInputValue("analytics-compare-from", state.analytics.compareFrom);
  setInputValue("analytics-compare-to", state.analytics.compareTo);
  setSelectValue("dash-period-select", state.period);
  setInputValue("dash-date-from", state.analytics.dateFrom);
  setInputValue("dash-date-to", state.analytics.dateTo);
  setInputValue("dash-date-range", `${formatShortDate(state.analytics.dateFrom)} - ${formatShortDate(state.analytics.dateTo)}`);
  setInputValue("sales-report-date-from", state.salesReport.dateFrom);
  setInputValue("sales-report-date-to", state.salesReport.dateTo);
}

function getCurrentMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    dateFrom: formatLocalDateKey(start),
    dateTo: formatLocalDateKey(now),
  };
}

function getPresetDateRange(period) {
  const normalized = String(period || "current_month").trim().toLowerCase();
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  let start = new Date(end);

  if (normalized === "current_month") {
    start = new Date(end.getFullYear(), end.getMonth(), 1);
  } else {
    const match = normalized.match(/^(\d+)(d|m|y)$/);
    if (!match) return getCurrentMonthRange();
    const amount = Number.parseInt(match[1], 10) || 30;
    const unit = match[2];
    if (unit === "d") {
      start.setDate(start.getDate() - amount + 1);
    } else if (unit === "m") {
      start.setMonth(start.getMonth() - amount);
      start.setDate(start.getDate() + 1);
    } else {
      start.setFullYear(start.getFullYear() - amount);
      start.setDate(start.getDate() + 1);
    }
  }

  start.setHours(0, 0, 0, 0);
  return {
    dateFrom: formatLocalDateKey(start),
    dateTo: formatLocalDateKey(end),
  };
}

function getPreviousComparisonRange(dateFrom, dateTo) {
  const start = new Date(`${String(dateFrom || "").slice(0, 10)}T00:00:00`);
  const end = new Date(`${String(dateTo || "").slice(0, 10)}T23:59:59`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    const fallback = getCurrentMonthRange();
    const fallbackStart = new Date(`${fallback.dateFrom}T00:00:00`);
    const fallbackPreviousStart = new Date(fallbackStart);
    fallbackPreviousStart.setMonth(fallbackPreviousStart.getMonth() - 1);
    const fallbackPreviousEnd = new Date(fallbackStart);
    fallbackPreviousEnd.setDate(fallbackPreviousEnd.getDate() - 1);
    return {
      dateFrom: formatLocalDateKey(fallbackPreviousStart),
      dateTo: formatLocalDateKey(fallbackPreviousEnd),
    };
  }

  const spanMs = end.getTime() - start.getTime();
  const previousEnd = new Date(start.getTime() - 1);
  const previousStart = new Date(previousEnd.getTime() - spanMs);
  previousStart.setHours(0, 0, 0, 0);
  previousEnd.setHours(23, 59, 59, 999);
  return {
    dateFrom: formatLocalDateKey(previousStart),
    dateTo: formatLocalDateKey(previousEnd),
  };
}

function bindQuickNavigation() {
  const button = document.getElementById("exec-open-analytics");
  if (!button) return;
  button.addEventListener("click", () => {
    const analyticsTab = document.querySelector('[data-tab="analytics"]');
    if (analyticsTab) analyticsTab.click();
  });
}

function bindAdminSubTabs() {
  const tabs = Array.from(document.querySelectorAll("[data-admin-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-admin-panel]"));
  if (!tabs.length || !panels.length) return;

  const activate = (tabName) => {
    tabs.forEach((tab) => tab.classList.toggle("is-active", tab.getAttribute("data-admin-tab") === tabName));
    panels.forEach((panel) => panel.classList.toggle("is-active", panel.getAttribute("data-admin-panel") === tabName));
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activate(tab.getAttribute("data-admin-tab")));
  });

  activate(tabs[0].getAttribute("data-admin-tab"));
}

function bindPeriodFilter(state) {
  const select = document.getElementById("period-select");
  const financeDateFrom = document.getElementById("finance-date-from");
  const financeDateTo = document.getElementById("finance-date-to");

  if (select) {
    select.value = state.period;
    select.addEventListener("change", async () => {
      state.period = select.value || "current_month";
      const range = getPresetDateRange(state.period);
      const compareRange = getPreviousComparisonRange(range.dateFrom, range.dateTo);
      state.financeDateFrom = range.dateFrom;
      state.financeDateTo = range.dateTo;
      state.views.orders.dateFrom = range.dateFrom;
      state.views.orders.dateTo = range.dateTo;
      state.views.finance.dateFrom = range.dateFrom;
      state.views.finance.dateTo = range.dateTo;
      state.analytics.dateFrom = range.dateFrom;
      state.analytics.dateTo = range.dateTo;
      state.analytics.compareFrom = compareRange.dateFrom;
      state.analytics.compareTo = compareRange.dateTo;
      state.abc.dateFrom = range.dateFrom;
      state.abc.dateTo = range.dateTo;
      state.salesReport.dateFrom = range.dateFrom;
      state.salesReport.dateTo = range.dateTo;
      setSelectValue("analytics-period-select", state.period);
      setSelectValue("dash-period-select", state.period);
      setInputValue("finance-date-from", range.dateFrom);
      setInputValue("finance-date-to", range.dateTo);
      setInputValue("orders-date-from", state.views.orders.dateFrom);
      setInputValue("orders-date-to", state.views.orders.dateTo);
      setInputValue("finance-filter-from", state.views.finance.dateFrom);
      setInputValue("finance-filter-to", state.views.finance.dateTo);
      setInputValue("analytics-date-from", state.analytics.dateFrom);
      setInputValue("analytics-date-to", state.analytics.dateTo);
      setInputValue("analytics-compare-from", state.analytics.compareFrom);
      setInputValue("analytics-compare-to", state.analytics.compareTo);
      setInputValue("dash-date-from", state.analytics.dateFrom);
      setInputValue("dash-date-to", state.analytics.dateTo);
      setInputValue("dash-date-range", `${formatShortDate(state.analytics.dateFrom)} - ${formatShortDate(state.analytics.dateTo)}`);
      setInputValue("sales-report-date-from", state.salesReport.dateFrom);
      setInputValue("sales-report-date-to", state.salesReport.dateTo);
      setInputValue("abc-date-from", state.abc.dateFrom);
      setInputValue("abc-date-to", state.abc.dateTo);
      await refreshWorkspace(state);
    });
  }

  if (financeDateFrom) {
    financeDateFrom.addEventListener("change", () => {
      state.financeDateFrom = financeDateFrom.value;
      state.views.finance.dateFrom = financeDateFrom.value;
      setInputValue("finance-filter-from", financeDateFrom.value);
    });
  }

  if (financeDateTo) {
    financeDateTo.addEventListener("change", () => {
      state.financeDateTo = financeDateTo.value;
      state.views.finance.dateTo = financeDateTo.value;
      setInputValue("finance-filter-to", financeDateTo.value);
    });
  }
}

function bindDataExplorer(state) {
  bindFilterForm(state, "catalog-filter-form", () => {
    state.views.catalog.search = document.getElementById("catalog-search")?.value?.trim() || "";
    state.views.catalog.status = document.getElementById("catalog-status")?.value || "";
    state.views.catalog.stockState = document.getElementById("catalog-stock-state")?.value || "";
    state.views.catalog.sort = document.getElementById("catalog-sort")?.value || "updated_desc";
    state.views.catalog.limit = toInteger(document.getElementById("catalog-limit")?.value, 20);
    state.views.catalog.offset = 0;
    refreshWorkspace(state);
  });
  bindClearButton("catalog-clear", () => {
    state.views.catalog = { ...state.views.catalog, search: "", status: "", stockState: "", sort: "updated_desc", limit: 20, offset: 0 };
    setInputValue("catalog-search", "");
    setSelectValue("catalog-status", "");
    setSelectValue("catalog-stock-state", "");
    setSelectValue("catalog-sort", "updated_desc");
    setSelectValue("catalog-limit", "20");
    refreshWorkspace(state);
  });
  bindPager(state, "catalog-prev", "catalog-next", "catalog");

  bindFilterForm(state, "orders-filter-form", () => {
    state.views.orders.search = document.getElementById("orders-search")?.value?.trim() || "";
    state.views.orders.status = document.getElementById("orders-status")?.value || "";
    state.views.orders.dateFrom = document.getElementById("orders-date-from")?.value || "";
    state.views.orders.dateTo = document.getElementById("orders-date-to")?.value || "";
    state.views.orders.limit = toInteger(document.getElementById("orders-limit")?.value, 20);
    state.views.orders.offset = 0;
    refreshWorkspace(state);
  });
  bindClearButton("orders-clear", () => {
    state.views.orders = {
      ...state.views.orders,
      search: "",
      status: "",
      dateFrom: state.financeDateFrom || "",
      dateTo: state.financeDateTo || "",
      limit: 20,
      offset: 0,
    };
    setInputValue("orders-search", "");
    setSelectValue("orders-status", "");
    setInputValue("orders-date-from", state.views.orders.dateFrom);
    setInputValue("orders-date-to", state.views.orders.dateTo);
    setSelectValue("orders-limit", "20");
    refreshWorkspace(state);
  });
  bindPager(state, "orders-prev", "orders-next", "orders");

  bindFilterForm(state, "finance-filter-form", () => {
    state.views.finance.search = document.getElementById("finance-search")?.value?.trim() || "";
    state.views.finance.status = document.getElementById("finance-status")?.value || "";
    state.views.finance.dateFrom = document.getElementById("finance-filter-from")?.value || "";
    state.views.finance.dateTo = document.getElementById("finance-filter-to")?.value || "";
    state.financeDateFrom = state.views.finance.dateFrom || state.financeDateFrom;
    state.financeDateTo = state.views.finance.dateTo || state.financeDateTo;
    setInputValue("finance-date-from", state.financeDateFrom);
    setInputValue("finance-date-to", state.financeDateTo);
    state.views.finance.limit = toInteger(document.getElementById("finance-limit")?.value, 20);
    state.views.finance.offset = 0;
    refreshWorkspace(state);
  });
  bindClearButton("finance-clear", () => {
    state.views.finance = {
      ...state.views.finance,
      search: "",
      status: "",
      dateFrom: state.financeDateFrom || "",
      dateTo: state.financeDateTo || "",
      limit: 20,
      offset: 0,
    };
    setInputValue("finance-search", "");
    setSelectValue("finance-status", "");
    setInputValue("finance-filter-from", state.views.finance.dateFrom);
    setInputValue("finance-filter-to", state.views.finance.dateTo);
    setSelectValue("finance-limit", "20");
    refreshWorkspace(state);
  });
  bindPager(state, "finance-prev", "finance-next", "finance");

  bindFilterForm(state, "messaging-filter-form", () => {
    state.views.messaging.search = document.getElementById("messaging-search")?.value?.trim() || "";
    state.views.messaging.status = document.getElementById("messaging-status")?.value || "";
    state.views.messaging.unreadOnly = Boolean(document.getElementById("messaging-unread-only")?.checked);
    state.views.messaging.limit = toInteger(document.getElementById("messaging-limit")?.value, 20);
    state.views.messaging.offset = 0;
    refreshWorkspace(state);
  });
  bindClearButton("messaging-clear", () => {
    state.views.messaging = { ...state.views.messaging, search: "", status: "", unreadOnly: false, limit: 20, offset: 0 };
    setInputValue("messaging-search", "");
    setSelectValue("messaging-status", "");
    setChecked("messaging-unread-only", false);
    setSelectValue("messaging-limit", "20");
    refreshWorkspace(state);
  });
  bindPager(state, "messaging-prev", "messaging-next", "messaging");

  const catalogTable = document.getElementById("catalog-products-table");
  if (catalogTable) {
    catalogTable.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-product-id]");
      if (!button) return;
      state.views.catalog.selectedId = button.getAttribute("data-product-id") || "";
      await refreshProductDetail(state);
    });
  }

  const ordersTable = document.getElementById("orders-table");
  if (ordersTable) {
    ordersTable.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-order-id]");
      if (!button) return;
      state.views.orders.selectedId = button.getAttribute("data-order-id") || "";
      await refreshOrderDetail(state);
    });
  }
}

function bindSalesReportActions(state) {
  const form = document.getElementById("sales-report-form");
  const exportCsv = document.getElementById("sales-report-export-csv");
  const exportJson = document.getElementById("sales-report-export-json");

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await previewSalesReport(state);
    });
  }

  if (exportCsv) {
    exportCsv.addEventListener("click", () => {
      syncSalesReportFilters(state);
      triggerDownload(buildDataUrl(state, "api/reports/sales", {
        period: state.period,
        dateFrom: state.salesReport.dateFrom,
        dateTo: state.salesReport.dateTo,
        orderIds: state.salesReport.orderIds,
        productIds: state.salesReport.productIds,
        format: "csv",
      }));
    });
  }

  if (exportJson) {
    exportJson.addEventListener("click", () => {
      syncSalesReportFilters(state);
      triggerDownload(buildDataUrl(state, "api/reports/sales", {
        period: state.period,
        dateFrom: state.salesReport.dateFrom,
        dateTo: state.salesReport.dateTo,
        orderIds: state.salesReport.orderIds,
        productIds: state.salesReport.productIds,
        format: "json",
      }));
    });
  }
}

function bindDashboardFilters(state) {
  const periodSelect = document.getElementById("dash-period-select");
  const dashDateFrom = document.getElementById("dash-date-from");
  const dashDateTo = document.getElementById("dash-date-to");
  const monthButton = document.getElementById("dash-current-month");
  const applyButton = document.getElementById("dash-apply-filters");

  if (periodSelect) {
    periodSelect.value = state.period || "current_month";
    periodSelect.addEventListener("change", () => {
      state.period = periodSelect.value || "current_month";
      const range = getPresetDateRange(state.period);
      const compareRange = getPreviousComparisonRange(range.dateFrom, range.dateTo);
      state.financeDateFrom = range.dateFrom;
      state.financeDateTo = range.dateTo;
      state.analytics.dateFrom = range.dateFrom;
      state.analytics.dateTo = range.dateTo;
      state.analytics.compareFrom = compareRange.dateFrom;
      state.analytics.compareTo = compareRange.dateTo;
      state.views.orders.dateFrom = range.dateFrom;
      state.views.orders.dateTo = range.dateTo;
      state.views.finance.dateFrom = range.dateFrom;
      state.views.finance.dateTo = range.dateTo;
      state.abc.dateFrom = range.dateFrom;
      state.abc.dateTo = range.dateTo;
      state.salesReport.dateFrom = range.dateFrom;
      state.salesReport.dateTo = range.dateTo;
      setSelectValue("period-select", state.period);
      setSelectValue("analytics-period-select", state.period);
      if (dashDateFrom) dashDateFrom.value = range.dateFrom;
      if (dashDateTo) dashDateTo.value = range.dateTo;
      setInputValue("dash-date-range", `${formatShortDate(range.dateFrom)} - ${formatShortDate(range.dateTo)}`);
      setInputValue("analytics-date-from", range.dateFrom);
      setInputValue("analytics-date-to", range.dateTo);
      setInputValue("analytics-compare-from", compareRange.dateFrom);
      setInputValue("analytics-compare-to", compareRange.dateTo);
      setInputValue("finance-date-from", range.dateFrom);
      setInputValue("finance-date-to", range.dateTo);
      setInputValue("orders-date-from", range.dateFrom);
      setInputValue("orders-date-to", range.dateTo);
      setInputValue("finance-filter-from", range.dateFrom);
      setInputValue("finance-filter-to", range.dateTo);
      setInputValue("sales-report-date-from", range.dateFrom);
      setInputValue("sales-report-date-to", range.dateTo);
      setInputValue("abc-date-from", range.dateFrom);
      setInputValue("abc-date-to", range.dateTo);
    });
  }

  if (dashDateFrom) dashDateFrom.value = state.analytics.dateFrom || state.financeDateFrom || "";
  if (dashDateTo) dashDateTo.value = state.analytics.dateTo || state.financeDateTo || "";

  if (applyButton) {
    applyButton.addEventListener("click", async () => {
      const nextDateFrom = dashDateFrom?.value || state.financeDateFrom || "";
      const nextDateTo = dashDateTo?.value || state.financeDateTo || "";
      state.analytics.dateFrom = nextDateFrom;
      state.analytics.dateTo = nextDateTo;
      setInputValue("analytics-date-from", nextDateFrom);
      setInputValue("analytics-date-to", nextDateTo);
      setInputValue("dash-date-range", `${formatShortDate(nextDateFrom)} - ${formatShortDate(nextDateTo)}`);
      await refreshWorkspace(state);
    });
  }

  if (monthButton) {
    monthButton.addEventListener("click", async () => {
      state.period = "current_month";
      setSelectValue("period-select", state.period);
      setSelectValue("analytics-period-select", state.period);
      setSelectValue("dash-period-select", state.period);
      const range = getPresetDateRange("current_month");
      const compareRange = getPreviousComparisonRange(range.dateFrom, range.dateTo);
      state.financeDateFrom = range.dateFrom;
      state.financeDateTo = range.dateTo;
      state.analytics.dateFrom = range.dateFrom;
      state.analytics.dateTo = range.dateTo;
      state.analytics.compareFrom = compareRange.dateFrom;
      state.analytics.compareTo = compareRange.dateTo;
      if (dashDateFrom) dashDateFrom.value = range.dateFrom;
      if (dashDateTo) dashDateTo.value = range.dateTo;
      setInputValue("analytics-date-from", range.dateFrom);
      setInputValue("analytics-date-to", range.dateTo);
      setInputValue("analytics-compare-from", compareRange.dateFrom);
      setInputValue("analytics-compare-to", compareRange.dateTo);
      setInputValue("dash-date-range", `${formatShortDate(range.dateFrom)} - ${formatShortDate(range.dateTo)}`);
      await refreshWorkspace(state);
    });
  }
}

function bindAnalyticsFilters(state) {
  const form = document.getElementById("analytics-filter-form");
  const clearButton = document.getElementById("analytics-clear");
  const periodSelect = document.getElementById("analytics-period-select");

  if (periodSelect) {
    periodSelect.value = state.period || "current_month";
    periodSelect.addEventListener("change", () => {
      state.period = periodSelect.value || "current_month";
      const range = getPresetDateRange(state.period);
      const compareRange = getPreviousComparisonRange(range.dateFrom, range.dateTo);
      state.analytics.dateFrom = range.dateFrom;
      state.analytics.dateTo = range.dateTo;
      state.analytics.compareFrom = compareRange.dateFrom;
      state.analytics.compareTo = compareRange.dateTo;
      setSelectValue("period-select", state.period);
      setSelectValue("dash-period-select", state.period);
      setInputValue("analytics-date-from", range.dateFrom);
      setInputValue("analytics-date-to", range.dateTo);
      setInputValue("analytics-compare-from", compareRange.dateFrom);
      setInputValue("analytics-compare-to", compareRange.dateTo);
      setInputValue("dash-date-from", range.dateFrom);
      setInputValue("dash-date-to", range.dateTo);
      setInputValue("dash-date-range", `${formatShortDate(range.dateFrom)} - ${formatShortDate(range.dateTo)}`);
    });
  }

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      state.period = document.getElementById("analytics-period-select")?.value || state.period || "current_month";
      const selectedDateFrom = document.getElementById("analytics-date-from")?.value || "";
      const selectedDateTo = document.getElementById("analytics-date-to")?.value || "";
      if (selectedDateFrom && selectedDateTo) {
        state.analytics.dateFrom = selectedDateFrom;
        state.analytics.dateTo = selectedDateTo;
      } else {
        const range = getPresetDateRange(state.period);
        state.analytics.dateFrom = range.dateFrom;
        state.analytics.dateTo = range.dateTo;
      }

      state.financeDateFrom = state.analytics.dateFrom || state.financeDateFrom;
      state.financeDateTo = state.analytics.dateTo || state.financeDateTo;
      state.views.orders.dateFrom = state.analytics.dateFrom || state.views.orders.dateFrom;
      state.views.orders.dateTo = state.analytics.dateTo || state.views.orders.dateTo;
      state.views.finance.dateFrom = state.analytics.dateFrom || state.views.finance.dateFrom;
      state.views.finance.dateTo = state.analytics.dateTo || state.views.finance.dateTo;
      state.abc.dateFrom = state.analytics.dateFrom || state.abc.dateFrom;
      state.abc.dateTo = state.analytics.dateTo || state.abc.dateTo;
      state.salesReport.dateFrom = state.analytics.dateFrom || state.salesReport.dateFrom;
      state.salesReport.dateTo = state.analytics.dateTo || state.salesReport.dateTo;

      const compareFromInput = document.getElementById("analytics-compare-from")?.value || "";
      const compareToInput = document.getElementById("analytics-compare-to")?.value || "";
      if (compareFromInput && compareToInput) {
        state.analytics.compareFrom = compareFromInput;
        state.analytics.compareTo = compareToInput;
      } else {
        const compareRange = getPreviousComparisonRange(state.analytics.dateFrom, state.analytics.dateTo);
        state.analytics.compareFrom = compareRange.dateFrom;
        state.analytics.compareTo = compareRange.dateTo;
      }
      setSelectValue("period-select", state.period);
      setSelectValue("dash-period-select", state.period);
      setInputValue("finance-date-from", state.financeDateFrom || "");
      setInputValue("finance-date-to", state.financeDateTo || "");
      setInputValue("orders-date-from", state.views.orders.dateFrom || "");
      setInputValue("orders-date-to", state.views.orders.dateTo || "");
      setInputValue("finance-filter-from", state.views.finance.dateFrom || "");
      setInputValue("finance-filter-to", state.views.finance.dateTo || "");
      setInputValue("dash-date-from", state.analytics.dateFrom || "");
      setInputValue("dash-date-to", state.analytics.dateTo || "");
      setInputValue("dash-date-range", `${formatShortDate(state.analytics.dateFrom)} - ${formatShortDate(state.analytics.dateTo)}`);
      setInputValue("sales-report-date-from", state.salesReport.dateFrom || "");
      setInputValue("sales-report-date-to", state.salesReport.dateTo || "");
      setInputValue("abc-date-from", state.abc.dateFrom || "");
      setInputValue("abc-date-to", state.abc.dateTo || "");
      await refreshWorkspace(state);
    });
  }

  if (clearButton) {
    clearButton.addEventListener("click", async () => {
      state.period = "current_month";
      const range = getPresetDateRange(state.period);
      const compareRange = getPreviousComparisonRange(range.dateFrom, range.dateTo);

      state.financeDateFrom = range.dateFrom;
      state.financeDateTo = range.dateTo;
      state.analytics.dateFrom = range.dateFrom;
      state.analytics.dateTo = range.dateTo;
      state.analytics.compareFrom = compareRange.dateFrom;
      state.analytics.compareTo = compareRange.dateTo;
      state.views.orders.dateFrom = range.dateFrom;
      state.views.orders.dateTo = range.dateTo;
      state.views.finance.dateFrom = range.dateFrom;
      state.views.finance.dateTo = range.dateTo;
      state.abc.dateFrom = range.dateFrom;
      state.abc.dateTo = range.dateTo;
      state.salesReport.dateFrom = range.dateFrom;
      state.salesReport.dateTo = range.dateTo;
      setSelectValue("period-select", state.period);
      setSelectValue("dash-period-select", state.period);
      setSelectValue("analytics-period-select", state.period);
      setInputValue("finance-date-from", state.financeDateFrom);
      setInputValue("finance-date-to", state.financeDateTo);
      setInputValue("orders-date-from", state.views.orders.dateFrom);
      setInputValue("orders-date-to", state.views.orders.dateTo);
      setInputValue("finance-filter-from", state.views.finance.dateFrom);
      setInputValue("finance-filter-to", state.views.finance.dateTo);
      setInputValue("analytics-date-from", state.analytics.dateFrom);
      setInputValue("analytics-date-to", state.analytics.dateTo);
      setInputValue("analytics-compare-from", state.analytics.compareFrom);
      setInputValue("analytics-compare-to", state.analytics.compareTo);
      setInputValue("dash-date-from", state.analytics.dateFrom);
      setInputValue("dash-date-to", state.analytics.dateTo);
      setInputValue("dash-date-range", `${formatShortDate(state.analytics.dateFrom)} - ${formatShortDate(state.analytics.dateTo)}`);
      setInputValue("sales-report-date-from", state.salesReport.dateFrom);
      setInputValue("sales-report-date-to", state.salesReport.dateTo);
      setInputValue("abc-date-from", state.abc.dateFrom);
      setInputValue("abc-date-to", state.abc.dateTo);
      await refreshWorkspace(state);
    });
  }
}

function bindAbcActions(state) {
  if (!state.abc.dateFrom) state.abc.dateFrom = state.financeDateFrom || "";
  if (!state.abc.dateTo) state.abc.dateTo = state.financeDateTo || "";
  setInputValue("abc-date-from", state.abc.dateFrom || state.financeDateFrom || "");
  setInputValue("abc-date-to", state.abc.dateTo || state.financeDateTo || "");
  setSelectValue("abc-metric", state.abc.metric || "revenue");
  setSelectValue("abc-limit", String(state.abc.limit || 200));
  setInputValue("abc-order-ids", state.abc.orderIds || "");
  setInputValue("abc-product-ids", state.abc.productIds || "");

  bindFilterForm(state, "abc-filter-form", () => {
    syncAbcFilters(state);
    refreshWorkspace(state);
  });

  bindClearButton("abc-clear", () => {
    state.abc = {
      ...state.abc,
      dateFrom: state.financeDateFrom || "",
      dateTo: state.financeDateTo || "",
      metric: "revenue",
      limit: 200,
      orderIds: "",
      productIds: "",
    };
    setInputValue("abc-date-from", state.abc.dateFrom);
    setInputValue("abc-date-to", state.abc.dateTo);
    setSelectValue("abc-metric", "revenue");
    setSelectValue("abc-limit", "200");
    setInputValue("abc-order-ids", "");
    setInputValue("abc-product-ids", "");
    refreshWorkspace(state);
  });
}

function syncAbcFilters(state) {
  state.abc.dateFrom = document.getElementById("abc-date-from")?.value || state.financeDateFrom || "";
  state.abc.dateTo = document.getElementById("abc-date-to")?.value || state.financeDateTo || "";
  state.abc.metric = document.getElementById("abc-metric")?.value || "revenue";
  state.abc.limit = toInteger(document.getElementById("abc-limit")?.value, 200);
  state.abc.orderIds = document.getElementById("abc-order-ids")?.value || "";
  state.abc.productIds = document.getElementById("abc-product-ids")?.value || "";
}

function syncSalesReportFilters(state) {
  state.salesReport.dateFrom = document.getElementById("sales-report-date-from")?.value || "";
  state.salesReport.dateTo = document.getElementById("sales-report-date-to")?.value || "";
  state.salesReport.orderIds = document.getElementById("sales-report-order-ids")?.value || "";
  state.salesReport.productIds = document.getElementById("sales-report-product-ids")?.value || "";
}

async function previewSalesReport(state) {
  const previewButton = document.getElementById("sales-report-preview");

  try {
    syncSalesReportFilters(state);
    setLoading(previewButton, true, "Gerando...");
    const payload = await fetchJson(buildDataUrl(state, "api/reports/sales", {
      period: state.period,
      dateFrom: state.salesReport.dateFrom,
      dateTo: state.salesReport.dateTo,
      orderIds: state.salesReport.orderIds,
      productIds: state.salesReport.productIds,
    }));
    state.salesReport.lastPayload = payload.report || null;
    renderSalesReportPreview(state.salesReport.lastPayload);
  } catch (error) {
    renderSalesReportPreview(null, error.message);
  } finally {
    setLoading(previewButton, false, "Gerar resumo");
  }
}

function triggerDownload(url) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function bindFilterForm(state, formId, onApply) {
  const form = document.getElementById(formId);
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onApply(state);
  });
}

function bindClearButton(buttonId, onClear) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  button.addEventListener("click", onClear);
}

function bindPager(state, prevId, nextId, viewName) {
  const prev = document.getElementById(prevId);
  const next = document.getElementById(nextId);
  if (prev) {
    prev.addEventListener("click", () => {
      const view = state.views[viewName];
      view.offset = Math.max(0, view.offset - view.limit);
      refreshWorkspace(state);
    });
  }
  if (next) {
    next.addEventListener("click", () => {
      const view = state.views[viewName];
      if (view.offset + view.limit >= view.total) return;
      view.offset += view.limit;
      refreshWorkspace(state);
    });
  }
}

function bindSyncActions(state) {
  document.querySelectorAll("[data-sync-action]").forEach((button) => {
    if (button.dataset.syncAction === "messaging") {
      button.disabled = true;
      button.title = "Mensageria desabilitada temporariamente neste modulo.";
    }

    button.addEventListener("click", async () => {
      const action = button.dataset.syncAction;
      const previousLabel = button.textContent;

      if (action === "messaging") {
        appendSyncFeedback(state, "Messaging: sincronizacao desabilitada temporariamente.");
        renderSyncFeedback(state);
        return;
      }

      try {
        button.disabled = true;
        button.textContent = "Sincronizando...";
        appendSyncFeedback(state, `${normalizeLabel(action)}: sincronizacao iniciada.`);

        const result = await fetchJson(`api/sync/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildSyncPayload(state, action)),
        });

        appendSyncFeedback(state, `${normalizeLabel(action)}: ${describeSyncResult(result)}`);
        clearWorkspaceRequestCache();
        await refreshWorkspace(state);
      } catch (error) {
        appendSyncFeedback(state, `${normalizeLabel(action)}: falha ao sincronizar. ${error.message}`);
        renderSyncFeedback(state);
      } finally {
        button.disabled = false;
        button.textContent = previousLabel;
      }
    });
  });
}

function buildSyncPayload(state, action) {
  const payload = {
    workspaceId: state.workspaceId || undefined,
    actingUserEmail: state.session?.user?.email || undefined,
    requestedBy: state.session?.user?.email || state.session?.user?.name || "workspace",
  };

  if (action === "catalog") {
    return { ...payload, limit: state.views.catalog.limit, offset: state.views.catalog.offset };
  }

  if (action === "orders") {
    return {
      ...payload,
      limit: state.views.orders.limit,
      offset: state.views.orders.offset,
    };
  }

  if (action === "finance") {
    return {
      ...payload,
      dateFrom: state.views.finance.dateFrom || state.financeDateFrom,
      dateTo: state.views.finance.dateTo || state.financeDateTo,
      limit: state.views.finance.limit,
      offset: state.views.finance.offset,
    };
  }

  if (action === "messaging") {
    return { ...payload, limit: state.views.messaging.limit, offset: state.views.messaging.offset };
  }

  if (action === "all") {
    return {
      ...payload,
      catalog: { limit: state.views.catalog.limit, offset: state.views.catalog.offset },
      orders: { limit: state.views.orders.limit, offset: state.views.orders.offset },
      finance: {
        dateFrom: state.views.finance.dateFrom || state.financeDateFrom,
        dateTo: state.views.finance.dateTo || state.financeDateTo,
        limit: state.views.finance.limit,
        offset: state.views.finance.offset,
      },
      messaging: { limit: state.views.messaging.limit, offset: state.views.messaging.offset },
    };
  }

  return payload;
}

function bindIntegrationActions(state) {
  const form = document.getElementById("integration-form");
  const refreshButton = document.getElementById("integration-refresh");

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = document.getElementById("integration-submit");
      const token = document.getElementById("integration-token")?.value || "";

      try {
        if (!String(token).trim()) throw new Error("Cole o TOKENMM antes de conectar.");

        setLoading(submitButton, true, "Conectando...");
        setText("workspace-status-text", "Validando TOKENMM do seller");

        const result = await fetchJson("api/integration/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: state.workspaceId || undefined,
            apiToken: token,
            actingUserEmail: state.session?.user?.email || undefined,
            configuredBy: state.session?.user?.email || state.session?.user?.name || "workspace",
          }),
        });

        const sellerLabel = result.integration?.sellerName || result.workspace?.sellerName || "Seller conectado";
        state.integration = result.integration || null;
        appendSyncFeedback(state, `Integracao: token validado para ${sellerLabel}.`);
        updateIntegrationTokenField(result.integration);
        renderIntegrationStatus(state, {
          workspace: result.workspace,
          integration: result.integration,
        });
        clearWorkspaceRequestCache();
        await refreshWorkspace(state);
      } catch (error) {
        appendSyncFeedback(state, `Integracao: ${error.message}`);
        renderIntegrationStatus(state, {
          workspace: state.integration?.workspace || null,
          integration: state.integration || null,
          error: error.message,
        });
      } finally {
        setLoading(submitButton, false, "Conectar token");
      }
    });
  }

  if (refreshButton) {
    refreshButton.addEventListener("click", async () => {
      try {
        setLoading(refreshButton, true, "Atualizando...");
        const payload = await fetchJson(buildScopedUrl(state, "api/integration/status"));
        state.integration = payload.integration || null;
        renderIntegrationStatus(state, payload);
      } catch (error) {
        renderIntegrationStatus(state, { integration: state.integration, error: error.message });
      } finally {
        setLoading(refreshButton, false, "Atualizar status");
      }
    });
  }
}

function bindAdminActions(state) {
  const form = document.getElementById("admin-invite-form");
  const refreshButton = document.getElementById("admin-users-refresh");
  const table = document.getElementById("admin-users-table");
  const previewButton = document.getElementById("admin-release-preview");
  const sendButton = document.getElementById("admin-release-send");
  const companyForm = document.getElementById("admin-company-form");
  const companyDocumentType = document.getElementById("admin-company-document-type");
  const companyDocumentNumber = document.getElementById("admin-company-document-number");
  const workspaceSelect = document.getElementById("admin-workspace-select");
  const inviteWorkspaceSelect = document.getElementById("admin-user-workspace");

  if (workspaceSelect) {
    workspaceSelect.addEventListener("change", async () => {
      const nextWorkspaceId = String(workspaceSelect.value || "").trim();
      if (!nextWorkspaceId || nextWorkspaceId === state.workspaceId) return;
      state.workspaceId = nextWorkspaceId;
      if (inviteWorkspaceSelect) inviteWorkspaceSelect.value = nextWorkspaceId;
      await refreshWorkspace(state);
    });
  }

  if (companyDocumentType && companyDocumentNumber) {
    const applyDocumentMask = () => {
      companyDocumentNumber.value = formatIdentityDocumentInput(
        companyDocumentType.value,
        companyDocumentNumber.value,
      );
    };

    companyDocumentType.addEventListener("change", applyDocumentMask);
    companyDocumentNumber.addEventListener("input", applyDocumentMask);
  }

  if (companyForm) {
    companyForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!state.canAccessAdmin) return;
      const submitButton = document.getElementById("admin-company-submit");
      const sellerName = String(document.getElementById("admin-company-name")?.value || "").trim();
      const documentType = resolveIdentityDocumentType(
        companyDocumentType?.value,
        companyDocumentNumber?.value,
      );
      const documentNumber = normalizeIdentityDigits(companyDocumentNumber?.value || "");
      const tenantGlobalId = String(
        document.getElementById("admin-company-tenant-global-id")?.value || "",
      ).trim();

      if (!sellerName) {
        renderStack("admin-company-status-list", ["Informe o nome da empresa antes de salvar."]);
        return;
      }

      try {
        setLoading(submitButton, true, "Salvando...");
        const response = await fetchJson("api/admin/workspace", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: state.workspaceId || undefined,
            actingUserEmail: state.session?.user?.email,
            sellerName,
            documentType,
            documentNumber,
            tenantGlobalId,
          }),
        });

        renderAdminCompanyIdentity(state, response.workspace || {});
        renderAdminStatus(state, response);
        appendSyncFeedback(state, "Admin: identidade global do workspace atualizada.");
        clearWorkspaceRequestCache();
      } catch (error) {
        renderStack("admin-company-status-list", ["Identidade: " + error.message]);
      } finally {
        setLoading(submitButton, false, "Salvar identidade");
      }
    });
  }

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!state.canAccessAdmin) return;
      const submitButton = document.getElementById("admin-invite-submit");

      try {
        setLoading(submitButton, true, "Enviando...");
        const selectedInviteWorkspaceId =
          String(inviteWorkspaceSelect?.value || "").trim() || state.workspaceId || "";
        const response = await fetchJson("api/admin/users/invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: selectedInviteWorkspaceId || undefined,
            targetWorkspaceId: selectedInviteWorkspaceId || undefined,
            actingUserEmail: state.session?.user?.email,
            name: document.getElementById("admin-user-name")?.value || "",
            email: document.getElementById("admin-user-email")?.value || "",
            role: document.getElementById("admin-user-role")?.value || "viewer",
          }),
        });

        const invitedWorkspaceLabel =
          response.workspace?.sellerName || response.workspace?.slug || selectedInviteWorkspaceId || "workspace";
        appendSyncFeedback(
          state,
          `Admin: convite enviado para ${response.user?.email || "usuario"} na empresa ${invitedWorkspaceLabel}.`,
        );
        form.reset();
        if (inviteWorkspaceSelect) {
          inviteWorkspaceSelect.value = selectedInviteWorkspaceId;
        }
        renderAdminStatus(state, response);
        clearWorkspaceRequestCache();
        await refreshAdminUsers(state);
      } catch (error) {
        appendSyncFeedback(state, `Admin: ${error.message}`);
        renderAdminStatus(state, { error: error.message });
      } finally {
        setLoading(submitButton, false, "Enviar convite");
      }
    });
  }

  if (refreshButton) {
    refreshButton.addEventListener("click", async () => {
      await refreshAdminUsers(state, refreshButton);
    });
  }

  if (table) {
    table.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-admin-action]");
      if (!button || !state.canAccessAdmin) return;

      try {
        setLoading(button, true, "Processando...");
        if (button.dataset.adminAction === "invite") {
          await fetchJson(`api/admin/users/${encodeURIComponent(button.dataset.userId)}/invite`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workspaceId: state.workspaceId || undefined,
              actingUserEmail: state.session?.user?.email,
            }),
          });
        } else {
          await fetchJson(`api/admin/users/${encodeURIComponent(button.dataset.userId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workspaceId: state.workspaceId || undefined,
              actingUserEmail: state.session?.user?.email,
              role: button.dataset.role,
              status: button.dataset.status,
            }),
          });
        }

        clearWorkspaceRequestCache();
        await refreshAdminUsers(state);
      } catch (error) {
        appendSyncFeedback(state, `Admin: ${error.message}`);
        renderAdminStatus(state, { error: error.message });
      } finally {
        setLoading(button, false, button.dataset.defaultLabel || button.textContent);
      }
    });
  }

  if (previewButton) {
    previewButton.addEventListener("click", async () => {
      if (!state.canAccessAdmin) return;

      try {
        setLoading(previewButton, true, "Gerando...");
        const draft = collectPatchNotesDraft(state);
        const response = await fetchJson("api/admin/patch-notes/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        });
        renderPatchPreview(response.preview);
        renderPatchComposerStatus([
          `Previa pronta para a versao ${response.preview?.version || "-"}.`,
          `${response.preview?.recipientCount || 0} destinatarios selecionados para este envio.`,
        ]);
      } catch (error) {
        renderPatchComposerStatus([`Release notes: ${error.message}`]);
      } finally {
        setLoading(previewButton, false, "Gerar previa");
      }
    });
  }

  if (sendButton) {
    sendButton.addEventListener("click", async () => {
      if (!state.canAccessAdmin) return;

      try {
        const draft = collectPatchNotesDraft(state);
        const recipientCount = draft.recipientEmails.length || (state.patchRecipients || []).length;
        if (!window.confirm(`Enviar patch notes ${draft.version || ""} para ${recipientCount} destinatarios?`)) {
          return;
        }

        setLoading(sendButton, true, "Enviando...");
        const response = await fetchJson("api/admin/patch-notes/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        });

        renderPatchComposerStatus([
          `Envio concluido: ${response.totals?.sentCount || 0} enviados, ${response.totals?.skippedCount || 0} ignorados e ${response.totals?.failedCount || 0} falhas.`,
          response.error || "Historico atualizado para todos os usuarios.",
        ]);
        clearWorkspaceRequestCache();
        await refreshWorkspace(state);
      } catch (error) {
        renderPatchComposerStatus([`Release notes: ${error.message}`]);
      } finally {
        setLoading(sendButton, false, "Enviar patch notes");
      }
    });
  }
}

async function refreshAdminUsers(state, triggerButton) {
  if (!state.canAccessAdmin) return;

  try {
    if (triggerButton) setLoading(triggerButton, true, "Atualizando...");
    const payload = await fetchJson(buildAdminUrl(state, "api/admin/users"));
    state.adminUsers = payload.users || [];
    renderAdminStatus(state, payload);
    renderAdminUsers(state);
  } finally {
    if (triggerButton) setLoading(triggerButton, false, "Atualizar usuarios");
  }
}

function renderWorkspace(
  state,
  dashboard,
  projectionPayload,
  abcPayload,
  productsPayload,
  ordersPayload,
  financePayload,
  threadsPayload,
  syncRunsPayload,
) {
  const overview = dashboard.overview || {};
  const analytics = dashboard.analytics || {};
  const catalog = dashboard.catalog || {};
  const ordersOverview = dashboard.orders || {};
  const freight = dashboard.freight || {};
  const finance = dashboard.finance || {};
  const messaging = dashboard.messaging || {};
  const projection = projectionPayload.projection || {};
  const syncRuns = syncRunsPayload.items || [];
  const integratedSellerName =
    state.integration?.workspace?.sellerName ||
    overview.workspace?.sellerName ||
    overview.workspace?.slug;

  if (integratedSellerName) setText("seller-alias", integratedSellerName);
  renderSettingsUser(state);
  setSelectValue("analytics-period-select", state.period);

  setText("metric-products", String(catalog.summary?.publishedProducts || overview.metrics?.products || 0));
  setText("metric-orders", String(analytics.kpis?.orders || 0));
  setText("metric-gross-revenue", formatCurrency(analytics.kpis?.grossRevenue || 0));
  setText("metric-net-revenue", formatCurrency(analytics.kpis?.netRevenue || 0));
  setText("metric-margin-rate", formatPercent(analytics.kpis?.marginRate || 0));
  setText("metric-delivery-rate", formatPercent(analytics.quality?.deliveryRate || 0));
  setText("metric-products-note", `${catalog.summary?.outOfStockProducts || 0} sem estoque`);
  setText("metric-orders-note", `${formatSignedPercent(analytics.kpis?.ordersGrowth || 0)} vs periodo anterior`);
  setText("metric-gross-note", `${formatSignedPercent(analytics.kpis?.grossRevenueGrowth || 0)} de crescimento`);
  setText("metric-net-note", `${formatSignedPercent(analytics.kpis?.netRevenueGrowth || 0)} de crescimento`);
  setText("metric-margin-note", `${formatSignedPercent(analytics.kpis?.marginRateGrowth || 0)} de variacao`);
  setText("metric-delivery-note", `${formatPercent(analytics.quality?.cancellationRate || 0)} cancelamento`);
  setText("projection-orders", String(projection.projected?.orders || 0));
  setText("projection-gross", formatCurrency(projection.projected?.grossRevenue || 0));
  setText("projection-net", formatCurrency(projection.projected?.paidRevenue || projection.projected?.netRevenue || 0));
  setText("projection-margin", formatPercent(projection.projected?.marginRate || 0));
  renderExecutiveDashboard({
    state,
    overview,
    analytics,
    catalog,
    ordersOverview,
    freight,
    finance,
    messaging,
    projection,
    syncRuns,
  });

  renderStack("overview-highlights", [
    `${ordersOverview.summary?.openOrders || 0} pedidos ainda exigem acao operacional imediata.`,
    `${catalog.summary?.recentlyUpdatedProducts || 0} produtos foram revisados recentemente no workspace.`,
    `${messaging.summary?.openThreads || 0} threads de SAC permanecem abertas com ${messaging.summary?.unreadMessages || 0} mensagens nao lidas.`,
    `${finance.summary?.pendingEntries || 0} lancamentos seguem aguardando liberacao de repasse.`,
  ]);
  renderStack("quality-highlights", [
    `Entrega concluida em ${formatPercent(analytics.quality?.deliveryRate || 0)} do periodo.`,
    `SLA de frete dentro da meta em ${formatPercent(analytics.quality?.freightSlaRate || 0)} das cotacoes.`,
    `Sincronizacoes saudaveis em ${formatPercent(analytics.quality?.syncHealthRate || 0)} das rotinas.`,
    `Threads pendentes: ${analytics.quality?.pendingThreads || 0} com ${analytics.quality?.unreadMessages || 0} nao lidas.`,
  ]);
  renderStack("latest-activity-list", [
    overview.latest?.syncRun?.domain
      ? `Ultima rotina: ${normalizeLabel(overview.latest.syncRun.domain)} em ${normalizeLabel(overview.latest.syncRun.status)}.`
      : "Nenhuma rotina registrada ainda.",
    overview.latest?.webhookEvent?.topic
      ? `Ultimo webhook: ${normalizeLabel(overview.latest.webhookEvent.topic)} em ${normalizeLabel(overview.latest.webhookEvent.status)}.`
      : "Sem webhooks recentes para exibir.",
    `Projecao do mes: ${projection.projected?.orders || 0} pedidos e ${formatCurrency(projection.projected?.paidRevenue || projection.projected?.netRevenue || 0)} pagos.`,
  ]);
  renderBarChart("kpi-comparison-chart", [
    { label: "Pedidos", value: Math.abs(Number(analytics.kpis?.ordersGrowth || 0)), valueLabel: formatSignedPercent(analytics.kpis?.ordersGrowth || 0) },
    { label: "Bruto", value: Math.abs(Number(analytics.kpis?.grossRevenueGrowth || 0)), valueLabel: formatSignedPercent(analytics.kpis?.grossRevenueGrowth || 0) },
    { label: "Liquido", value: Math.abs(Number(analytics.kpis?.netRevenueGrowth || 0)), valueLabel: formatSignedPercent(analytics.kpis?.netRevenueGrowth || 0) },
    { label: "Margem", value: Math.abs(Number(analytics.kpis?.marginRateGrowth || 0)), valueLabel: formatSignedPercent(analytics.kpis?.marginRateGrowth || 0) },
    { label: "Ticket", value: Math.abs(Number(analytics.kpis?.avgTicketGrowth || 0)), valueLabel: formatSignedPercent(analytics.kpis?.avgTicketGrowth || 0) },
  ]);
  renderStack("orders-quality-list", [
    `${ordersOverview.summary?.openOrders || 0} pedidos em aberto no consolidado.`,
    `${ordersOverview.summary?.cancelledOrders || 0} cancelados e ticket medio em ${formatCurrency(ordersOverview.summary?.averageTicket || 0)}.`,
    `${analytics.quality?.deliveryRate || 0}% de entrega concluida com ${analytics.quality?.cancellationRate || 0}% de cancelamento.`,
  ]);
  renderStack("finance-summary-list", [
    `Bruto acumulado em ${formatCurrency(finance.summary?.grossAmount || 0)}.`,
    `Taxas totais em ${formatCurrency(finance.summary?.feeAmount || 0)} e liquido em ${formatCurrency(finance.summary?.netAmount || 0)}.`,
    `${finance.summary?.paidEntries || 0} pagos e ${finance.summary?.pendingEntries || 0} pendentes.`,
  ]);
  renderStack("messaging-summary-list", [
    `${messaging.summary?.openThreads || 0} threads abertas no backlog do seller.`,
    `${messaging.summary?.recentThreads || 0} atendimentos tiveram atividade recente.`,
    `${messaging.summary?.unreadMessages || 0} mensagens seguem sem leitura local.`,
  ]);
  renderStack("analytics-period-list", [
    `Recorte atual: ${formatShortDate(analytics.period?.current?.start)} ate ${formatShortDate(analytics.period?.current?.end)}.`,
    `Comparativo anterior: ${formatShortDate(analytics.period?.previous?.start)} ate ${formatShortDate(analytics.period?.previous?.end)}.`,
    `Agrupamento: ${normalizeLabel(analytics.period?.groupBy || "day")} | ${analytics.period?.source === "custom" ? "recorte customizado" : analytics.period?.label || state.period}.`,
    `Comparacao: ${analytics.period?.comparisonSource === "custom" ? "periodo customizado" : "periodo anterior automatico"}.`,
  ]);
  renderStack("analytics-quality-list", [
    `Entrega: ${formatPercent(analytics.quality?.deliveryRate || 0)} do volume aprovado.`,
    `Cancelamento: ${formatPercent(analytics.quality?.cancellationRate || 0)} no periodo filtrado.`,
    `Frete dentro do SLA: ${formatPercent(analytics.quality?.freightSlaRate || 0)} das cotacoes.`,
    `Backlog de SAC: ${analytics.quality?.pendingThreads || 0} threads com ${analytics.quality?.unreadMessages || 0} nao lidas.`,
  ]);

  renderBarChart("revenue-series-chart", (analytics.series?.revenue || []).map((item) => ({ label: compactBucket(item.bucket), value: item.value, valueLabel: formatCurrency(item.value) })));
  renderBarChart("orders-series-chart", (analytics.series?.orders || []).map((item) => ({ label: compactBucket(item.bucket), value: item.value, valueLabel: String(item.value) })));
  renderBarChart("catalog-status-chart", (catalog.byStatus || []).map((item) => ({ label: normalizeLabel(item.status), value: item.count, valueLabel: String(item.count) })));
  renderBarChart("orders-status-chart", (ordersOverview.byStatus || []).map((item) => ({ label: normalizeLabel(item.status), value: item.count, valueLabel: String(item.count) })));
  renderBarChart("finance-status-chart", (finance.byStatus || []).map((item) => ({ label: normalizeLabel(item.status), value: item.count, valueLabel: String(item.count) })));
  renderBarChart("messaging-status-chart", (messaging.byStatus || []).map((item) => ({ label: normalizeLabel(item.status), value: item.count, valueLabel: String(item.count) })));

  renderProductGrowthCards("product-growth-cards", analytics.products?.growth || []);
  renderTable(
    "product-growth-table",
    (analytics.products?.growth || []).map((item) => [
      item.productName || item.title || "Produto",
      item.sku || "Sem SKU",
      formatCurrency(item.currentRevenue || 0),
      formatSignedPercent(item.revenueGrowth || 0),
      String(item.currentUnits || 0),
    ]),
    5,
  );
  renderTable("catalog-categories-table", (catalog.topCategories || []).map((item) => [item.name, String(item.count)]), 2);
  state.views.catalog.total = Number(productsPayload.total || 0);
  state.views.orders.total = Number(ordersPayload.total || 0);
  state.views.finance.total = Number(financePayload.total || 0);
  state.views.messaging.total = Number(threadsPayload.total || 0);

  renderTable(
    "catalog-products-table",
    (productsPayload.items || []).map((item) => [
      `<button class="table-link" data-product-id="${escapeHtml(item.id)}" type="button">${escapeHtml(item.sku || item.id)}</button>`,
      item.title,
      normalizeLabel(item.status),
      formatCurrency(item.currentPrice || 0),
      String(item.stock || 0),
      formatCurrency(item.revenueAmount || 0),
    ]),
    6,
    { rawColumns: new Set([0]) },
  );
  renderTable(
    "orders-table",
    (ordersPayload.items || []).map((item) => [
      `<button class="table-link" data-order-id="${escapeHtml(item.id)}" type="button">${escapeHtml(item.externalId || item.id)}</button>`,
      item.buyerName || "Nao informado",
      normalizeLabel(item.status),
      formatCurrency(item.totalAmount || 0),
      String(item.units || 0),
      String(item.threadCount || 0),
    ]),
    6,
    { rawColumns: new Set([0]) },
  );
  renderTable("finance-entries-table", (financePayload.items || []).map((item) => [normalizeLabel(item.type), normalizeLabel(item.status), formatCurrency(item.grossAmount || 0), formatCurrency(item.feeAmount || 0), formatCurrency(item.netAmount || 0)]), 5);
  renderTable("messaging-threads-table", (threadsPayload.items || []).map((item) => [item.externalThreadId || item.id, normalizeLabel(item.status), String(item.unreadCount || 0), formatDate(item.lastMessageAt), item.lastMessagePreview || "Sem preview"]), 5);
  renderTable("sync-runs-table", syncRuns.map((item) => [normalizeLabel(item.domain), normalizeLabel(item.status), `${item.itemsProcessed || 0}/${item.itemsTotal || 0}`, formatDate(item.finishedAt || item.startedAt)]), 4);
  renderAbc(state, abcPayload?.abc || null);
  updatePagerState("catalog", state.views.catalog);
  updatePagerState("orders", state.views.orders);
  updatePagerState("finance", state.views.finance);
  updatePagerState("messaging", state.views.messaging);
  renderSyncFeedback(state);
}

function renderAbc(state, abcPayload) {
  if (!abcPayload) {
    renderStack("abc-summary-list", [
      "Defina o periodo e aplique os filtros para gerar a curva ABC.",
      "Use a curva por faturamento e por quantidade para cruzar os perfis dos produtos.",
    ]);
    renderBarChart("abc-class-chart", []);
    renderBarChart("abc-cumulative-chart", []);
    renderTable("abc-table", [], 10);
    return;
  }

  const metricLabel = abcPayload.metric === "units" ? "quantidade vendida" : "faturamento";
  const metricShortLabel = abcPayload.metric === "units" ? "Qtde." : "Fat.";
  const startDate = abcPayload.period?.current?.start;
  const endDate = abcPayload.period?.current?.end;
  const filters = abcPayload.filters || {};
  const items = Array.isArray(abcPayload.items) ? abcPayload.items : [];
  const summary = abcPayload.summary || {};
  const curves = abcPayload.curves || {};
  const revenueCurve = curves.revenue || {};
  const unitsCurve = curves.units || {};
  const cross = abcPayload.cross || {};
  const profiles = Array.isArray(cross.profiles) ? cross.profiles : [];
  const matrix = Array.isArray(cross.matrix) ? cross.matrix : [];

  renderStack("abc-summary-list", [
    `Periodo: ${formatShortDate(startDate)} ate ${formatShortDate(endDate)} (${abcPayload.period?.source === "custom" ? "customizado" : abcPayload.period?.label || state.period}).`,
    `Metrica ativa: ${metricLabel}.`,
    `SKUs classificados: ${summary.totalSkus || 0} | total ${metricLabel}: ${abcPayload.metric === "units" ? String(summary.totalMetric || 0) : formatCurrency(summary.totalMetric || 0)}.`,
    `${metricShortLabel} classes: A ${summary.classA || 0} | B ${summary.classB || 0} | C ${summary.classC || 0}.`,
    `Faturamento classes: A ${revenueCurve.classA || 0} | B ${revenueCurve.classB || 0} | C ${revenueCurve.classC || 0}.`,
    `Quantidade classes: A ${unitsCurve.classA || 0} | B ${unitsCurve.classB || 0} | C ${unitsCurve.classC || 0}.`,
    `Filtros: ${filters.orderIds?.length || 0} IDs de pedido e ${filters.productIds?.length || 0} SKUs/IDs de produto.`,
  ]);

  renderBarChart("abc-class-chart", [
    { label: `Classe A (${metricShortLabel})`, value: summary.classA || 0, valueLabel: String(summary.classA || 0) },
    { label: `Classe B (${metricShortLabel})`, value: summary.classB || 0, valueLabel: String(summary.classB || 0) },
    { label: `Classe C (${metricShortLabel})`, value: summary.classC || 0, valueLabel: String(summary.classC || 0) },
    { label: "Classe A (Fat.)", value: revenueCurve.classA || 0, valueLabel: String(revenueCurve.classA || 0) },
    { label: "Classe A (Qtde.)", value: unitsCurve.classA || 0, valueLabel: String(unitsCurve.classA || 0) },
  ]);

  renderBarChart(
    "abc-cumulative-chart",
    (profiles.length ? profiles : matrix).slice(0, 12).map((item) => ({
      label: item.profile || item.combination || "-",
      value: Number(item.count || 0),
      valueLabel: String(item.count || 0),
    })),
  );

  renderTable(
    "abc-table",
    items.map((item) => [
      String(item.rank || 0),
      item.sku || "-",
      item.title || "Sem titulo",
      item.revenueAbcClass || "-",
      item.unitsAbcClass || "-",
      item.businessProfile || "-",
      formatCurrency(item.revenue || 0),
      String(item.units || 0),
      `${Number(item.participation || 0).toFixed(2)}%`,
      `${Number(item.cumulative || 0).toFixed(2)}%`,
    ]),
    10,
  );
}

function renderExecutiveDashboard(input) {
  const {
    state,
    overview,
    analytics,
    catalog,
    ordersOverview,
    freight,
    finance,
    messaging,
    projection,
    syncRuns,
  } = input || {};

  renderControlDashboard({
    state,
    overview,
    analytics,
    catalog,
    ordersOverview,
    freight,
    finance,
    messaging,
    projection,
    syncRuns,
  });
  return;

  const sellerName = state?.integration?.workspace?.sellerName || overview?.workspace?.sellerName || "Loja MadeiraMadeira";
  const healthScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        (
          Number(analytics?.quality?.deliveryRate || 0) +
          Number(analytics?.quality?.syncHealthRate || 0) +
          Number(freight?.summary?.slaRate || 0) +
          (100 - Number(analytics?.quality?.cancellationRate || 0))
        ) / 4,
      ),
    ),
  );

  setText("exec-seller-name", sellerName);
  setText("exec-seller-updated", `Atualizado em ${formatDate(new Date().toISOString())}`);
  setText("exec-products", String(catalog?.summary?.publishedProducts || 0));
  setText("exec-open-orders", String(ordersOverview?.summary?.openOrders || 0));
  setText("exec-open-threads", String(messaging?.summary?.openThreads || 0));
  setText("exec-sync-success", String((syncRuns || []).filter((item) => ["success", "partial"].includes(item.status)).length));
  setText("exec-gross-revenue", formatCurrency(analytics?.kpis?.grossRevenue || 0));
  setText("exec-orders", String(analytics?.kpis?.orders || 0));
  setText("exec-ticket", formatCurrency(analytics?.kpis?.avgTicket || 0));
  setText("exec-net-revenue", formatCurrency(analytics?.kpis?.netRevenue || 0));
  setText("exec-margin", formatPercent(analytics?.kpis?.marginRate || 0));
  setText(
    "exec-finance-note",
    `Liquido ${formatCurrency(finance?.summary?.netAmount || 0)} | taxas ${formatCurrency(finance?.summary?.feeAmount || 0)}.`,
  );
  setText("exec-health-score", `${healthScore}%`);
  setText("exec-health-label", healthScore >= 80 ? "Saudavel" : healthScore >= 60 ? "Atencao" : "Critico");
  setText("exec-range-label", analytics?.period?.label || state?.period || "current_month");
  setText("exec-sac-score", `${Math.max(0, Math.min(100, Math.round((100 - Number(analytics?.quality?.pendingThreads || 0) * 2) + Number(analytics?.quality?.deliveryRate || 0) * 0.2)))}%`);
  setText("exec-sac-note", `${messaging?.summary?.unreadMessages || 0} mensagens nao lidas no backlog.`);

  const ring = document.getElementById("exec-score-ring");
  if (ring) {
    ring.style.borderTopColor = healthScore >= 75 ? "var(--green)" : healthScore >= 55 ? "var(--amber)" : "var(--red)";
    ring.style.borderRightColor = "var(--cyan)";
  }

  renderInlineRows("exec-health-list", [
    { label: "Cancelamento", value: formatPercent(analytics?.quality?.cancellationRate || 0) },
    { label: "Frete no SLA", value: formatPercent(freight?.summary?.slaRate || 0) },
    { label: "Sync saudavel", value: formatPercent(analytics?.quality?.syncHealthRate || 0) },
    { label: "Pendencias SAC", value: String(analytics?.quality?.pendingThreads || 0) },
  ]);

  renderInlineRows("exec-kpi-stack", [
    { label: "Projecao pedidos", value: String(projection?.projected?.orders || 0) },
    { label: "Projecao liquido", value: formatCurrency(projection?.projected?.netRevenue || 0) },
    { label: "Financeiro pendente", value: String(finance?.summary?.pendingEntries || 0) },
    { label: "Pedidos entregues", value: String(ordersOverview?.summary?.deliveredOrders || 0) },
  ], true);

  renderInlineRows("exec-sac-list", [
    { label: "Threads abertas", value: String(messaging?.summary?.openThreads || 0) },
    { label: "Nao lidas", value: String(messaging?.summary?.unreadMessages || 0) },
    { label: "Atividade recente", value: String(messaging?.summary?.recentThreads || 0) },
  ]);

  renderInlineRows("exec-account-health-list", [
    { label: "Taxa de entrega", value: formatPercent(analytics?.quality?.deliveryRate || 0) },
    { label: "Cotacoes no SLA", value: formatPercent(freight?.summary?.slaRate || 0) },
    { label: "Repasse pago", value: String(finance?.summary?.paidEntries || 0) },
    { label: "Produtos sem estoque", value: String(catalog?.summary?.outOfStockProducts || 0) },
  ]);

  const topProducts = (analytics?.products?.growth || []).slice(0, 5);
  const productsContainer = document.getElementById("exec-top-products");
  if (productsContainer) {
    if (!topProducts.length) {
      productsContainer.innerHTML = '<div>Sem produtos suficientes para ranking no periodo.</div>';
    } else {
      productsContainer.innerHTML = topProducts
        .map((item, index) => `<div><strong>${index + 1}. ${escapeHtml(item.productName || item.title || item.sku || "Produto")}</strong><span>${escapeHtml(item.sku || "-")} • ${formatCurrency(item.currentRevenue || 0)} • ${formatSignedPercent(item.revenueGrowth || 0)}</span></div>`)
        .join("");
    }
  }

  renderRevenueLineChart("exec-revenue-line-chart", analytics?.series?.revenue || []);
}

function renderInlineRows(containerId, items, highlight = false) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const rows = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!rows.length) {
    container.innerHTML = "<div>Sem dados</div>";
    return;
  }
  if (highlight) {
    container.innerHTML = rows
      .map((item) => `<div><span>${escapeHtml(item.label || "-")}</span><strong>${escapeHtml(item.value || "-")}</strong></div>`)
      .join("");
    return;
  }
  container.innerHTML = rows
    .map((item) => `<div>${escapeHtml(item.label || "-")}: <strong>${escapeHtml(item.value || "-")}</strong></div>`)
    .join("");
}

function renderRevenueLineChart(containerId, series) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const rows = Array.isArray(series) ? series : [];
  if (!rows.length) {
    container.innerHTML = '<div class="stack-item"><strong>Sem dados</strong><span>Sincronize o financeiro para visualizar a curva.</span></div>';
    return;
  }

  const width = 760;
  const height = 160;
  const max = Math.max(...rows.map((item) => Number(item.value || 0)), 1);
  const points = rows.map((item, index) => {
    const x = rows.length === 1 ? 20 : 20 + (index * (width - 40)) / (rows.length - 1);
    const y = 20 + ((max - Number(item.value || 0)) * (height - 40)) / max;
    return `${x},${y}`;
  });

  const labels = rows
    .filter((_item, index) => index % Math.max(1, Math.floor(rows.length / 6)) === 0 || index === rows.length - 1)
    .map((item, index, list) => {
      const position = rows.findIndex((row) => row.bucket === item.bucket);
      const x = rows.length === 1 ? 20 : 20 + (position * (width - 40)) / (rows.length - 1);
      return `<text x="${x}" y="${height - 6}" font-size="10" fill="currentColor" opacity="0.65" text-anchor="${index === list.length - 1 ? "end" : "middle"}">${escapeHtml(compactBucket(item.bucket))}</text>`;
    })
    .join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Curva de faturamento">
      <defs>
        <linearGradient id="execLineGradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#1fd2f0" />
          <stop offset="100%" stop-color="#ff8f1f" />
        </linearGradient>
      </defs>
      <polyline fill="none" stroke="url(#execLineGradient)" stroke-width="3" points="${points.join(" ")}" />
      ${labels}
    </svg>
  `;
}

function renderControlDashboard(input) {
  const {
    state,
    analytics,
    catalog,
    ordersOverview,
    projection,
  } = input || {};
  const revenueSeries = analytics?.series?.revenue || [];
  const ordersSeries = analytics?.series?.orders || [];
  const grossRevenue = Number(analytics?.kpis?.grossRevenue || 0);
  const approvedRevenue = Number(analytics?.kpis?.approvedRevenue || 0);
  const orders = Number(analytics?.kpis?.orders || 0);
  const ticket = Number(analytics?.kpis?.avgTicket || 0);
  const cancelled = Number(ordersOverview?.summary?.cancelledOrders || 0);
  const delivered = Number(ordersOverview?.summary?.deliveredOrders || 0);
  const totalOrders = Number(ordersOverview?.summary?.totalOrders || 0);
  const conversion = totalOrders ? (delivered / totalOrders) * 100 : 0;

  setSelectValue("dash-period-select", state?.period || "current_month");
  setInputValue("dash-date-from", analytics?.period?.current?.start || state?.analytics?.dateFrom || "");
  setInputValue("dash-date-to", analytics?.period?.current?.end || state?.analytics?.dateTo || "");
  setInputValue(
    "dash-date-range",
    `${formatShortDate(analytics?.period?.current?.start)} - ${formatShortDate(analytics?.period?.current?.end)}`,
  );

  setText("dash-kpi-revenue", formatCurrency(grossRevenue));
  setText("dash-kpi-revenue-growth", `${formatSignedPercent(analytics?.kpis?.grossRevenueGrowth || 0)} vs. periodo anterior`);
  setText("dash-kpi-approved-revenue", formatCurrency(approvedRevenue));
  setText("dash-kpi-approved-revenue-growth", `${formatSignedPercent(analytics?.kpis?.approvedRevenueGrowth || 0)} vs. periodo anterior`);
  setText("dash-kpi-orders", String(orders));
  setText("dash-kpi-orders-growth", `${formatSignedPercent(analytics?.kpis?.ordersGrowth || 0)} vs. periodo anterior`);
  setText("dash-kpi-ticket", formatCurrency(ticket));
  setText("dash-kpi-ticket-growth", `${formatSignedPercent(analytics?.kpis?.avgTicketGrowth || 0)} vs. periodo anterior`);
  setText("dash-kpi-conversion", formatPercent(conversion));
  setText("dash-kpi-conversion-growth", `${formatSignedPercent((analytics?.quality?.deliveryRate || 0) - (analytics?.quality?.cancellationRate || 0))} vs. periodo anterior`);
  setText("dash-kpi-cancelled", String(cancelled));
  setText("dash-kpi-cancelled-growth", `${formatSignedPercent(-1 * Number(analytics?.quality?.cancellationRate || 0))} vs. periodo anterior`);

  renderSparklineSimple("dash-spark-revenue", revenueSeries.map((item) => Number(item.value || 0)), "#2563eb");
  renderSparklineSimple("dash-spark-approved-revenue", revenueSeries.map((item) => Number(item.value || 0) * (approvedRevenue > 0 && grossRevenue > 0 ? approvedRevenue / grossRevenue : 0)), "#0ea5e9");
  renderSparklineSimple("dash-spark-orders", ordersSeries.map((item) => Number(item.value || 0)), "#fb923c");
  renderSparklineSimple("dash-spark-ticket", revenueSeries.map((item, index) => Number(item.value || 0) / Math.max(1, Number(ordersSeries[index]?.value || 1))), "#ef4444");
  renderSparklineSimple("dash-spark-conversion", ordersSeries.map((item) => Number(item.value || 0)), "#22c55e");
  renderSparklineSimple("dash-spark-cancelled", ordersSeries.map((item) => Number(item.value || 0) * (Number(analytics?.quality?.cancellationRate || 0) / 100)), "#f97316");

  setText("dash-trend-badge", `${formatSignedPercent(analytics?.kpis?.grossRevenueGrowth || 0)} vs. periodo anterior`);
  renderControlTrendChart("dash-trend-chart", revenueSeries);
  renderControlPerformanceChart("dash-performance-chart", revenueSeries, Number(projection?.projected?.grossRevenue || 0));

  renderControlTopSellers("dash-top-sellers", analytics?.products?.growth || []);
  renderControlSummary("dash-period-summary", analytics, projection, grossRevenue);

  setText("dash-op-published", String(catalog?.summary?.publishedProducts || 0));
  setText("dash-op-published-growth", `${formatSignedPercent(analytics?.kpis?.ordersGrowth || 0)} vs. periodo anterior`);
  setText("dash-op-oos", String(catalog?.summary?.outOfStockProducts || 0));
  setText("dash-op-oos-growth", `${formatSignedPercent(-1 * Number(analytics?.quality?.cancellationRate || 0))} vs. periodo anterior`);
  setText("dash-op-open-orders", String(ordersOverview?.summary?.openOrders || 0));
  setText("dash-op-open-orders-growth", `${formatSignedPercent(analytics?.kpis?.ordersGrowth || 0)} vs. periodo anterior`);
  setText("dash-op-active", String(catalog?.summary?.totalProducts || 0));
  setText("dash-op-active-growth", `${formatSignedPercent(analytics?.kpis?.grossRevenueGrowth || 0)} vs. periodo anterior`);

  const statusValues = (catalog?.byStatus || []).map((item) => Number(item.count || 0));
  renderSparklineSimple("dash-spark-published", statusValues, "#2563eb");
  renderSparklineSimple("dash-spark-oos", [Number(catalog?.summary?.outOfStockProducts || 0), Number(catalog?.summary?.publishedProducts || 0)], "#fb923c");
  renderSparklineSimple("dash-spark-open-orders", (ordersOverview?.byStatus || []).map((item) => Number(item.count || 0)), "#a855f7");
  renderSparklineSimple("dash-spark-active", statusValues.slice().reverse(), "#3b82f6");

  renderControlCompareBars("dash-compare-bars", analytics?.products?.growth || []);
  renderControlDailyHeatmap("dash-daily-heatmap", revenueSeries);
}

function renderSparklineSimple(containerId, points, color) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const values = (Array.isArray(points) ? points : []).map((item) => Number(item || 0)).filter((item) => Number.isFinite(item));
  if (!values.length) {
    container.innerHTML = "";
    return;
  }
  const max = Math.max(...values, 1);
  const width = 180;
  const height = 32;
  const plot = values.map((value, index) => {
    const x = values.length === 1 ? 3 : 3 + (index * (width - 6)) / (values.length - 1);
    const y = 2 + ((max - value) * (height - 4)) / max;
    return `${x},${y}`;
  });
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><polyline fill="none" stroke="${escapeHtml(color || "#2563eb")}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" points="${plot.join(" ")}" /></svg>`;
}

function renderControlTrendChart(containerId, series) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const rows = Array.isArray(series) ? series : [];
  if (!rows.length) {
    container.innerHTML = '<div class="stack-item"><strong>Sem dados</strong><span>Sincronize para exibir a tendencia.</span></div>';
    return;
  }
  const width = 900;
  const height = 240;
  const max = Math.max(...rows.map((item) => Number(item.value || 0)), 1);
  const metaValue = max * 0.45;
  const current = rows.map((item, index) => {
    const x = 42 + (index * (width - 84)) / Math.max(rows.length - 1, 1);
    const y = 24 + ((max - Number(item.value || 0)) * (height - 62)) / max;
    return `${x},${y}`;
  });
  const projectionStart = Math.max(0, Math.floor(rows.length * 0.55));
  const projection = rows.slice(projectionStart).map((item, index) => {
    const absoluteIndex = projectionStart + index;
    const x = 42 + (absoluteIndex * (width - 84)) / Math.max(rows.length - 1, 1);
    const y = 24 + ((max - Number(item.value || 0) * 1.12) * (height - 62)) / max;
    return `${x},${Math.max(24, y)}`;
  });
  const metaY = 24 + ((max - metaValue) * (height - 62)) / max;
  const labels = rows
    .filter((_item, index) => index % Math.max(1, Math.floor(rows.length / 6)) === 0 || index === rows.length - 1)
    .map((item, index, list) => {
      const position = rows.findIndex((row) => row.bucket === item.bucket);
      const x = 42 + (position * (width - 84)) / Math.max(rows.length - 1, 1);
      return `<text x="${x}" y="${height - 8}" font-size="11" fill="currentColor" opacity="0.68" text-anchor="${index === list.length - 1 ? "end" : "middle"}">${escapeHtml(compactBucket(item.bucket))}</text>`;
    })
    .join("");
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Tendencia de vendas">
      <line x1="38" y1="${metaY}" x2="${width - 38}" y2="${metaY}" stroke="#ef4444" stroke-width="1.6"></line>
      <polyline fill="none" stroke="#2563eb" stroke-width="3" points="${current.join(" ")}"></polyline>
      <polyline fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-dasharray="8 6" points="${projection.join(" ")}"></polyline>
      ${labels}
    </svg>
  `;
}

function renderControlPerformanceChart(containerId, series, projectedGross) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const rows = Array.isArray(series) ? series : [];
  if (!rows.length) {
    container.innerHTML = '<div class="stack-item"><strong>Sem dados</strong><span>Sem desempenho para comparar.</span></div>';
    return;
  }
  const width = 900;
  const height = 220;
  const current = Number(rows[rows.length - 1]?.value || 0);
  const projected = Number(projectedGross || current || 1);
  const target = Math.max(projected * 0.82, 1);
  const previous = Math.max(current * 0.94, 1);
  const max = Math.max(projected, target, previous, 1);
  const points = [
    [48, 30 + ((max - current) * (height - 70)) / max],
    [width - 48, 30 + ((max - projected) * (height - 70)) / max],
  ];
  const targetY = 30 + ((max - target) * (height - 70)) / max;
  const previousY = 30 + ((max - previous) * (height - 70)) / max;
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Desempenho de vendas">
      <line x1="40" y1="${targetY}" x2="${width - 40}" y2="${targetY}" stroke="#94a3b8" stroke-width="2" stroke-dasharray="8 6"></line>
      <line x1="40" y1="${previousY}" x2="${width - 40}" y2="${previousY}" stroke="#ef4444" stroke-width="2"></line>
      <polyline fill="none" stroke="#2563eb" stroke-width="3" points="${points.map((point) => `${point[0]},${point[1]}`).join(" ")}"></polyline>
      <circle cx="${points[0][0]}" cy="${points[0][1]}" r="4" fill="#2563eb"></circle>
      <circle cx="${points[1][0]}" cy="${points[1][1]}" r="4" fill="#3b82f6"></circle>
      <text x="${points[0][0]}" y="${height - 8}" font-size="11" fill="currentColor" opacity="0.68">Atual</text>
      <text x="${points[1][0]}" y="${height - 8}" font-size="11" fill="currentColor" opacity="0.68" text-anchor="end">Projecao</text>
    </svg>
  `;
}

function renderControlTopSellers(containerId, products) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const rows = (Array.isArray(products) ? products : []).slice(0, 5);
  if (!rows.length) {
    container.innerHTML = '<div class="ctrl-list__item"><div><strong>Sem dados</strong><span>Sincronize pedidos para carregar o ranking.</span></div></div>';
    return;
  }
  container.innerHTML = rows.map((item) => `
    <article class="ctrl-list__item">
      <div>
        <strong>${escapeHtml(item.productName || item.title || item.sku || "Produto")}</strong>
        <span>${escapeHtml(item.sku || "-")}</span>
        <small>${escapeHtml(String(item.currentUnits || 0))} itens</small>
      </div>
      <strong>${formatCurrency(item.currentRevenue || 0)}</strong>
    </article>
  `).join("");
}

function renderControlSummary(containerId, analytics, projection, grossRevenue) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const elapsedDays = Math.max(1, Number(projection?.elapsedDays || 0));
  const totalDays = Math.max(elapsedDays, Number(projection?.totalDays || 0));
  const projectedPaid = Number(projection?.projected?.paidRevenue || 0);
  const projectedFallback = Number(projection?.projected?.grossRevenue || projection?.projected?.netRevenue || grossRevenue || 0);
  const projectedValue = projectedPaid > 0 ? projectedPaid : projectedFallback;
  const targetRaw = Number(projection?.target?.paidRevenue || 0);
  const fallbackTarget = projectedValue > 0 ? projectedValue * 0.87 : 0;
  const target = targetRaw > 0 ? targetRaw : fallbackTarget;
  const attainment = target > 0 ? (projectedValue / target) * 100 : 0;
  container.innerHTML = [
    ["Periodo", `${formatShortDate(analytics?.period?.current?.start)} - ${formatShortDate(analytics?.period?.current?.end)}`],
    ["Dias decorridos", `${elapsedDays} / ${totalDays}`],
    ["Projecao de encerramento", formatCurrency(projectedValue)],
    ["Meta do mes", formatCurrency(target)],
    ["Atingimento da meta", formatPercent(attainment)],
  ].map((item) => `<div><span>${escapeHtml(item[0])}</span><strong>${escapeHtml(item[1])}</strong></div>`).join("");
}

function renderControlCompareBars(containerId, products) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const rows = (Array.isArray(products) ? products : []).slice(0, 6).map((item) => {
    const current = Number(item.currentRevenue || 0);
    const growth = Number(item.revenueGrowth || 0);
    const previous = growth <= -99 ? 0 : current / Math.max(0.01, 1 + growth / 100);
    return {
      label: item.productName || item.title || item.sku || "Produto",
      current,
      previous,
    };
  });
  if (!rows.length) {
    container.innerHTML = "<div>Sem dados para comparativo.</div>";
    return;
  }
  const max = Math.max(...rows.map((row) => Math.max(row.current, row.previous)), 1);
  container.innerHTML = rows.map((row) => {
    const currentWidth = (row.current / max) * 100;
    const previousWidth = (row.previous / max) * 100;
    return `
      <div class="ctrl-bar-row">
        <span>${escapeHtml(row.label)}</span>
        <div class="ctrl-bar-track">
          <i class="ctrl-bar-previous" style="width:${Math.max(2, previousWidth)}%"></i>
          <i class="ctrl-bar-current" style="width:${Math.max(2, currentWidth)}%"></i>
        </div>
        <strong>${formatCurrency(row.current)}</strong>
        <small>${formatCurrency(row.previous)}</small>
      </div>
    `;
  }).join("");
}

function renderControlDailyHeatmap(containerId, revenueSeries) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const rows = Array.isArray(revenueSeries) ? revenueSeries : [];
  if (!rows.length) {
    container.innerHTML = "<div>Sem dados diarios.</div>";
    return;
  }
  const weekdays = ["Domingo", "Segunda", "Terca", "Quarta", "Quinta", "Sexta", "Sabado"];
  const labels = rows.map((item) => compactBucket(item.bucket));
  const matrix = weekdays.map((day) => ({ day, cells: labels.map(() => 0), total: 0 }));
  const maxValue = Math.max(...rows.map((row) => Number(row.value || 0)), 1);
  rows.forEach((row, index) => {
    const date = new Date(String(row.bucket).length === 7 ? `${row.bucket}-01T00:00:00Z` : `${row.bucket}T00:00:00Z`);
    const weekday = Number.isNaN(date.getTime()) ? 0 : date.getDay();
    const value = Number(row.value || 0);
    matrix[weekday].cells[index] = value;
    matrix[weekday].total += value;
  });
  const header = labels.map((label) => `<th>${escapeHtml(label)}</th>`).join("");
  const body = matrix.map((line) => {
    const cells = line.cells.map((value) => {
      const ratio = value > 0 ? value / maxValue : 0;
      const size = 8 + ratio * 18;
      return `<td><i class="ctrl-dot" style="width:${size.toFixed(0)}px;height:${size.toFixed(0)}px;opacity:${Math.max(0.22, ratio).toFixed(2)}"></i></td>`;
    }).join("");
    return `<tr><th>${line.day}</th>${cells}<td><strong>${formatCurrency(line.total)}</strong></td></tr>`;
  }).join("");
  container.innerHTML = `<table><thead><tr><th>Dia</th>${header}<th>Total</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderIntegrationStatus(state, payload) {
  const integration = payload?.integration || state.integration || {};
  const workspace = payload?.workspace || integration.workspace || null;
  const configured = Boolean(integration.tokenConfigured);
  const statusItems = [
    `Workspace: ${workspace?.slug || "nao identificado"}`,
    `Seller: ${workspace?.sellerName || "aguardando validacao do token"}`,
    `Codigo seller: ${workspace?.sellerCode || "nao informado"}`,
    `TOKENMM: ${configured ? `configurado (final ${integration.tokenLast4 || "----"})` : "nao configurado"}`,
    integration.configuredAt ? `Ultima integracao: ${formatDate(integration.configuredAt)}` : "Nenhuma integracao registrada ainda.",
  ];

  if (payload?.error) statusItems.unshift(`Falha ao validar token: ${payload.error}`);

  renderStack("integration-status-list", statusItems);
  updateIntegrationTokenField(integration);
  if (workspace?.sellerName) setText("seller-alias", workspace.sellerName);
}

function updateIntegrationTokenField(integration) {
  const input = document.getElementById("integration-token");
  if (!input) return;

  const tokenLast4 = String(integration?.tokenLast4 || "").trim();
  input.value = "";
  input.placeholder = tokenLast4
    ? `TOKENMM salvo (final ${tokenLast4})`
    : "Cole aqui o token da empresa";
}

function renderSettingsUser(state) {
  const user = state.session?.user || {};
  renderStack("settings-user-list", [
    `Usuario: ${user.name || "Nao informado"}.`,
    `E-mail: ${user.email || "Nao informado"}.`,
    `Perfil: ${normalizeLabel(user.role || "viewer")}.`,
    "Nesta area voce configura o TOKENMM da sua empresa para sincronizar catalogo, pedidos e indicadores.",
  ]);
}

function renderAdminWorkspaceSelector(state, payload) {
  if (!state.canAccessAdmin) return;
  const select = document.getElementById("admin-workspace-select");
  const inviteSelect = document.getElementById("admin-user-workspace");
  if (!select) return;

  const workspaces = Array.isArray(payload?.items) ? payload.items : state.adminWorkspaces || [];
  if (!workspaces.length) {
    select.innerHTML = `<option value="${escapeHtml(state.workspaceId || "")}">Workspace atual</option>`;
    if (inviteSelect) {
      inviteSelect.innerHTML = `<option value="${escapeHtml(state.workspaceId || "")}">Workspace atual</option>`;
      inviteSelect.value = state.workspaceId || "";
    }
    renderStack("admin-workspace-meta", ["Nenhum outro workspace ativo encontrado para selecao."]);
    return;
  }

  const workspaceOptionsHtml = workspaces
    .map((workspace) => `<option value="${escapeHtml(workspace.id)}">${escapeHtml(workspace.sellerName || workspace.slug || workspace.id)}</option>`)
    .join("");
  select.innerHTML = workspaceOptionsHtml;
  if (inviteSelect) inviteSelect.innerHTML = workspaceOptionsHtml;

  const selectedId = state.workspaceId || payload?.selectedWorkspaceId || workspaces[0]?.id || "";
  select.value = selectedId;
  if (inviteSelect) inviteSelect.value = selectedId;
  if (selectedId) state.workspaceId = selectedId;
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedId) || workspaces[0];
  renderStack("admin-workspace-meta", [
    `Workspace selecionado: ${selectedWorkspace?.sellerName || selectedWorkspace?.slug || selectedWorkspace?.id}.`,
    `Ambiente: ${normalizeLabel(selectedWorkspace?.environment || "production")} | status: ${normalizeLabel(selectedWorkspace?.status || "active")}.`,
    selectedWorkspace?.tenantGlobalId
      ? `Tenant global: ${selectedWorkspace.tenantGlobalId}.`
      : "Tenant global ainda nao definido para esta empresa.",
  ]);
}

function renderAdminCompanyIdentity(state, workspace) {
  if (!state.canAccessAdmin) return;

  const sellerName = String(workspace?.sellerName || "");
  const documentType = resolveIdentityDocumentType(
    workspace?.documentType,
    workspace?.documentNumber,
  );
  const documentNumber = String(workspace?.documentNumber || "");
  const tenantGlobalId = String(workspace?.tenantGlobalId || "");

  setInputValue("admin-company-name", sellerName);
  setSelectValue("admin-company-document-type", documentType);
  setInputValue(
    "admin-company-document-number",
    formatIdentityDocumentInput(documentType, documentNumber),
  );
  setInputValue("admin-company-tenant-global-id", tenantGlobalId);

  const identityItems = [
    sellerName ? "Empresa atual: " + sellerName + "." : "Nome da empresa ainda nao definido.",
    documentNumber
      ? "Documento: " + formatIdentityDocument(documentType, documentNumber) + "."
      : "Documento fiscal ainda nao informado.",
    tenantGlobalId
      ? "Tenant global vinculado: " + tenantGlobalId + "."
      : "Tenant global ainda nao vinculado ao hub.",
  ];

  renderStack("admin-company-status-list", identityItems);
}

function renderAdminStatus(state, payload) {
  if (!state.canAccessAdmin) return;

  const users = payload?.users || state.adminUsers || [];
  const invited = users.filter((user) => user.status === "invited").length;
  const active = users.filter((user) => user.status === "active").length;
  const disabled = users.filter((user) => user.status === "disabled").length;
  const workspace = payload?.workspace || {};
  const statusItems = [
    `Workspace sob governanca master: ${state.workspaceId || "sem workspace"}.`,
    `${active} usuarios ativos, ${invited} convites pendentes e ${disabled} acessos desabilitados.`,
    workspace?.tenantGlobalId
      ? `Tenant global ativo: ${workspace.tenantGlobalId}.`
      : "Tenant global ainda nao conectado ao hub.",
    payload?.emailDelivery?.sent
      ? "Ultimo convite enviado com sucesso via Brevo."
      : payload?.emailDelivery?.skipped
        ? "Brevo nao configurado no ambiente. O link foi gerado, mas o email nao saiu."
        : "Convites podem ser enviados e reencaminhados sempre que necessario.",
  ];

  if (payload?.error) statusItems.unshift(`Admin: ${payload.error}`);
  renderStack("admin-status-list", statusItems);
}

function renderAdminUsers(state) {
  if (!state.canAccessAdmin) return;

  const rows = (state.adminUsers || []).map((user) => {
    const nextRole = getNextRole(user.role);
    const nextStatus = user.status === "disabled" ? "active" : "disabled";
    const actions = user.isMaster
      ? "Master"
      : [
          user.status !== "active"
            ? `<button class="workspace-btn workspace-btn--ghost" data-admin-action="invite" data-user-id="${escapeHtml(user.id)}">Reenviar</button>`
            : "",
          `<button class="workspace-btn workspace-btn--ghost" data-admin-action="role" data-user-id="${escapeHtml(user.id)}" data-role="${escapeHtml(nextRole)}">Perfil: ${escapeHtml(normalizeLabel(nextRole))}</button>`,
          `<button class="workspace-btn workspace-btn--ghost" data-admin-action="status" data-user-id="${escapeHtml(user.id)}" data-status="${escapeHtml(nextStatus)}">${user.status === "disabled" ? "Reativar" : "Desativar"}</button>`,
        ].filter(Boolean).join(" ");

    return [
      user.name,
      user.email,
      normalizeLabel(user.role),
      normalizeLabel(user.status),
      user.invite?.expiresAt ? formatDate(user.invite.expiresAt) : "Nao enviado",
      actions,
    ];
  });

  renderTable("admin-users-table", rows, 6, { rawColumns: new Set([5]) });
}

function renderPatchRecipients(state) {
  const container = document.getElementById("admin-release-recipients");
  if (!container) return;

  const users = state.patchRecipients || [];
  if (!users.length) {
    container.innerHTML = '<div class="stack-item"><strong>Sem destinatarios</strong><span>Nenhum usuario ativo encontrado neste workspace.</span></div>';
    return;
  }

  container.innerHTML = users
    .map(
      (user) => `
        <label class="patch-recipient">
          <input type="checkbox" data-patch-recipient value="${escapeHtml(user.email)}" checked />
          <div>
            <strong>${escapeHtml(user.name || user.email)}</strong>
            <span>${escapeHtml(user.email)}</span>
          </div>
          <small>${escapeHtml(normalizeLabel(user.role || "viewer"))}</small>
        </label>
      `,
    )
    .join("");
}

function collectPatchNotesDraft(state) {
  const recipientEmails = Array.from(document.querySelectorAll("[data-patch-recipient]:checked")).map(
    (input) => String(input.value || "").trim(),
  );
  const splitLines = (value) =>
    String(value || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);

  return {
    workspaceId: state.workspaceId || undefined,
    actingUserEmail: state.session?.user?.email || undefined,
    version: document.getElementById("admin-release-version")?.value || "",
    title: document.getElementById("admin-release-title")?.value || "",
    summary: document.getElementById("admin-release-summary")?.value || "",
    newFeatures: splitLines(document.getElementById("admin-release-features")?.value || ""),
    adjustments: splitLines(document.getElementById("admin-release-adjustments")?.value || ""),
    recipientEmails,
  };
}

function renderPatchComposerStatus(items) {
  renderStack("admin-release-status", items || []);
}

function renderPatchPreview(preview) {
  const metaItems = [
    `Assunto: ${preview?.subject || "-"}`,
    `Versao: ${preview?.version || "-"}`,
    `${preview?.recipientCount || 0} destinatarios selecionados para este disparo.`,
  ];
  renderPatchComposerStatus(metaItems);

  const adminFrame = document.getElementById("admin-release-preview-frame");
  if (adminFrame) {
    adminFrame.srcdoc = preview?.html || "";
  }
}

function renderPatchNotesHistory(state) {
  const container = document.getElementById("patch-notes-history-list");
  if (!container) return;

  const items = state.patchNotesHistory || [];
  if (!items.length) {
    container.innerHTML = '<div class="stack-item"><strong>Sem atualizacoes</strong><span>Os proximos envios de patch notes aparecerao aqui para todo o workspace.</span></div>';
    renderStack("patch-notes-preview-meta", [
      "Nenhum release publicado ainda para este workspace.",
    ]);
    const emptyFrame = document.getElementById("patch-notes-preview-frame");
    if (emptyFrame) emptyFrame.srcdoc = "";
    return;
  }

  container.innerHTML = items
    .map(
      (item, index) => `
        <button class="timeline-item patch-history-item${index === 0 ? " is-active" : ""}" type="button" data-patch-history-id="${escapeHtml(item.id)}">
          <strong>${escapeHtml(item.version || "Sem versao")} · ${escapeHtml(item.title || "Atualizacao Davantti")}</strong>
          <span>${escapeHtml(item.summary || "Sem resumo.")}</span>
        </button>
      `,
    )
    .join("");

  const applySelected = (selectedId) => {
    const selected = items.find((item) => item.id === selectedId) || items[0];
    container.querySelectorAll("[data-patch-history-id]").forEach((element) => {
      element.classList.toggle("is-active", element.getAttribute("data-patch-history-id") === selected.id);
    });
    renderStack("patch-notes-preview-meta", [
      `Versao: ${selected.version || "-"}`,
      `Titulo: ${selected.title || "Atualizacao Davantti"}`,
      `Resumo: ${selected.summary || "Sem resumo."}`,
      `Enviado em: ${formatDate(selected.createdAt || selected.processedAt || selected.receivedAt)}`,
      `Destinatarios: ${selected.totals?.recipientCount || 0} | Enviados: ${selected.totals?.sentCount || 0}`,
    ]);
    const frame = document.getElementById("patch-notes-preview-frame");
    if (frame) frame.srcdoc = selected.html || "";
  };

  container.querySelectorAll("[data-patch-history-id]").forEach((element) => {
    element.addEventListener("click", () => applySelected(element.getAttribute("data-patch-history-id")));
  });

  applySelected(items[0].id);
}

function renderSalesReportPreview(report, errorMessage) {
  if (errorMessage) {
    renderStack("sales-report-status", [`Relatorio de vendas: ${errorMessage}`]);
    renderTable("sales-report-orders-table", [], 7);
    return;
  }

  if (!report) {
    renderStack("sales-report-status", [
      "Defina o periodo desejado, opcionalmente filtre por IDs de pedido ou SKU e gere o resumo.",
      "Os downloads CSV e JSON respeitam exatamente os mesmos filtros do preview.",
    ]);
    renderTable("sales-report-orders-table", [], 7);
    return;
  }

  renderStack("sales-report-status", [
    `Periodo: ${formatShortDate(report.period?.current?.start)} ate ${formatShortDate(report.period?.current?.end)} (${report.period?.source === "custom" ? "customizado" : report.period?.label || "preset"}).`,
    `Pedidos: ${report.kpis?.orders || 0} com ${formatSignedPercent(report.kpis?.ordersGrowth || 0)} vs anterior.`,
    `Bruto ${formatCurrency(report.kpis?.grossRevenue || 0)} | liquido ${formatCurrency(report.kpis?.netRevenue || 0)} | margem ${formatPercent(report.kpis?.marginRate || 0)}.`,
    `Filtros ativos: ${report.filters?.orderIds?.length || 0} IDs de pedido e ${report.filters?.productIds?.length || 0} IDs/SKUs de produto.`,
  ]);
  renderTable(
    "sales-report-orders-table",
    (report.orders?.rows || []).slice(0, 12).map((item) => [
      item.externalId || item.id || "-",
      item.buyerName || "Nao informado",
      normalizeLabel(item.status),
      formatDate(item.eventDate),
      formatCurrency(item.totalAmount || 0),
      formatCurrency(item.netAmount || 0),
      (item.skus || []).slice(0, 3).join(" | ") || "-",
    ]),
    7,
  );
}

function renderFallback(state, error) {
  renderStack("sync-feedback-list", [
    `Falha ao consolidar o painel: ${error.message}`,
    "Os botoes de sincronizacao seguem disponiveis para reidratar o workspace.",
  ]);
  renderSyncFeedback(state);
}

function renderSyncFeedback(state) {
  const feedbackItems = state.lastSyncFeedback.map((item) => {
    const stamp = new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(item.at));
    return `${stamp} - ${item.text}`;
  });

  renderStack("sync-feedback-list", feedbackItems.length ? feedbackItems : [
    "Dispare uma sincronizacao para acompanhar o retorno em tempo real.",
  ]);
}

function renderBarChart(containerId, items) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!items.length) {
    container.innerHTML = '<div class="stack-item"><strong>Sem dados</strong><span>Nada para exibir neste recorte.</span></div>';
    return;
  }

  const maxValue = Math.max(...items.map((item) => Number(item.value || 0)), 1);
  container.innerHTML = items.map((item) => `
      <div class="bar-chart__row">
        <span>${escapeHtml(item.label)}</span>
        <div><i style="width:${Math.max(6, (Number(item.value || 0) / maxValue) * 100)}%"></i></div>
        <strong>${escapeHtml(item.valueLabel || String(item.value || 0))}</strong>
      </div>
    `).join("");
}

function renderStack(containerId, items) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!items.length) {
    container.innerHTML = '<div class="stack-item"><strong>Sem dados</strong><span>Nada para exibir.</span></div>';
    return;
  }

  container.innerHTML = items.map((item) => `
      <div class="stack-item">
        <strong>Indicador</strong>
        <span>${escapeHtml(item)}</span>
      </div>
    `).join("");
}

function renderTable(bodyId, rows, columns, options = {}) {
  const tbody = document.getElementById(bodyId);
  if (!tbody) return;
  const rawColumns = options.rawColumns || new Set();

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${columns}">Sem dados para exibir.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((row) => `<tr>${row.map((cell, index) => `<td>${rawColumns.has(index) ? cell : escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
}

function updatePagerState(prefix, view) {
  const total = Number(view?.total || 0);
  const limit = Number(view?.limit || 20);
  const offset = Number(view?.offset || 0);
  const start = total ? offset + 1 : 0;
  const end = Math.min(offset + limit, total);
  setText(`${prefix}-pagination-summary`, total ? `${start}-${end} de ${total} registros` : "Nenhum registro no recorte.");

  const prev = document.getElementById(`${prefix}-prev`);
  const next = document.getElementById(`${prefix}-next`);
  if (prev) prev.disabled = offset <= 0;
  if (next) next.disabled = offset + limit >= total;
}

async function refreshProductDetail(state, fallbackItems = []) {
  const availableIds = new Set((fallbackItems || []).map((item) => item.id));
  const preferredId =
    availableIds.size && state.views.catalog.selectedId && availableIds.has(state.views.catalog.selectedId)
      ? state.views.catalog.selectedId
      : fallbackItems[0]?.id;
  if (!preferredId) {
    renderStack("catalog-product-summary", ["Selecione um SKU para abrir a ficha completa."]);
    renderTable("catalog-product-attributes", [], 2);
    return;
  }

  try {
    const payload = await fetchJson(buildDataUrl(state, `api/catalog/products/${encodeURIComponent(preferredId)}`));
    const product = payload.product || {};
    state.views.catalog.selectedId = product.id || preferredId;
    renderStack("catalog-product-summary", [
      `${product.title || "Sem titulo"} (${product.sku || "-"})`,
      `Status ${normalizeLabel(product.status)} | categoria ${product.categoryName || "Sem categoria"}.`,
      `Preco ${formatCurrency(product.currentPrice || 0)} | de ${formatCurrency(product.compareAtPrice || product.currentPrice || 0)} | estoque ${product.stock || 0}.`,
      `Receita ${formatCurrency(product.revenueAmount || 0)} | vendidos ${product.soldUnits || 0} | imagens ${product.imageCount || 0}.`,
      `Dimensoes ${formatDimension(product.heightCm)} x ${formatDimension(product.widthCm)} x ${formatDimension(product.lengthCm)} cm | peso ${formatDimension(product.weightGrams)} g.`,
    ]);
    renderTable(
      "catalog-product-attributes",
      (Array.isArray(product.attributes) ? product.attributes : []).slice(0, 20).map((item) => [item.name || item.nome || "Atributo", item.value || item.valor || "-"]),
      2,
    );
  } catch (error) {
    renderStack("catalog-product-summary", [`Falha ao abrir detalhe do produto: ${error.message}`]);
    renderTable("catalog-product-attributes", [], 2);
  }
}

function renderProductGrowthCards(containerId, items) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const rows = Array.isArray(items) ? items.slice(0, 8) : [];
  if (!rows.length) {
    container.innerHTML = '<div class="stack-item"><strong>Sem dados</strong><span>Sincronize pedidos para gerar crescimento por produto.</span></div>';
    return;
  }

  container.innerHTML = rows
    .map((item) => `
      <article class="product-growth-card">
        <img class="product-growth-card__thumb" src="${escapeHtml(item.imageUrl || "logo.png")}" alt="${escapeHtml(item.productName || item.title || item.sku || "Produto")}" />
        <div class="product-growth-card__meta">
          <strong>${escapeHtml(item.productName || item.title || item.sku || "Produto")}</strong>
          <span>${escapeHtml(item.sku || "Sem SKU")} • ${escapeHtml(String(item.currentUnits || 0))} itens</span>
        </div>
        <div class="product-growth-card__value">
          <strong>${escapeHtml(formatCurrency(item.currentRevenue || 0))}</strong>
          <span>${escapeHtml(formatSignedPercent(item.revenueGrowth || 0))}</span>
        </div>
      </article>
    `)
    .join("");
}

async function refreshOrderDetail(state, fallbackItems = []) {
  const availableIds = new Set((fallbackItems || []).map((item) => item.id));
  const preferredId =
    availableIds.size && state.views.orders.selectedId && availableIds.has(state.views.orders.selectedId)
      ? state.views.orders.selectedId
      : fallbackItems[0]?.id;
  if (!preferredId) {
    renderStack("order-detail-summary", ["Selecione um pedido para abrir o contexto operacional."]);
    renderTable("order-detail-items-table", [], 4);
    renderStack("order-detail-freight", []);
    renderStack("order-detail-financial", []);
    renderStack("order-detail-threads", []);
    return;
  }

  try {
    const payload = await fetchJson(buildDataUrl(state, `api/orders/${encodeURIComponent(preferredId)}`));
    const order = payload.order || {};
    state.views.orders.selectedId = order.id || preferredId;
    renderStack("order-detail-summary", [
      `Pedido ${order.externalId || order.id || "-"} em ${normalizeLabel(order.status)}.`,
      `${order.buyerName || "Cliente nao informado"} | total ${formatCurrency(order.totalAmount || 0)} | ${order.itemCount || 0} itens / ${order.units || 0} unidades.`,
      `Frete ${formatCurrency(order.freightAmount || 0)} | desconto ${formatCurrency(order.discountAmount || 0)} | metodo ${order.shippingMethod || "nao informado"}.`,
      `Aprovado em ${formatDate(order.approvedAt || order.importedAt || order.createdAt)} | enviado em ${formatDate(order.shippedAt)} | entregue em ${formatDate(order.deliveredAt)}.`,
    ]);
    renderTable(
      "order-detail-items-table",
      (order.items || []).map((item) => [item.sku || "-", item.title || "Sem descricao", String(item.quantity || 0), formatCurrency(item.totalPrice || 0)]),
      4,
    );
    renderStack(
      "order-detail-freight",
      (order.freightQuotes || []).length
        ? order.freightQuotes.slice(0, 5).map((item) => `${item.carrierName || item.serviceName || "Transportadora"} · ${normalizeLabel(item.status)} · ${formatCurrency(item.quotedAmount || 0)} · ${item.deliveryDays || 0} dias`)
        : ["Nenhuma cotacao de frete vinculada a este pedido."],
    );
    renderStack(
      "order-detail-financial",
      (order.financialEntries || []).length
        ? order.financialEntries.slice(0, 5).map((item) => `${normalizeLabel(item.type)} · ${normalizeLabel(item.status)} · liquido ${formatCurrency(item.netAmount || 0)}`)
        : ["Sem lancamentos financeiros relacionados."],
    );
    renderStack(
      "order-detail-threads",
      (order.threads || []).length
        ? order.threads.slice(0, 5).map((item) => `${item.externalThreadId || item.id} · ${normalizeLabel(item.status)} · ${item.unreadCount || 0} nao lidas`)
        : ["Nenhuma thread registrada para este pedido."],
    );
  } catch (error) {
    renderStack("order-detail-summary", [`Falha ao abrir detalhe do pedido: ${error.message}`]);
    renderTable("order-detail-items-table", [], 4);
    renderStack("order-detail-freight", []);
    renderStack("order-detail-financial", []);
    renderStack("order-detail-threads", []);
  }
}

function appendSyncFeedback(state, text) {
  state.lastSyncFeedback.unshift({ text, at: new Date().toISOString() });
  state.lastSyncFeedback = state.lastSyncFeedback.slice(0, 6);
  renderSyncFeedback(state);
}

function describeSyncResult(result) {
  if (result?.partial && Array.isArray(result?.errors) && result.errors.length) {
    const firstError = result.errors[0];
    const firstMessage = firstError?.message || "concluido com avisos";
    return `concluido com avisos (${firstMessage})`;
  }
  if (result?.ok === false) {
    return result.error || "sincronizacao indisponivel nesta configuracao";
  }
  if (result.partial) return "concluido parcialmente";
  if (result.summary?.warnings?.length) return "concluido com avisos";
  if (result.summary?.fetchedOrders != null) return `${result.summary.fetchedOrders} registros consultados`;
  if (result.summary?.fetchedEntries != null) return `${result.summary.fetchedEntries} lancamentos consultados`;
  if (result.summary?.publishedFetched != null) return `${result.summary.publishedFetched} produtos publicados consultados`;
  return "sincronizacao concluida";
}

function normalizeIdentityDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function resolveIdentityDocumentType(type, value) {
  const normalized = String(type || "").trim().toUpperCase();
  if (normalized === "CPF" || normalized === "CNPJ") return normalized;
  const digits = normalizeIdentityDigits(value);
  if (digits.length === 11) return "CPF";
  if (digits.length === 14) return "CNPJ";
  return "";
}

function formatIdentityDocumentInput(type, value) {
  const digits = normalizeIdentityDigits(value);
  const resolvedType = resolveIdentityDocumentType(type, digits);
  if (!digits) return "";
  if (resolvedType === "CPF") {
    return digits
      .slice(0, 11)
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  }
  if (resolvedType === "CNPJ") {
    return digits
      .slice(0, 14)
      .replace(/(\d{2})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1/$2")
      .replace(/(\d{4})(\d{1,2})$/, "$1-$2");
  }
  return digits;
}

function formatIdentityDocument(type, value) {
  const digits = normalizeIdentityDigits(value);
  if (!digits) return "Nao informado";
  return formatIdentityDocumentInput(type, digits);
}

function buildAdminUrl(state, baseUrl) {
  const params = new URLSearchParams();
  if (state.workspaceId) params.set("workspaceId", state.workspaceId);
  if (state.session?.user?.email) params.set("actingUserEmail", state.session.user.email);
  return `${baseUrl}?${params.toString()}`;
}

function buildScopedUrl(state, baseUrl) {
  const params = new URLSearchParams();
  if (state.workspaceId) params.set("workspaceId", state.workspaceId);
  if (state.session?.user?.email) params.set("actingUserEmail", state.session.user.email);
  const query = params.toString();
  return query ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${query}` : baseUrl;
}

function buildDataUrl(state, baseUrl, params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === "") return;
    query.set(key, String(value));
  });
  const nextUrl = query.toString() ? `${baseUrl}?${query.toString()}` : baseUrl;
  return buildScopedUrl(state, nextUrl);
}

function withWorkspace(url, workspaceId) {
  if (!workspaceId) return url;
  return `${url}${url.includes("?") ? "&" : "?"}workspaceId=${encodeURIComponent(workspaceId)}`;
}

function getNextRole(currentRole) {
  const sequence = ["viewer", "operator", "admin"];
  const currentIndex = sequence.indexOf(String(currentRole || "viewer").toLowerCase());
  return sequence[(currentIndex + 1) % sequence.length];
}

function setLoading(button, isLoading, loadingText) {
  if (!button) return;
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent;
  button.disabled = isLoading;
  button.textContent = isLoading ? loadingText : button.dataset.defaultLabel;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function setInputValue(id, value) {
  const element = document.getElementById(id);
  if (!element) return;
  if (element.tagName === "INPUT" && String(element.type || "").toLowerCase() === "date") {
    element.value = normalizeDateInputValue(value);
    return;
  }
  element.value = value;
}

function normalizeDateInputValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const directMatch = raw.match(/^\d{4}-\d{2}-\d{2}$/);
  if (directMatch) return raw;
  const isoWithTimeMatch = raw.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoWithTimeMatch) return isoWithTimeMatch[1];

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return formatLocalDateKey(parsed);
}

function formatLocalDateKey(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function setSelectValue(id, value) {
  const element = document.getElementById(id);
  if (element) element.value = value;
}

function setChecked(id, checked) {
  const element = document.getElementById(id);
  if (element) element.checked = Boolean(checked);
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeLabel(value) {
  return String(value || "").replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0));
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function formatSignedPercent(value) {
  const numeric = Number(value || 0);
  return `${numeric >= 0 ? "+" : ""}${numeric.toFixed(2)}%`;
}

function formatDate(value) {
  if (!value) return "Sem data";
  const raw = String(value).trim();
  const dateOnlyMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return `${day}/${month}/${year}`;
  }
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatShortDate(value) {
  if (!value) return "Sem data";
  const raw = String(value).trim();
  const dateOnlyMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return `${day}/${month}/${year}`;
  }
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

function formatDimension(value) {
  if (value == null || value === "") return "-";
  return Number(value).toFixed(0);
}

function compactBucket(value) {
  if (!value) return "";
  const parts = String(value).split("-");
  if (parts.length === 2) return `${parts[1]}/${parts[0].slice(2)}`;
  if (parts.length === 3) return `${parts[2]}/${parts[1]}`;
  return value;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
