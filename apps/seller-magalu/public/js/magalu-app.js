(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STORAGE_ACCOUNT = "dachbyte_magalu_account_id";
  const STORAGE_THEME = "dachbyte_magalu_theme";
  const STORAGE_COLLAPSED = "magalu:shell:collapsed";
  const STORAGE_GROUPS = "magalu:shell:groups";

  const state = {
    accounts: [],
    selectedAccountId: Number(localStorage.getItem(STORAGE_ACCOUNT) || 0) || null,
    offset: 0,
    limit: 50,
    total: 0,
    rows: [],
    writeRows: { price: null, stock: null },
    writeSelection: { price: new Set(), stock: new Set() },
    operationModes: { price: "filters", stock: "filters" },
    writeStatus: null,
    catalogStatus: null,
    diagnostics: null,
    activePreview: null,
    syncPolling: false,
    syncStarting: false,
    dashboardPeriod: "7d",
    dashboardRequestId: 0,
    dashboardAbortController: null,
  };

  const routes = {
    "/": { title: "Painel", page: "mg-dashboard", group: "overview" },
    "/ranking": { title: "Ranking de anúncios", page: "mg-ranking-page", group: "overview" },
    "/projecao": { title: "Projeção mensal", page: "mg-projection-page", group: "overview" },
    "/catalogo": { title: "Consulta de catálogo", page: "mg-catalog-page", group: "products" },
    "/pedidos": { title: "Pedidos", page: "mg-orders-page", group: "orders" },
    "/gestao-skus": { title: "Gestão de catálogo", page: "mg-sku-management-page", group: "operations" },
    "/precos": { title: "Preços", page: "mg-price-page", group: "operations" },
    "/estoque": { title: "Estoque", page: "mg-stock-page", group: "operations" },
    "/promocoes": { title: "Promoções", page: "mg-promotions-page", group: "promotions" },
    "/margem": { title: "Margem de venda", page: "mg-financial-margin-page", group: "financial" },
    "/calculadora": { title: "Calculadora", page: "mg-financial-calculator-page", group: "financial" },
    "/contas": { title: "Contas vinculadas", page: "mg-accounts-page", group: "account" },
    "/usuarios": { title: "Usuários", page: "mg-users-page", group: "account" },
    "/plano": { title: "Plano e créditos", page: "mg-plan-page", group: "account" },
    "/sincronizacao": { title: "Integrações", page: "mg-sync-page", group: "account" },
    "/integracoes": { title: "Integrações", page: "mg-sync-page", group: "account" },
    "/ajuda": { title: "Ajuda e contato", page: "mg-help-page", group: "account" },
  };

  const REQUIRED_SCOPES = [
    ["open:portfolio-skus-seller:read", "SKU · leitura"],
    ["open:portfolio-prices-seller:read", "Preço · leitura"],
    ["open:portfolio-stocks-seller:read", "Estoque · leitura"],
    ["open:portfolio-skus-seller:write", "SKU · escrita"],
    ["open:portfolio-prices-seller:write", "Preço · escrita"],
    ["open:portfolio-stocks-seller:write", "Estoque · escrita"],
  ];

  function route() {
    const path = location.pathname.replace(/^\/magalu/, "").replace(/\/$/, "") || "/";
    return routes[path] ? path : "/";
  }

  function readJsonStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function writeJsonStorage(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_error) {}
  }

  async function fetchResponse(url, options = {}) {
    const { loading = "modal", ...requestOptions } = options;
    if (loading === "modal") window.MagaluLoadingOverlay?.show({ message: "Carregando dados da conta Magalu..." });
    try {
      const response = await fetch(url, {
        credentials: "include",
        headers: {
          Accept: "application/json",
          ...(requestOptions.body ? { "Content-Type": "application/json" } : {}),
          ...(requestOptions.headers || {}),
        },
        ...requestOptions,
      });
      if (!response.ok) {
        const data = await response.clone().json().catch(() => ({}));
        const error = new Error(data.message || data.error || `HTTP ${response.status}`);
        error.status = response.status;
        error.payload = data;
        throw error;
      }
      return response;
    } finally { if (loading === "modal") window.MagaluLoadingOverlay?.hide(); }
  }

  async function fetchJson(url, options = {}) {
    const response = await fetchResponse(url, options);
    return response.json().catch(() => ({}));
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
  }

  function money(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(number)
      : "—";
  }

  function accountLabel(account) {
    // Nome dado em Contas vinculadas; sem nome, um rotulo legivel em vez do codigo da organizacao.
    return account?.magalu_tenant_name || `Conta Magalu ${account?.id ? `#${account.id}` : ""}`.trim();
  }

  function selected() {
    return state.accounts.find((account) => Number(account.id) === Number(state.selectedAccountId)) || null;
  }

  function showAlert(message, tone = "success", { sticky = false } = {}) {
    const element = $("mg-oauth-alert");
    if (!element) return;
    element.hidden = false;
    element.dataset.tone = tone;
    element.textContent = message;
    clearTimeout(showAlert.timer);
    if (!sticky) {
      showAlert.timer = setTimeout(() => { element.hidden = true; }, 7000);
    }
  }

  function setSyncBanner(status, title, copy) {
    const banner = $("mg-sync-banner");
    if (!banner) return;
    banner.dataset.state = status || "idle";
    $("mg-sync-banner-title").textContent = title || "Sincronização";
    $("mg-sync-banner-copy").textContent = copy || "";
  }

  function openNavGroup(groupId, { persist = true } = {}) {
    const groups = {};
    document.querySelectorAll("[data-group-toggle]").forEach((button) => {
      const id = button.dataset.groupToggle;
      const opened = id === groupId;
      button.setAttribute("aria-expanded", String(opened));
      const wrapper = button.closest(".mg-nav__group");
      wrapper?.classList.toggle("is-open", opened);
      const children = wrapper?.querySelector(".mg-nav__children");
      if (children) children.hidden = !opened;
      groups[id] = opened;
    });
    if (persist) writeJsonStorage(STORAGE_GROUPS, groups);
  }

  function initShell() {
    const app = document.querySelector(".mg-app");
    app.dataset.theme = localStorage.getItem(STORAGE_THEME) || "light";

    function syncSidebarViewport() {
      const desktop = window.innerWidth > 900;
      document.body.classList.toggle("mg-shell-collapsed", desktop && readJsonStorage(STORAGE_COLLAPSED, false));
      if (desktop) document.body.classList.remove("mg-shell-mobile-open");
    }
    syncSidebarViewport();
    window.addEventListener("resize", syncSidebarViewport);

    $("mg-sidebar-toggle")?.addEventListener("click", () => {
      document.body.classList.toggle("mg-shell-collapsed");
      writeJsonStorage(STORAGE_COLLAPSED, document.body.classList.contains("mg-shell-collapsed"));
    });

    $("mg-menu-toggle")?.addEventListener("click", () => document.body.classList.add("mg-shell-mobile-open"));
    $("mg-backdrop")?.addEventListener("click", () => document.body.classList.remove("mg-shell-mobile-open"));

    document.querySelectorAll("[data-group-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        if (document.body.classList.contains("mg-shell-collapsed")) {
          document.body.classList.remove("mg-shell-collapsed");
          writeJsonStorage(STORAGE_COLLAPSED, false);
        }
        const expanded = button.getAttribute("aria-expanded") === "true";
        if (expanded) {
          button.setAttribute("aria-expanded", "false");
          const wrapper = button.closest(".mg-nav__group");
          wrapper?.classList.remove("is-open");
          const children = wrapper?.querySelector(".mg-nav__children");
          if (children) children.hidden = true;
          const groupState = readJsonStorage(STORAGE_GROUPS, {});
          groupState[button.dataset.groupToggle] = false;
          writeJsonStorage(STORAGE_GROUPS, groupState);
        } else {
          openNavGroup(button.dataset.groupToggle);
        }
      });
    });

    $("mg-theme-toggle")?.addEventListener("click", () => {
      app.dataset.theme = app.dataset.theme === "dark" ? "light" : "dark";
      localStorage.setItem(STORAGE_THEME, app.dataset.theme);
    });

    $("mg-account-menu-toggle")?.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = $("mg-account-menu");
      const opening = menu.hidden;
      menu.hidden = !opening;
      $("mg-account-menu-toggle").setAttribute("aria-expanded", String(opening));
    });

    document.addEventListener("click", (event) => {
      const switcher = $("mg-account-switcher");
      if (switcher && !switcher.contains(event.target)) closeAccountMenu();
    });
  }

  function closeAccountMenu() {
    const menu = $("mg-account-menu");
    if (menu) menu.hidden = true;
    $("mg-account-menu-toggle")?.setAttribute("aria-expanded", "false");
  }

  function renderRoute() {
    const path = route();
    const meta = routes[path];
    const routeKey = path === "/" ? "painel" : path.slice(1);
    const app = document.querySelector(".mg-app");
    if (app) app.dataset.routeKey = routeKey;
    document.documentElement.dataset.magaluRoute = routeKey;
    document.querySelectorAll("[data-page]").forEach((element) => {
      element.hidden = element.dataset.page !== path;
    });
    document.querySelectorAll("[data-nav-path]").forEach((element) => {
      element.classList.toggle("is-active", element.dataset.navPath === path);
    });
    $("mg-page-title").textContent = meta.title;

    const storedGroups = readJsonStorage(STORAGE_GROUPS, {});
    const storedOpen = Object.keys(storedGroups).find((key) => storedGroups[key]);
    openNavGroup(meta.group || storedOpen || "overview", { persist: false });

    if (path === "/") void loadDashboard();
    else state.dashboardAbortController?.abort();
    if (["/catalogo", "/precos", "/estoque"].includes(path)) void loadCatalog();
    if (path === "/integracoes") void loadSyncCenter();
    window.dispatchEvent(new CustomEvent("magalu:routechange", { detail: { path } }));
  }

  async function loadSession() {
    try {
      const data = await fetchJson("/magalu/api/session");
      $("mg-user-name").textContent = data.user?.name || data.user?.email || "Usuário";
      $("mg-user-email").textContent = data.user?.email || "DACHBYTE";
    } catch (error) {
      console.warn("[magalu] session", error);
    }
  }

  async function loadAccounts() {
    try {
      const data = await fetchJson("/magalu/api/oauth/status");
      state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
      if (!selected() && state.accounts.length) state.selectedAccountId = Number(state.accounts[0].id);
      if (state.selectedAccountId) localStorage.setItem(STORAGE_ACCOUNT, String(state.selectedAccountId));
      updateAccountSidebar();
      renderAccounts();
      renderSidebarAccounts();
    } catch (error) {
      console.warn("[magalu] accounts", error);
      showAlert(error.message, "danger");
    }
  }

  function updateAccountSidebar() {
    const account = selected();
    $("mg-account-name").textContent = account ? accountLabel(account) : "Nenhuma conta conectada";
    $("mg-account-meta").textContent = account
      ? (account.status === "active" ? `Sync: ${account.catalog_sync_status || "idle"}` : `Status: ${account.status}`)
      : "Conecte uma organização";
    document.querySelector(".mg-status-dot")?.setAttribute("data-state", account?.status === "active" ? "active" : "pending");
  }

  function chooseAccount(accountId) {
    clearWriteSelections();
    state.selectedAccountId = Number(accountId);
    state.offset = 0;
    state.activePreview = null;
    state.diagnostics = null;
    localStorage.setItem(STORAGE_ACCOUNT, String(accountId));
    window.dispatchEvent(new CustomEvent("magalu:accountchange", { detail: { accountId: Number(accountId) } }));
    updateAccountSidebar();
    renderAccounts();
    renderSidebarAccounts();
    closeAccountMenu();
    renderRoute();
  }

  function renderSidebarAccounts() {
    const host = $("mg-sidebar-account-list");
    if (!host) return;
    host.replaceChildren();
    if (!state.accounts.length) {
      host.innerHTML = '<div class="mg-account-menu__empty">Nenhuma conta vinculada</div>';
      return;
    }
    for (const account of state.accounts) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mg-account-menu__item";
      if (Number(account.id) === Number(state.selectedAccountId)) button.classList.add("is-active");
      button.innerHTML = `<span><strong>${escapeHtml(accountLabel(account))}</strong><small>${escapeHtml(account.magalu_tenant_id || "")}</small></span><i data-state="${account.status === "active" ? "active" : "pending"}"></i>`;
      button.addEventListener("click", () => chooseAccount(account.id));
      host.append(button);
    }
  }

  function accountInitials(account) {
    const words = String(accountLabel(account)).replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : String(words[0] || "MG").slice(0, 2)).toUpperCase();
  }

  function accountDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  function accountHasWriteScopes(account) {
    const scopes = new Set(Array.isArray(account.scopes) ? account.scopes : []);
    return scopes.has("open:portfolio-prices-seller:write") && scopes.has("open:portfolio-stocks-seller:write");
  }

  function accountPill(label, tone) {
    return `<span class="mg-acct-pill mg-acct-pill--${tone}">${escapeHtml(label)}</span>`;
  }

  // Cards no padrao "Contas vinculadas" do ML: identidade, status, dados e acoes.
  function renderAccounts() {
    const list = $("mg-account-list");
    if (!list) return;
    const accounts = state.accounts || [];
    const term = String($("mg-accounts-search")?.value || "").trim().toLowerCase();
    const visible = term
      ? accounts.filter((account) => `${accountLabel(account)} ${account.magalu_tenant_id || ""}`.toLowerCase().includes(term))
      : accounts;
    const setText = (id, value) => { const element = $(id); if (element) element.textContent = String(value); };
    setText("mg-accounts-count", `${accounts.length} conta${accounts.length === 1 ? "" : "s"}`);
    setText("mg-accounts-stat-total", accounts.length);
    setText("mg-accounts-stat-active", accounts.filter((account) => account.status === "active").length);
    setText("mg-accounts-stat-write", accounts.filter(accountHasWriteScopes).length);
    setText("mg-accounts-stat-error", accounts.filter((account) => ["failed", "error"].includes(String(account.catalog_sync_status || "").toLowerCase())).length);
    const empty = $("mg-accounts-empty");
    if (empty) empty.hidden = accounts.length > 0;

    list.replaceChildren();
    if (accounts.length && !visible.length) {
      list.innerHTML = '<div class="mg-acct-empty">Nenhuma organização encontrada para esta busca.</div>';
      return;
    }
    for (const account of visible) {
      const id = Number(account.id);
      const isSelected = id === Number(state.selectedAccountId);
      const isActive = account.status === "active";
      const syncStatus = String(account.catalog_sync_status || "idle").toLowerCase();
      const card = document.createElement("article");
      card.className = "mg-acct-card";
      card.dataset.accountId = String(id);
      if (isSelected) card.dataset.selected = "true";
      const pills = [
        isSelected ? accountPill("Selecionada", "primary") : "",
        isActive ? accountPill("Conectada", "ok") : accountPill(account.status || "Indisponível", "danger"),
        accountHasWriteScopes(account) ? accountPill("Leitura + escrita", "muted") : accountPill("Somente leitura", "warn"),
        ["failed", "error"].includes(syncStatus) ? accountPill("Erro de sync", "danger") : accountPill(`Sync: ${syncStatus}`, "muted"),
      ].join("");
      card.innerHTML = `
        <header class="mg-acct-card__head"><span class="mg-acct-avatar" aria-hidden="true">${escapeHtml(accountInitials(account))}</span><div><strong>${escapeHtml(accountLabel(account))}</strong><small>${escapeHtml(account.magalu_tenant_id || "")}</small></div></header>
        <div class="mg-acct-pills">${pills}</div>
        <dl class="mg-acct-meta">
          <div><dt>Último OAuth</dt><dd>${escapeHtml(accountDate(account.last_oauth_at || account.connected_at))}</dd></div>
          <div><dt>Última sincronização</dt><dd>${escapeHtml(accountDate(account.catalog_last_synced_at))}</dd></div>
          <div><dt>Token expira</dt><dd>${escapeHtml(accountDate(account.access_expires_at))}</dd></div>
          <div><dt>Recurso no Hub</dt><dd>${escapeHtml(account.hub_sync_status || "—")}</dd></div>
        </dl>
        <div class="mg-acct-card__actions">
          <button class="mg-secondary-btn" type="button" data-account-select="${id}" ${isSelected ? "disabled" : ""}>${isSelected ? "Selecionada" : "Selecionar"}</button>
          <a class="mg-secondary-btn" href="/magalu/auth/accounts/${id}/reconnect">Reconectar</a>
          <button class="mg-secondary-btn" type="button" data-account-rename="${id}" data-account-label="${escapeHtml(accountLabel(account))}">Renomear</button>
          <button class="mg-secondary-btn" type="button" data-account-test="${id}">Testar conexão</button>
          <button class="mg-danger-btn mg-danger-btn--soft" type="button" data-account-unlink="${id}">Desvincular</button>
        </div>`;
      card.querySelector("[data-account-select]")?.addEventListener("click", () => chooseAccount(id));
      list.append(card);
    }
  }

  async function fetchCatalogStatus(account) {
    const status = await fetchJson(`/magalu/api/catalog/status?account_id=${account.id}`);
    state.catalogStatus = status;
    renderStats(status);
    return status;
  }

  // Cache do painel por conta e periodo (sessionStorage): abrir o painel de novo mostra
  // o ultimo resultado na hora; a validade vem do servidor (meta.cache_ttl_sec).
  const DASHBOARD_CACHE_KEY = "magalu:dashboard:cache:v1";
  const DASHBOARD_ORDERS_STALE_MS = 10 * 60 * 1000;
  function readDashboardCache(accountId, period) {
    try {
      const store = JSON.parse(sessionStorage.getItem(DASHBOARD_CACHE_KEY) || "{}");
      const entry = store[`${accountId}:${period}`];
      if (!entry || Date.now() > Number(entry.expiresAt || 0)) return null;
      return entry.data || null;
    } catch (_error) { return null; }
  }
  function writeDashboardCache(accountId, period, data) {
    try {
      const store = JSON.parse(sessionStorage.getItem(DASHBOARD_CACHE_KEY) || "{}");
      const ttl = Math.max(60, Number(data?.meta?.cache_ttl_sec) || 300);
      store[`${accountId}:${period}`] = { data, expiresAt: Date.now() + ttl * 1000, savedAt: Date.now() };
      const keys = Object.keys(store).sort((a, b) => Number(store[b].savedAt || 0) - Number(store[a].savedAt || 0));
      keys.slice(8).forEach((key) => delete store[key]);
      sessionStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify(store));
    } catch (_error) {}
  }
  function setDashboardSyncing(active, text) {
    const el = $("mg-dashboard-updated");
    if (!el) return;
    el.dataset.syncing = active ? "true" : "false";
    if (text) el.textContent = text;
  }

  // Periodo personalizado viaja como "custom:AAAA-MM-DD:AAAA-MM-DD" (chave unica de cache e de requisicao).
  function parseCustomPeriod(period) {
    const match = /^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(String(period || ""));
    return match ? { from: match[1], to: match[2] } : null;
  }
  function dashboardPeriodBody(period) {
    const custom = parseCustomPeriod(period);
    return custom ? { period: "custom", from: custom.from, to: custom.to } : { period };
  }
  function dashboardPeriodQuery(period) {
    return new URLSearchParams(dashboardPeriodBody(period)).toString();
  }
  function spToday() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
  function shiftIsoDate(iso, days) {
    const date = new Date(`${iso}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }
  function shortBrDate(iso) { const [, m, d] = String(iso).split("-"); return `${d}/${m}`; }
  function setDashboardPeriodButtons(period) {
    const custom = parseCustomPeriod(period);
    document.querySelectorAll("#mg-dashboard-period [data-period]").forEach((item) => item.classList.toggle("is-active", custom ? item.dataset.period === "custom" : item.dataset.period === period));
    const toggle = $("mg-dashboard-custom-toggle");
    if (toggle) toggle.textContent = custom ? (custom.from === custom.to ? shortBrDate(custom.from) : `${shortBrDate(custom.from)} – ${shortBrDate(custom.to)}`) : "Personalizado";
  }
  function closeDashboardCustom() {
    const panel = $("mg-dashboard-custom");
    if (panel) panel.hidden = true;
    $("mg-dashboard-custom-toggle")?.setAttribute("aria-expanded", "false");
  }
  function openDashboardCustom() {
    const panel = $("mg-dashboard-custom"), from = $("mg-dashboard-from"), to = $("mg-dashboard-to");
    if (!panel || !from || !to) return;
    const today = spToday(), current = parseCustomPeriod(state.dashboardPeriod);
    from.max = today; to.max = today;
    from.value = current?.from || shiftIsoDate(today, -6);
    to.value = current?.to || today;
    $("mg-dashboard-custom-error").hidden = true;
    panel.hidden = false;
    $("mg-dashboard-custom-toggle")?.setAttribute("aria-expanded", "true");
    from.focus();
  }
  function applyDashboardCustom() {
    const from = $("mg-dashboard-from")?.value || "", to = $("mg-dashboard-to")?.value || "", error = $("mg-dashboard-custom-error");
    const days = from && to ? Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000) + 1 : 0;
    const message = !from || !to ? "Informe as duas datas." : from > to ? "A data inicial deve ser anterior à final." : to > spToday() ? "Escolha datas até hoje." : days > 90 ? "Escolha um período de até 90 dias." : "";
    if (message) { error.textContent = message; error.hidden = false; return; }
    state.dashboardPeriod = `custom:${from}:${to}`;
    setDashboardPeriodButtons(state.dashboardPeriod);
    closeDashboardCustom();
    // Personalizado sempre consulta a API: pedidos do periodo e do periodo anterior, com carregamento.
    void loadDashboard({ force: true });
  }

  // Sincroniza os pedidos do periodo (fila) e espera o job desta conta terminar.
  async function runDashboardOrdersSync(account, period, controller, current, overlay) {
    let lastLoadingMessageAt = Date.now();
    const queued = await fetchJson("/magalu/api/dashboard/refresh", { method: "POST", body: JSON.stringify({ account_id: account.id, ...dashboardPeriodBody(period) }), signal: controller.signal, loading: "none" });
    if (!current()) return false;
    const deadline = Date.now() + 180000;
    while (true) {
      if (Date.now() > deadline) throw new Error("A atualização dos pedidos demorou mais que o esperado. Tente novamente.");
      const job = await fetchJson(`/magalu/api/dashboard/refresh/${encodeURIComponent(queued.job_id)}?account_id=${account.id}`, { signal: controller.signal, loading: "none" });
      if (!current()) return false;
      if (job.state === "completed") {
        if (job.result?.status !== "success") throw new Error("A leitura dos pedidos terminou parcialmente. Verifique a sincronização de Pedidos.");
        return true;
      }
      if (job.state === "failed") throw new Error(job.error || "A sincronização de pedidos falhou.");
      const now = Date.now();
      if (overlay && now - lastLoadingMessageAt >= 2400) {
        overlay.update({ message: job.progress?.stage === "orders" ? `Consultando pedidos (${Number(job.progress.scanned) || 0} lidos)...` : "Aguardando atualização dos pedidos..." });
        lastLoadingMessageAt = now;
      }
      await new Promise((resolve, reject) => { const onAbort = () => { clearTimeout(timer); reject(new DOMException("Cancelado", "AbortError")); }; const timer = setTimeout(() => { controller.signal.removeEventListener("abort", onAbort); resolve(); }, 1200); controller.signal.addEventListener("abort", onAbort, { once: true }); });
    }
  }

  // force=true (botao atualizar): sincroniza pedidos com a tela de carregamento.
  // Normal: mostra cache/resultado do servidor na hora e atualiza pedidos em segundo plano
  // somente quando a ultima leitura tem mais de 10 minutos.
  async function loadDashboard({ force = false } = {}) {
    const account = selected();
    if (!account) { window.dispatchEvent(new CustomEvent("magalu:dashboarddata", { detail: { data: null } })); return; }
    const requestedPeriod = state.dashboardPeriod;
    const requestId=++state.dashboardRequestId;
    state.dashboardAbortController?.abort();
    const controller=new AbortController();
    state.dashboardAbortController=controller;
    const current=()=>{
      if(route()!=="/"||requestId !== state.dashboardRequestId||state.dashboardPeriod !== requestedPeriod)return false;
      return Number(selected()?.id)===Number(account.id);
    };
    const emit = (data) => window.dispatchEvent(new CustomEvent("magalu:dashboarddata", { detail: { data } }));
    const dashboardUrl = (fresh) => `/magalu/api/dashboard?account_id=${account.id}&${dashboardPeriodQuery(requestedPeriod)}${fresh ? "&fresh=1" : ""}`;
    const overlay=window.MagaluLoadingOverlay;
    const cached = force ? null : readDashboardCache(account.id, requestedPeriod);
    let shown = Boolean(cached);
    let background = false;
    if (cached) emit(cached);
    try {
      if (force) {
        overlay?.show({label:"Atualizando dados",message:"Consultando pedidos da conta Magalu..."});
        if (!await runDashboardOrdersSync(account, requestedPeriod, controller, current, overlay)) return;
        overlay?.update({message:"Consolidando faturamento e indicadores..."});
        const data = await fetchJson(dashboardUrl(true),{signal:controller.signal,loading:"none"});
        if (!current()) return;
        writeDashboardCache(account.id, requestedPeriod, data);
        emit(data);
        return;
      }
      if (!shown) overlay?.show({label:"Carregando painel",message:"Calculando indicadores da conta Magalu..."});
      const data = await fetchJson(dashboardUrl(false),{signal:controller.signal,loading:"none"});
      if (!current()) return;
      writeDashboardCache(account.id, requestedPeriod, data);
      emit(data);
      shown = true;
      overlay?.hide();
      const syncedAt = Date.parse(data?.meta?.orders_synced_at || "");
      if (Number.isFinite(syncedAt) && Date.now() - syncedAt < DASHBOARD_ORDERS_STALE_MS) return;
      background = true;
      setDashboardSyncing(true, "Atualizando pedidos em segundo plano...");
      if (!await runDashboardOrdersSync(account, requestedPeriod, controller, current, null)) return;
      const fresh = await fetchJson(dashboardUrl(true),{signal:controller.signal,loading:"none"});
      if (!current()) return;
      writeDashboardCache(account.id, requestedPeriod, fresh);
      emit(fresh);
    } catch (error) {
      if (!current()||error.name==="AbortError") return;
      console.warn("[magalu] dashboard", error);
      if (background || shown) {
        setDashboardSyncing(false, "Pedidos não atualizados agora");
        if (!background) showAlert(error.message, "warning");
        return;
      }
      showAlert(error.message, "danger");
      emit(null);
    } finally {
      overlay?.hide();
      if (current()) setDashboardSyncing(false);
      if(state.dashboardAbortController===controller)state.dashboardAbortController=null;
    }
  }

  async function loadCatalog() {
    const account = selected();
    if (!account) {
      state.rows = [];
      state.total = 0;
      renderStats(null);
      renderCatalog();
      renderWriteReadiness();
      return;
    }
    try {
      const query = $("mg-catalog-search")?.value?.trim() || "";
      const statusFilter = $("mg-catalog-status")?.value || "";
      const [status, list, writeStatus] = await Promise.all([
        fetchJson(`/magalu/api/catalog/status?account_id=${account.id}`),
        fetchJson(`/magalu/api/catalog/skus?account_id=${account.id}&offset=${state.offset}&limit=${state.limit}&q=${encodeURIComponent(query)}&status=${encodeURIComponent(statusFilter)}`),
        fetchJson(`/magalu/api/writes/status?account_id=${account.id}&limit=15`).catch((error) => ({ ok: false, enabled: false, error: error.message, scopes: {}, operations: [] })),
      ]);
      state.catalogStatus = status;
      state.rows = list.rows || [];
      state.total = Number(list.total || 0);
      state.writeStatus = writeStatus;
      renderStats(status);
      renderCatalog();
      renderWriteReadiness();
      renderOperations(writeStatus.operations || []);
    } catch (error) {
      console.warn("[magalu] catalog", error);
      showAlert(error.message, "danger");
    }
  }

  function renderStats(data) {
    const stats = data?.stats || {};
    const setText = (id, value) => { const element = $(id); if (element) element.textContent = value; };
    setText("kpi-skus", stats.sku_count ?? "—");
    setText("kpi-prices", stats.priced_count ?? "—");
    setText("kpi-zero", stats.zero_stock_count ?? "—");
    setText("kpi-sync", data ? formatDate(data.account?.catalog_last_synced_at) : "—");
    setText("kpi-sync-status", data?.account?.catalog_sync_status || "aguardando conta");
  }

  function renderCatalog() {
    const body = $("mg-catalog-body");
    if (body) {
      body.replaceChildren();
      for (const row of state.rows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td><code>${escapeHtml(row.sku)}</code></td><td>${escapeHtml(row.title || "—")}</td><td>${escapeHtml(row.status || "—")}</td><td>${escapeHtml(money(row.price))}</td><td>${escapeHtml(row.quantity ?? "—")}</td>`;
        const td = document.createElement("td");
        const button = document.createElement("button");
        button.className = "mg-secondary-btn";
        button.type = "button";
        button.textContent = "Reconciliar";
        button.onclick = () => void reconcile(row.sku, button);
        td.append(button);
        tr.append(td);
        body.append(tr);
      }
    }
    if ($("mg-catalog-empty")) $("mg-catalog-empty").hidden = state.rows.length > 0;
    if ($("mg-page-meta")) $("mg-page-meta").textContent = state.total
      ? `${state.total} itens · ${state.offset + 1}-${Math.min(state.offset + state.limit, state.total)}`
      : "0 itens";
    if ($("mg-prev")) $("mg-prev").disabled = state.offset <= 0;
    if ($("mg-next")) $("mg-next").disabled = state.offset + state.limit >= state.total;
    renderWriteRows("price");
    renderWriteRows("stock");
  }

  function writeCapability(resource) {
    const scope = state.writeStatus?.scopes?.[resource];
    return Boolean(state.writeStatus?.enabled && scope?.available);
  }

  function renderWriteReadiness() {
    for (const resource of ["price", "stock"]) {
      const badge = $(`mg-${resource}-write-state`);
      const help = $(`mg-${resource}-write-help`);
      const enabled = Boolean(state.writeStatus?.enabled);
      const available = Boolean(state.writeStatus?.scopes?.[resource]?.available);
      if (badge) {
        badge.textContent = !enabled ? "desativado" : available ? "pronto" : "scope ausente";
        badge.dataset.state = !enabled ? "disabled" : available ? "ready" : "missing";
      }
      if (help) {
        help.textContent = !enabled
          ? "Escrita remota permanece desativada neste ambiente."
          : available
            ? "Preview ao vivo, confirmação, fila e verificação pós-escrita."
            : `Reconecte a conta com ${state.writeStatus?.scopes?.[resource]?.required || "scope de escrita"}.`;
      }
      updateWriteSelectionSummary(resource);
    }
  }

  function renderWriteRows(resource) {
    const host = $(`mg-${resource}-write-list`);
    if (!host) return;
    host.replaceChildren();
    const canWrite = writeCapability(resource);
    const rows = state.writeRows[resource] || [];
    if (!rows.length) {
      host.innerHTML = '<div class="mg-empty-state"><strong>Nenhum SKU disponível</strong><p>Sincronize o catálogo antes de preparar alterações.</p></div>';
      updateWriteSelectionSummary(resource);
      return;
    }
    const selectedSkus = state.writeSelection[resource] || new Set();
    for (const row of rows) {
      const item = document.createElement("div");
      item.className = "mg-write-row";
      item.dataset.sku = row.sku;
      item.dataset.resource = resource;
      if (resource === "price") {
        const currentPrice = Number.isFinite(Number(row.price)) ? Number(row.price) : "";
        const currentList = Number.isFinite(Number(row.list_price)) ? Number(row.list_price) : currentPrice;
        item.innerHTML = `<input class="mg-write-select" type="checkbox" ${selectedSkus.has(String(row.sku)) ? "checked" : ""} ${canWrite ? "" : "disabled"}><div class="mg-write-product"><strong>${escapeHtml(row.sku)}</strong><span>${escapeHtml(row.title || "—")}</span></div><div class="mg-write-current"><span>Atual</span><strong>${escapeHtml(money(row.price))}</strong></div><label class="mg-write-field"><span>Preço</span><input data-field="price" type="number" min="0.01" step="0.01" value="${escapeHtml(currentPrice)}" ${canWrite ? "" : "disabled"}></label><label class="mg-write-field"><span>Preço de lista</span><input data-field="list_price" type="number" min="0.01" step="0.01" value="${escapeHtml(currentList)}" ${canWrite ? "" : "disabled"}></label>`;
      } else {
        const quantity = Number.isInteger(Number(row.quantity)) ? Number(row.quantity) : 0;
        item.innerHTML = `<input class="mg-write-select" type="checkbox" ${selectedSkus.has(String(row.sku)) ? "checked" : ""} ${canWrite ? "" : "disabled"}><div class="mg-write-product"><strong>${escapeHtml(row.sku)}</strong><span>${escapeHtml(row.title || "—")}</span></div><div class="mg-write-current"><span>Atual</span><strong>${escapeHtml(row.quantity ?? "—")}</strong></div><label class="mg-write-field"><span>Quantidade absoluta</span><input data-field="quantity" type="number" min="0" step="1" value="${escapeHtml(quantity)}" ${canWrite ? "" : "disabled"}></label>`;
      }
      host.append(item);
    }
    updateWriteSelectionSummary(resource);
  }

  function updateWriteSelectionSummary(resource) {
    const selected = state.writeSelection[resource]?.size || 0;
    const count = $(`mg-${resource}-selection-count`);
    if (count) count.textContent = `${selected} selecionado${selected === 1 ? "" : "s"}`;
    const preview = $(`mg-${resource}-preview-btn`);
    if (preview) preview.disabled = !writeCapability(resource) || selected === 0;
  }

  function parseExplicitSkus(value) {
    return [...new Set(String(value || "").split(/[\n,;]/).map((item) => item.trim()).filter(Boolean))].slice(0, 100);
  }

  function activeOperationMode(resource) {
    return state.operationModes[resource] || "filters";
  }

  function clearWriteSelections() {
    state.writeRows.price = null;
    state.writeRows.stock = null;
    for (const resource of ["price", "stock"]) {
      state.writeSelection[resource] = new Set();
      updateWriteSelectionSummary(resource);
      const single = $(`mg-${resource}-sku-input`);
      const list = $(`mg-${resource}-sku-list`);
      if (single) single.value = "";
      if (list) list.value = "";
    }
  }

  function setOperationMode(resource, mode) {
    state.operationModes[resource] = mode;
    document.querySelectorAll(`[data-operation-target="${resource}"]`).forEach((button) => {
      const active = button.dataset.operationMode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    for (const candidate of ["filters", "single", "list"]) {
      const panel = $(`mg-${resource}-${candidate}-panel`);
      if (panel) panel.hidden = candidate !== mode;
    }
    state.writeRows[resource] = null;
    state.writeSelection[resource] = new Set();
    renderWriteRows(resource);
  }

  async function loadWriteFilterSelection(resource) {
    const account = selected();
    if (!account) return showAlert("Selecione uma conta Magalu.", "danger");
    const q = $(`mg-${resource}-filter-q`)?.value?.trim() || "";
    const status = $(`mg-${resource}-filter-status`)?.value || "";
    const safeLimit = Math.min(100, Math.max(1, Number(state.writeStatus?.limits?.max_batch_size || 50)));
    try {
      const data = await fetchJson(`/magalu/api/catalog/skus?account_id=${account.id}&offset=0&limit=${safeLimit}&q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`);
      state.writeRows[resource] = data.rows || [];
      state.writeSelection[resource] = new Set();
      renderWriteRows(resource);
      const meta = $(`mg-${resource}-filter-meta`);
      if (meta) meta.textContent = Number(data.total||0) > state.writeRows[resource].length
        ? `${state.writeRows[resource].length} de ${data.total} SKU(s) carregados. Refine o filtro para respeitar o limite seguro do lote.`
        : `${state.writeRows[resource].length} SKU(s) carregados neste recorte.`;
      showAlert(state.writeRows[resource].length ? "Recorte carregado para revisão." : "Nenhum SKU encontrado neste filtro.", state.writeRows[resource].length ? "success" : "warning");
    } catch (error) { showAlert(error.message, "danger"); }
  }

  async function resolveWriteSelection(resource) {
    const account = selected();
    if (!account) return showAlert("Selecione uma conta Magalu.", "danger");
    const value = activeOperationMode(resource) === "single"
      ? ($(`mg-${resource}-sku-input`)?.value || "")
      : ($(`mg-${resource}-sku-list`)?.value || "");
    const skus = parseExplicitSkus(value);
    if (!skus.length) return showAlert("Informe ao menos um SKU.", "danger");
    try {
      const responses = await Promise.all(skus.map((sku) => fetchJson(`/magalu/api/catalog/skus?account_id=${account.id}&limit=10&q=${encodeURIComponent(sku)}`)));
      const candidates = responses.flatMap((response) => response.rows || []);
      const rows = skus.map((sku) => candidates.find((row) => String(row.sku) === sku)).filter(Boolean);
      state.writeRows[resource] = rows;
      state.writeSelection[resource] = new Set(rows.map((row) => String(row.sku)));
      renderWriteRows(resource);
      showAlert(rows.length === skus.length ? `${rows.length} SKU(s) prontos para revisão.` : `${rows.length} SKU(s) encontrados; revise itens ausentes.`, rows.length ? "success" : "warning");
    } catch (error) { showAlert(error.message, "danger"); }
  }

  function bindWriteSelectionModes() {
    document.querySelectorAll("[data-operation-mode]").forEach((button) => button.addEventListener("click", () => {
      const resource = button.dataset.operationTarget;
      const mode = button.dataset.operationMode;
      setOperationMode(resource, mode);
    }));
    $("mg-price-load-filter")?.addEventListener("click", () => void loadWriteFilterSelection("price"));
    $("mg-stock-load-filter")?.addEventListener("click", () => void loadWriteFilterSelection("stock"));
    $("mg-price-resolve")?.addEventListener("click", () => void resolveWriteSelection("price"));
    $("mg-price-resolve-list")?.addEventListener("click", () => void resolveWriteSelection("price"));
    $("mg-stock-resolve")?.addEventListener("click", () => void resolveWriteSelection("stock"));
    $("mg-stock-resolve-list")?.addEventListener("click", () => void resolveWriteSelection("stock"));
    for (const resource of ["price", "stock"]) {
      $(`mg-${resource}-select-loaded`)?.addEventListener("click", () => {
        state.writeSelection[resource] = new Set((state.writeRows[resource] || []).map((row) => String(row.sku)));
        renderWriteRows(resource);
      });
      $(`mg-${resource}-clear-selection`)?.addEventListener("click", () => {
        state.writeSelection[resource] = new Set();
        renderWriteRows(resource);
      });
    }
    document.addEventListener("change", (event) => {
      const checkbox = event.target.closest?.(".mg-write-select");
      if (!checkbox) return;
      const row = checkbox.closest(".mg-write-row[data-resource]");
      if (!row) return;
      const resource = row.dataset.resource;
      if (!state.writeSelection[resource]) state.writeSelection[resource] = new Set();
      if (checkbox.checked) state.writeSelection[resource].add(String(row.dataset.sku));
      else state.writeSelection[resource].delete(String(row.dataset.sku));
      updateWriteSelectionSummary(resource);
    });
  }

  function collectChanges(resource) {
    const changes = [];
    document.querySelectorAll(`.mg-write-row[data-resource="${resource}"]`).forEach((row) => {
      if (!state.writeSelection[resource]?.has(String(row.dataset.sku))) return;
      const change = { sku: row.dataset.sku };
      row.querySelectorAll("[data-field]").forEach((input) => { change[input.dataset.field] = input.value; });
      changes.push(change);
    });
    return changes;
  }

  async function previewWrite(resource) {
    const account = selected();
    if (!account) return showAlert("Selecione uma conta Magalu.", "danger");
    const changes = collectChanges(resource);
    if (!changes.length) return showAlert("Selecione ao menos um SKU para alterar.", "danger");
    const button = $(`mg-${resource}-preview-btn`);
    button.disabled = true;
    try {
      const preview = await fetchJson("/magalu/api/writes/preview", {
        method: "POST",
        body: JSON.stringify({ account_id: account.id, resource, changes }),
      });
      state.activePreview = preview;
      renderPreview(preview);
      showAlert(`Preview pronto: ${preview.summary.changed} alteração(ões), ${preview.summary.noop} sem mudança, ${preview.summary.invalid} inválida(s).`);
    } catch (error) {
      showAlert(error.message, "danger");
    } finally {
      button.disabled = !writeCapability(resource);
    }
  }

  function renderPreview(preview) {
    const panel = $("mg-write-preview");
    const body = $("mg-write-preview-body");
    if (!panel || !body) return;
    panel.hidden = false;
    $("mg-write-preview-title").textContent = preview.resource === "price" ? "Preview de preços" : "Preview de estoque";
    $("mg-write-preview-expiry").textContent = `Expira em ${formatDate(preview.expires_at)}`;
    body.replaceChildren();
    for (const row of preview.rows || []) {
      const tr = document.createElement("tr");
      const before = preview.resource === "price"
        ? `${money(row.before?.price)} / lista ${money(row.before?.list_price)}`
        : String(row.before?.quantity ?? "sem registro");
      const after = preview.resource === "price"
        ? `${money(row.requested?.price)} / lista ${money(row.requested?.list_price)}`
        : String(row.requested?.quantity ?? "—");
      const status = !row.valid ? `Erro: ${row.error || row.error_code}` : !row.changed ? "Sem alteração" : `${row.method} pendente`;
      tr.innerHTML = `<td><code>${escapeHtml(row.sku)}</code></td><td>${escapeHtml(before)}</td><td>${escapeHtml(after)}</td><td>${escapeHtml(status)}</td>`;
      if (!row.valid) tr.dataset.tone = "danger";
      else if (!row.changed) tr.dataset.tone = "muted";
      body.append(tr);
    }
    $("mg-write-confirm").checked = false;
    $("mg-write-apply-btn").disabled = true;
  }

  async function applyPreview() {
    const preview = state.activePreview;
    if (!preview?.preview_id) return showAlert("Gere um preview antes de confirmar.", "danger");
    if (!$("mg-write-confirm")?.checked) return showAlert("Marque a confirmação antes de aplicar as alterações.", "danger");
    const button = $("mg-write-apply-btn");
    button.disabled = true;
    try {
      const result = await fetchJson("/magalu/api/writes/apply", {
        method: "POST",
        body: JSON.stringify({ preview_id: preview.preview_id }),
      });
      showAlert(`${result.operations.length} operação(ões) enviada(s) à fila protegida.`);
      window.dispatchEvent(new CustomEvent("magalu:processqueued", { detail: { accountId: state.selectedAccountId } }));
      state.activePreview = null;
      $("mg-write-preview").hidden = true;
      setTimeout(() => void loadCatalog(), 1500);
    } catch (error) {
      showAlert(error.message, "danger");
    } finally {
      button.disabled = false;
    }
  }

  function renderOperations(operations) {
    const host = $("mg-write-operations");
    if (!host) return;
    host.replaceChildren();
    for (const operation of operations || []) {
      const row = document.createElement("div");
      row.className = "mg-operation-row";
      row.dataset.status = operation.status;
      row.innerHTML = `<div><strong>${escapeHtml(operation.sku)}</strong><span>${escapeHtml(operation.resource_type)}</span></div><b>${escapeHtml(operation.status)}</b><small>${escapeHtml(formatDate(operation.created_at))}</small>${operation.error_code ? `<em>${escapeHtml(operation.error_code)}</em>` : ""}`;
      if (["dispatching", "accepted", "divergent", "uncertain"].includes(String(operation.status))) {
        const action = document.createElement("button");
        action.className = "mg-secondary-btn mg-operation-reverify";
        action.type = "button";
        action.textContent = "Reverificar";
        action.onclick = () => void reverifyOperation(operation.id, action);
        row.append(action);
      }
      host.append(row);
    }
    const empty = $("mg-write-operations-empty");
    if (empty) empty.hidden = Boolean((operations || []).length);
  }

  async function reverifyOperation(operationId, button) {
    button.disabled = true;
    try {
      await fetchJson(`/magalu/api/writes/operations/${encodeURIComponent(operationId)}/reverify`, {
        method: "POST", body: JSON.stringify({}),
      });
      showAlert("Reverificação enfileirada em modo somente leitura.");
      setTimeout(() => void loadCatalog(), 1500);
    } catch (error) {
      showAlert(error.message, "danger");
    } finally {
      button.disabled = false;
    }
  }

  function syncStatusDescription(status, error, run = null) {
    if (status === "queued") return ["queued", "Sincronização na fila", "Aguardando o worker Magalu iniciar a leitura."];
    if (status === "running") {
      const result = run?.result && typeof run.result === "object" ? run.result : {};
      const count = Number(run?.scanned_count || 0).toLocaleString("pt-BR");
      const stage = result.stage === "known_sku_refresh" ? "Atualizando SKUs já salvos" : "Descobrindo SKUs nas páginas disponíveis";
      return ["running", "Sincronização em andamento", `${stage} · ${count} processado(s). Pode sair desta tela; o trabalho continua em segundo plano.`];
    }
    if (status === "success") return ["success", "Sincronização concluída", `Base atualizada: ${Number(run?.updated_count || 0).toLocaleString("pt-BR")} SKU(s) atualizados e ${Number(run?.created_count || 0).toLocaleString("pt-BR")} novo(s).`];
    if (status === "partial") return ["warning", "Sincronização concluída com avisos", error || "Algumas leituras de detalhe não puderam ser atualizadas."];
    if (status === "failed") return ["failed", "Falha na sincronização", error || "Abra o diagnóstico para identificar o endpoint que falhou."];
    return ["idle", "Aguardando sincronização", "Nenhuma execução ativa para a conta selecionada."];
  }

  async function sync() {
    const account = selected();
    if (!account) return showAlert("Selecione ou conecte uma conta Magalu.", "danger");
    if (state.syncStarting || state.syncPolling) return;
    state.syncStarting = true;
    document.querySelectorAll("[data-sync]").forEach((button) => { button.disabled = true; });
    try {
      const queued = await fetchJson("/magalu/api/catalog/sync", {
        method: "POST",
        body: JSON.stringify({ account_id: account.id }),
      });
      const message = queued.already_running
        ? "Sincronização já está em andamento. Acompanhando a execução atual..."
        : "Sincronização enfileirada. Acompanhando a execução...";
      showAlert(message, "success", { sticky: true });
      window.dispatchEvent(new CustomEvent("magalu:processqueued", { detail: { kind: "sync" } }));
      setSyncBanner("queued", queued.already_running ? "Sincronização em andamento" : "Sincronização na fila", queued.already_running ? "Acompanhando o worker atual." : "Aguardando o worker iniciar.");
      await pollSync(account.id);
    } catch (error) {
      showAlert(error.message, "danger", { sticky: true });
    } finally {
      state.syncStarting = false;
      if (!state.syncPolling) document.querySelectorAll("[data-sync]").forEach((button) => { button.disabled = false; });
    }
  }

  // Queda de rede (sem status) ou erro temporário do servidor não encerram o
  // acompanhamento: a sincronização continua no worker, então tentamos de novo.
  function transientSyncError(error) {
    const status = Number(error?.status) || 0;
    return !status || status === 408 || status === 429 || status >= 500;
  }
  function waitForRetry(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); window.removeEventListener("online", done); resolve(); };
      const timer = setTimeout(done, ms);
      window.addEventListener("online", done, { once: true });
    });
  }

  async function pollSync(accountId) {
    if (state.syncPolling) return;
    state.syncPolling = true;
    let retries = 0;
    try {
      while (true) {
        if (Number(selected()?.id) !== Number(accountId)) return;
        let data;
        try {
          data = await fetchJson(`/magalu/api/catalog/status?account_id=${accountId}`, { loading: "none" });
        } catch (error) {
          if (!transientSyncError(error)) throw error;
          retries += 1;
          const offline = navigator.onLine === false;
          setSyncBanner("queued", offline ? "Sem conexão com a internet" : "Conexão instável",
            "A sincronização continua no servidor. O acompanhamento será retomado automaticamente.");
          await waitForRetry(Math.min(30000, 5000 * retries));
          continue;
        }
        retries = 0;
        state.catalogStatus = data;
        renderStats(data);
        const status = String(data.account?.catalog_sync_status || "idle");
        const [tone, title, copy] = syncStatusDescription(status, data.account?.catalog_last_error, data.latest_run);
        setSyncBanner(tone, title, copy);
        if (!["queued", "running"].includes(status)) {
          if (status === "success") showAlert("Sincronização concluída com sucesso.");
          else if (status === "partial") showAlert(copy, "warning", { sticky: true });
          else if (status === "failed") showAlert(copy, "danger", { sticky: true });
          await Promise.all([loadCatalog(), route() === "/sincronizacao" ? loadSyncCenter() : Promise.resolve()]);
          window.dispatchEvent(new CustomEvent("magalu:catalogsynced", { detail: { accountId, status } }));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } catch (error) {
      showAlert(`Não foi possível acompanhar a sincronização: ${error.message}`, "danger", { sticky: true });
    } finally {
      state.syncPolling = false;
      document.querySelectorAll("[data-sync]").forEach((button) => { button.disabled = false; });
    }
  }

  async function reconcile(sku, button) {
    const account = selected();
    if (!account) return;
    button.disabled = true;
    try {
      await fetchJson(`/magalu/api/catalog/skus/${encodeURIComponent(sku)}/reconcile`, {
        method: "POST", body: JSON.stringify({ account_id: account.id }),
      });
      showAlert(`Reconciliação de ${sku} enfileirada.`);
      setTimeout(() => void loadCatalog(), 1200);
    } catch (error) {
      showAlert(error.message, "danger");
    } finally {
      button.disabled = false;
    }
  }

  async function loadSyncCenter() {
    const account = selected();
    if (!account) {
      setSyncBanner("idle", "Nenhuma conta selecionada", "Vincule uma organização Magalu antes de testar a integração.");
      renderScopes([]);
      renderProbes(null);
      renderRuns([]);
      return;
    }
    try {
      const [status, runs] = await Promise.all([
        fetchJson(`/magalu/api/catalog/status?account_id=${account.id}`),
        fetchJson(`/magalu/api/catalog/runs?account_id=${account.id}&limit=12`),
      ]);
      state.catalogStatus = status;
      renderSyncAccount(status);
      renderRuns(runs.runs || []);
      const syncState = String(status.account?.catalog_sync_status || "idle");
      const [tone, title, copy] = syncStatusDescription(syncState, status.account?.catalog_last_error, status.latest_run);
      setSyncBanner(tone, title, copy);
      renderProbes(state.diagnostics);
    } catch (error) {
      showAlert(error.message, "danger", { sticky: true });
    }
  }

  function renderSyncAccount(data) {
    const account = selected();
    const remote = data?.account || {};
    const reconnect = $("mg-reconnect-account");
    if (reconnect) reconnect.href = account
      ? `/magalu/auth/accounts/${encodeURIComponent(account.id)}/reconnect`
      : "/magalu/auth/start?return=%2Fmagalu%2Fintegracoes";
    $("mg-sync-account").textContent = account ? accountLabel(account) : "—";
    $("mg-sync-account-status").textContent = remote.status || account?.status || "—";
    $("mg-sync-token-expiry").textContent = formatDate(remote.access_expires_at || account?.access_expires_at);
    $("mg-sync-token-refresh").textContent = formatDate(remote.last_refresh_at || account?.last_refresh_at);
    renderScopes(remote.scopes || account?.scopes || []);
  }

  function renderScopes(scopes) {
    const host = $("mg-scope-list");
    if (!host) return;
    const set = new Set(Array.isArray(scopes) ? scopes : []);
    host.innerHTML = REQUIRED_SCOPES.map(([scope, label]) => `<div data-state="${set.has(scope) ? "ok" : "missing"}"><i>${set.has(scope) ? "✓" : "×"}</i><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(scope)}</small></span></div>`).join("");
  }

  function probeTone(probe) {
    if (probe?.ok === true) return "ok";
    if (probe?.ok === false) return "failed";
    return "idle";
  }

  function renderProbes(report) {
    const host = $("mg-probe-list");
    if (!host) return;
    if (!report?.probes) {
      host.innerHTML = '<div class="mg-empty-state"><strong>Nenhum teste executado</strong><p>Clique em “Testar conexão” para consultar os endpoints do Portfólio sem alterar dados.</p></div>';
      return;
    }
    const labels = { sku: "SKUs", price: "Preços", stock: "Estoque", seller: "Perfil do seller" };
    host.innerHTML = Object.entries(labels).map(([key, label]) => {
      const probe = report.probes[key] || {};
      const tone = probeTone(probe);
      const status = probe.status ? `HTTP ${probe.status}` : probe.ok === null ? "não testado" : "—";
      const message = key === "seller" && probe.ok === false
        ? `Consulta auxiliar: ${probe.message || "indisponível"}`
        : (probe.message || (probe.ok ? "Acesso confirmado" : "Aguardando teste"));
      return `<article class="mg-probe" data-state="${tone}"><i>${tone === "ok" ? "✓" : tone === "failed" ? "!" : "·"}</i><div><strong>${escapeHtml(label)}</strong><code>${escapeHtml(probe.endpoint || "—")}</code><small>${escapeHtml(message)}</small>${probe.request_id ? `<em>request-id: ${escapeHtml(probe.request_id)}</em>` : ""}</div><b>${escapeHtml(status)}</b></article>`;
    }).join("");
  }

  async function testConnection() {
    const account = selected();
    if (!account) return showAlert("Selecione uma conta Magalu.", "danger");
    const button = $("mg-test-connection");
    button.disabled = true;
    button.textContent = "Testando...";
    try {
      const data = await fetchJson("/magalu/api/catalog/test", {
        method: "POST",
        body: JSON.stringify({ account_id: account.id }),
      });
      state.diagnostics = data.report;
      renderProbes(state.diagnostics);
      if (data.report.catalog_access_ok) {
        if (data.report.profile_warning) {
          showAlert("Catálogo acessível. O endpoint auxiliar /portfolios/me retornou aviso, mas não bloqueia mais a sincronização.", "warning", { sticky: true });
        } else {
          showAlert("Conexão com o Portfólio Magalu validada.");
        }
      } else {
        const sku = data.report.probes?.sku;
        showAlert(`A API de SKUs não autorizou a conta${sku?.status ? ` (HTTP ${sku.status})` : ""}. Confira tenant, scopes e audience do client.`, "danger", { sticky: true });
      }
    } catch (error) {
      showAlert(error.message, "danger", { sticky: true });
    } finally {
      button.disabled = false;
      button.textContent = "Testar conexão";
    }
  }

  function renderRuns(runs) {
    const host = $("mg-sync-runs");
    if (!host) return;
    host.replaceChildren();
    $("mg-sync-runs-empty").hidden = Boolean(runs.length);
    for (const run of runs) {
      const result = run.result && typeof run.result === "object" ? run.result : {};
      const failedEndpoint = result.failed_endpoint || null;
      const requestId = result.request_id || null;
      const row = document.createElement("article");
      row.className = "mg-run-row";
      row.dataset.status = run.status;
      const detail = run.error_message || (result.discovery_partial_statuses?.length ? `Descoberta parcial em ${result.discovery_partial_statuses.join(", ")}.` : null) || (run.status === "running" ? `Etapa: ${result.stage || "iniciando"}` : null) || "Execução concluída";
      row.innerHTML = `<div class="mg-run-row__status"><i></i><span><strong>${escapeHtml(run.status || "—")}</strong><small>${escapeHtml(formatDate(run.started_at))}</small></span></div><div><span>Itens</span><strong>${escapeHtml(run.scanned_count ?? 0)}</strong></div><div><span>Novos</span><strong>${escapeHtml(run.created_count ?? 0)}</strong></div><div><span>Falhas</span><strong>${escapeHtml(run.failed_count ?? 0)}</strong></div><div class="mg-run-row__detail"><span>Detalhe</span><strong>${escapeHtml(detail)}</strong><small>${escapeHtml(result.known_refreshed ?? 0)} conhecido(s) atualizados · ${escapeHtml(result.known_missing ?? 0)} ausência(s) confirmada(s) · ${escapeHtml(result.pages ?? 0)} página(s)</small>${failedEndpoint ? `<small>${escapeHtml(failedEndpoint)}${result.http_status ? ` · HTTP ${escapeHtml(result.http_status)}` : ""}</small>` : ""}${requestId ? `<small>request-id: ${escapeHtml(requestId)}</small>` : ""}</div>`;
      host.append(row);
    }
  }

  function oauthResult() {
    const params = new URLSearchParams(location.search);
    if (params.get("oauth") === "connected") {
      showAlert("Autorização Magalu concluída. A conta aparecerá após o Hub confirmar o acesso comercial; a sincronização inicial foi enfileirada.", "success", { sticky: true });
    } else if (params.get("oauth") === "error") {
      const reason = params.get("reason") || "oauth_failed";
      const map = {
        magalu_tenant_already_linked: "Esta organização Magalu já pertence a outra empresa DACHBYTE.",
        magalu_oauth_session_required: "Sua sessão DACH expirou antes da conclusão do OAuth.",
        magalu_oauth_identity_mismatch: "A sessão atual não é a mesma que iniciou o OAuth.",
        magalu_oauth_hub_access_revoked: "O Hub revogou o acesso Magalu antes da conclusão da conexão.",
        magalu_reconnect_account_mismatch: "Você autorizou outra organização Magalu. Selecione a mesma conta para reconectar ou use Vincular organização.",
        magalu_reconnect_account_inactive: "A conta foi desvinculada durante a autorização. Use Vincular organização para começar novamente.",
        state_invalid: "Falha na validação do state OAuth.",
        state_expired: "O state OAuth expirou.",
      };
      showAlert(map[reason] || "Não foi possível concluir o OAuth Magalu.", "danger", { sticky: true });
    }
  }

  async function logout() {
    try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); }
    finally { location.href = "/login"; }
  }

  function bindActions() {
    document.querySelectorAll("[data-sync]").forEach((button) => button.addEventListener("click", () => void sync()));
    $("mg-sync-now")?.addEventListener("click", () => void sync());
    $("mg-dashboard-refresh")?.addEventListener("click", () => void loadDashboard({ force: true }));
    document.querySelectorAll("#mg-dashboard-period [data-period]").forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.period === "custom") {
        if ($("mg-dashboard-custom")?.hidden === false) closeDashboardCustom(); else openDashboardCustom();
        return;
      }
      closeDashboardCustom();
      state.dashboardPeriod = button.dataset.period || "7d";
      setDashboardPeriodButtons(state.dashboardPeriod);
      void loadDashboard();
    }));
    $("mg-dashboard-custom-apply")?.addEventListener("click", applyDashboardCustom);
    $("mg-dashboard-custom-cancel")?.addEventListener("click", closeDashboardCustom);
    $("mg-dashboard-custom")?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { closeDashboardCustom(); $("mg-dashboard-custom-toggle")?.focus(); }
      if (event.key === "Enter") { event.preventDefault(); applyDashboardCustom(); }
    });
    document.addEventListener("click", (event) => {
      const panel = $("mg-dashboard-custom");
      if (!panel || panel.hidden) return;
      if (panel.contains(event.target) || event.target.closest?.("#mg-dashboard-custom-toggle")) return;
      closeDashboardCustom();
    });
    $("mg-test-connection")?.addEventListener("click", () => void testConnection());
    $("mg-price-preview-btn")?.addEventListener("click", () => void previewWrite("price"));
    $("mg-stock-preview-btn")?.addEventListener("click", () => void previewWrite("stock"));
    bindWriteSelectionModes();
    $("mg-write-preview-close")?.addEventListener("click", () => { $("mg-write-preview").hidden = true; });
    $("mg-write-confirm")?.addEventListener("change", (event) => {
      $("mg-write-apply-btn").disabled = !(event.target.checked && state.activePreview?.summary?.changed > 0);
    });
    $("mg-write-apply-btn")?.addEventListener("click", () => void applyPreview());
    $("mg-catalog-filter")?.addEventListener("click", () => { state.offset = 0; void loadCatalog(); });
    $("mg-catalog-search")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { state.offset = 0; void loadCatalog(); }
    });
    $("mg-prev")?.addEventListener("click", () => { state.offset = Math.max(0, state.offset - state.limit); void loadCatalog(); });
    $("mg-next")?.addEventListener("click", () => { if (state.offset + state.limit < state.total) { state.offset += state.limit; void loadCatalog(); } });
    $("mg-logout")?.addEventListener("click", () => void logout());
  }

  $("mg-accounts-search")?.addEventListener("input", () => renderAccounts());
  $("mg-accounts-refresh")?.addEventListener("click", () => void loadAccounts());

  window.MagaluSellerShell = Object.freeze({
    getSelectedAccountId: () => state.selectedAccountId,
    getSelectedAccount: () => selected(),
    getAccounts: () => [...state.accounts],
    fetchJson, fetchResponse, showAlert, escapeHtml, formatDate, route,
    isReady: () => document.body?.dataset?.magaluShellReady === "true",
  });

  document.addEventListener("DOMContentLoaded", async () => {
    initShell();
    bindActions();
    oauthResult();
    await Promise.all([loadSession(), loadAccounts()]);
    renderRoute();
    document.body.dataset.magaluShellReady = "true";
    window.dispatchEvent(new CustomEvent("magalu:shellready", { detail: { accountId: state.selectedAccountId } }));
  });
})();
