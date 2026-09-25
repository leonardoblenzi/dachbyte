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
    writeStatus: null,
    catalogStatus: null,
    diagnostics: null,
    activePreview: null,
    syncPolling: false,
  };

  const routes = {
    "/": { title: "Painel", page: "mg-dashboard", group: "overview" },
    "/catalogo": { title: "SKUs", page: "mg-catalog-page", group: "products" },
    "/precos": { title: "Preços", page: "mg-price-page", group: "operations" },
    "/estoque": { title: "Estoque", page: "mg-stock-page", group: "operations" },
    "/contas": { title: "Contas Magalu", page: "mg-accounts-page", group: "account" },
    "/sincronizacao": { title: "Sincronização", page: "mg-sync-page", group: "account" },
  };

  const REQUIRED_SCOPES = [
    ["open:portfolio-skus-seller:read", "SKU · leitura"],
    ["open:portfolio-prices-seller:read", "Preço · leitura"],
    ["open:portfolio-stocks-seller:read", "Estoque · leitura"],
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

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || data.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    return data;
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
    return account?.magalu_tenant_name || account?.magalu_tenant_id || `Conta ${account?.id || ""}`;
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

    if (readJsonStorage(STORAGE_COLLAPSED, false) && window.innerWidth > 900) {
      document.body.classList.add("mg-shell-collapsed");
    }

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

    if (["/", "/catalogo", "/precos", "/estoque"].includes(path)) void loadCatalog();
    if (path === "/sincronizacao") void loadSyncCenter();
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
    state.selectedAccountId = Number(accountId);
    state.offset = 0;
    state.activePreview = null;
    state.diagnostics = null;
    localStorage.setItem(STORAGE_ACCOUNT, String(accountId));
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

  function renderAccounts() {
    const list = $("mg-account-list");
    if (!list) return;
    list.replaceChildren();
    $("mg-accounts-count").textContent = `${state.accounts.length} conta${state.accounts.length === 1 ? "" : "s"}`;
    $("mg-accounts-empty").hidden = state.accounts.length > 0;
    for (const account of state.accounts) {
      const row = document.createElement("article");
      row.className = "mg-account-row";
      if (Number(account.id) === Number(state.selectedAccountId)) row.dataset.selected = "true";
      const scopeSet = new Set(Array.isArray(account.scopes) ? account.scopes : []);
      const writeLabel = scopeSet.has("open:portfolio-prices-seller:write") && scopeSet.has("open:portfolio-stocks-seller:write")
        ? "leitura + escrita"
        : "somente leitura";
      row.innerHTML = `<div class="mg-account-row__identity"><strong>${escapeHtml(accountLabel(account))}</strong><small>${escapeHtml(account.magalu_tenant_id || "")}</small></div><div class="mg-account-row__meta"><span>Conexão</span><strong>${escapeHtml(account.status || "—")}</strong></div><div class="mg-account-row__meta"><span>Permissões</span><strong>${escapeHtml(writeLabel)}</strong></div>`;
      const actions = document.createElement("div");
      actions.className = "mg-account-row__actions";
      const button = document.createElement("button");
      button.className = "mg-secondary-btn";
      button.type = "button";
      button.textContent = Number(account.id) === Number(state.selectedAccountId) ? "Selecionada" : "Selecionar";
      button.disabled = Number(account.id) === Number(state.selectedAccountId);
      button.onclick = () => chooseAccount(account.id);
      actions.append(button);
      row.append(actions);
      list.append(row);
    }
  }

  async function fetchCatalogStatus(account) {
    const status = await fetchJson(`/magalu/api/catalog/status?account_id=${account.id}`);
    state.catalogStatus = status;
    renderStats(status);
    renderDashboard(status);
    return status;
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
      renderDashboard(status);
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
    $("kpi-skus").textContent = stats.sku_count ?? "—";
    $("kpi-prices").textContent = stats.priced_count ?? "—";
    $("kpi-zero").textContent = stats.zero_stock_count ?? "—";
    $("kpi-sync").textContent = data ? formatDate(data.account?.catalog_last_synced_at) : "—";
    $("kpi-sync-status").textContent = data?.account?.catalog_sync_status || "aguardando conta";
  }

  function renderDashboard(data) {
    if (!$("mg-dashboard-account")) return;
    const account = selected();
    const remote = data?.account || {};
    const latest = data?.latest_run || {};
    const scopes = Array.isArray(remote.scopes) ? remote.scopes : (Array.isArray(account?.scopes) ? account.scopes : []);
    const readCount = REQUIRED_SCOPES.slice(0, 3).filter(([scope]) => scopes.includes(scope)).length;

    $("mg-dashboard-account").textContent = account ? accountLabel(account) : "—";
    $("mg-dashboard-account-status").textContent = remote.status || account?.status || "—";
    $("mg-dashboard-account-status").dataset.state = remote.status || account?.status || "idle";
    $("mg-dashboard-token").textContent = remote.access_expires_at ? `válido até ${formatDate(remote.access_expires_at)}` : "—";
    $("mg-dashboard-scopes").textContent = `${readCount}/3 escopos de leitura`;
    $("mg-dashboard-webhooks").textContent = String(data?.webhooks?.active_count ?? 0);

    $("mg-dashboard-sync-status").textContent = remote.catalog_sync_status || latest.status || "—";
    $("mg-dashboard-sync-status").dataset.state = remote.catalog_sync_status || latest.status || "idle";
    $("mg-dashboard-run-start").textContent = formatDate(latest.started_at);
    $("mg-dashboard-run-scanned").textContent = latest.scanned_count ?? "—";
    $("mg-dashboard-run-pages").textContent = latest.result?.pages ?? "—";
    $("mg-dashboard-run-error").textContent = latest.error_message || remote.catalog_last_error || "Nenhuma";
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
      const button = $(`mg-${resource}-preview-btn`);
      if (button) button.disabled = !writeCapability(resource);
    }
  }

  function renderWriteRows(resource) {
    const host = $(`mg-${resource}-write-list`);
    if (!host) return;
    host.replaceChildren();
    const canWrite = writeCapability(resource);
    if (!state.rows.length) {
      host.innerHTML = '<div class="mg-empty-state"><strong>Nenhum SKU disponível</strong><p>Sincronize o catálogo antes de preparar alterações.</p></div>';
      return;
    }
    for (const row of state.rows) {
      const item = document.createElement("div");
      item.className = "mg-write-row";
      item.dataset.sku = row.sku;
      item.dataset.resource = resource;
      if (resource === "price") {
        const currentPrice = Number.isFinite(Number(row.price)) ? Number(row.price) : "";
        const currentList = Number.isFinite(Number(row.list_price)) ? Number(row.list_price) : currentPrice;
        item.innerHTML = `<input class="mg-write-select" type="checkbox" ${canWrite ? "" : "disabled"}><div class="mg-write-product"><strong>${escapeHtml(row.sku)}</strong><span>${escapeHtml(row.title || "—")}</span></div><div class="mg-write-current"><span>Atual</span><strong>${escapeHtml(money(row.price))}</strong></div><label class="mg-write-field"><span>Preço</span><input data-field="price" type="number" min="0.01" step="0.01" value="${escapeHtml(currentPrice)}" ${canWrite ? "" : "disabled"}></label><label class="mg-write-field"><span>Preço de lista</span><input data-field="list_price" type="number" min="0.01" step="0.01" value="${escapeHtml(currentList)}" ${canWrite ? "" : "disabled"}></label>`;
      } else {
        const quantity = Number.isInteger(Number(row.quantity)) ? Number(row.quantity) : 0;
        item.innerHTML = `<input class="mg-write-select" type="checkbox" ${canWrite ? "" : "disabled"}><div class="mg-write-product"><strong>${escapeHtml(row.sku)}</strong><span>${escapeHtml(row.title || "—")}</span></div><div class="mg-write-current"><span>Atual</span><strong>${escapeHtml(row.quantity ?? "—")}</strong></div><label class="mg-write-field"><span>Quantidade absoluta</span><input data-field="quantity" type="number" min="0" step="1" value="${escapeHtml(quantity)}" ${canWrite ? "" : "disabled"}></label>`;
      }
      host.append(item);
    }
  }

  function collectChanges(resource) {
    const changes = [];
    document.querySelectorAll(`.mg-write-row[data-resource="${resource}"]`).forEach((row) => {
      if (!row.querySelector(".mg-write-select")?.checked) return;
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
    $("mg-write-operations-empty").hidden = Boolean((operations || []).length);
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

  function syncStatusDescription(status, error) {
    if (status === "queued") return ["queued", "Sincronização na fila", "Aguardando o worker Magalu iniciar a leitura."];
    if (status === "running") return ["running", "Sincronização em andamento", "SKU, preço e estoque estão sendo atualizados em segundo plano."];
    if (status === "success") return ["success", "Sincronização concluída", "O espelho local está atualizado."];
    if (status === "partial") return ["warning", "Sincronização concluída com avisos", error || "Algumas leituras de detalhe não puderam ser atualizadas."];
    if (status === "failed") return ["failed", "Falha na sincronização", error || "Abra o diagnóstico para identificar o endpoint que falhou."];
    return ["idle", "Aguardando sincronização", "Nenhuma execução ativa para a conta selecionada."];
  }

  async function sync() {
    const account = selected();
    if (!account) return showAlert("Selecione ou conecte uma conta Magalu.", "danger");
    try {
      await fetchJson("/magalu/api/catalog/sync", {
        method: "POST",
        body: JSON.stringify({ account_id: account.id }),
      });
      showAlert("Sincronização enfileirada. Acompanhando a execução...", "success", { sticky: true });
      setSyncBanner("queued", "Sincronização na fila", "Aguardando o worker iniciar.");
      await pollSync(account.id);
    } catch (error) {
      showAlert(error.message, "danger", { sticky: true });
    }
  }

  async function pollSync(accountId) {
    if (state.syncPolling) return;
    state.syncPolling = true;
    try {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (Number(selected()?.id) !== Number(accountId)) return;
        const data = await fetchJson(`/magalu/api/catalog/status?account_id=${accountId}`);
        state.catalogStatus = data;
        renderStats(data);
        renderDashboard(data);
        const status = String(data.account?.catalog_sync_status || "idle");
        const [tone, title, copy] = syncStatusDescription(status, data.account?.catalog_last_error);
        setSyncBanner(tone, title, copy);
        if (!["queued", "running"].includes(status)) {
          if (status === "success") showAlert("Sincronização concluída com sucesso.");
          else if (status === "partial") showAlert(copy, "warning", { sticky: true });
          else if (status === "failed") showAlert(copy, "danger", { sticky: true });
          await Promise.all([loadCatalog(), route() === "/sincronizacao" ? loadSyncCenter() : Promise.resolve()]);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      showAlert("A sincronização continua em segundo plano. Abra Sincronização para acompanhar.", "warning", { sticky: true });
    } catch (error) {
      showAlert(`Não foi possível acompanhar a sincronização: ${error.message}`, "danger", { sticky: true });
    } finally {
      state.syncPolling = false;
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
      const [tone, title, copy] = syncStatusDescription(syncState, status.account?.catalog_last_error);
      setSyncBanner(tone, title, copy);
      renderProbes(state.diagnostics);
    } catch (error) {
      showAlert(error.message, "danger", { sticky: true });
    }
  }

  function renderSyncAccount(data) {
    const account = selected();
    const remote = data?.account || {};
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
      row.innerHTML = `<div class="mg-run-row__status"><i></i><span><strong>${escapeHtml(run.status || "—")}</strong><small>${escapeHtml(formatDate(run.started_at))}</small></span></div><div><span>Itens</span><strong>${escapeHtml(run.scanned_count ?? 0)}</strong></div><div><span>Páginas</span><strong>${escapeHtml(result.pages ?? 0)}</strong></div><div><span>Falhas</span><strong>${escapeHtml(run.failed_count ?? 0)}</strong></div><div class="mg-run-row__detail"><span>Detalhe</span><strong>${escapeHtml(run.error_message || failedEndpoint || "Execução concluída")}</strong>${failedEndpoint ? `<small>${escapeHtml(failedEndpoint)}${result.http_status ? ` · HTTP ${escapeHtml(result.http_status)}` : ""}</small>` : ""}${requestId ? `<small>request-id: ${escapeHtml(requestId)}</small>` : ""}</div>`;
      host.append(row);
    }
  }

  function oauthResult() {
    const params = new URLSearchParams(location.search);
    if (params.get("oauth") === "connected") {
      showAlert("Conta Magalu conectada. A sincronização inicial foi enfileirada.", "success", { sticky: true });
    } else if (params.get("oauth") === "error") {
      const reason = params.get("reason") || "oauth_failed";
      const map = {
        magalu_tenant_already_linked: "Esta organização Magalu já pertence a outra empresa DACHBYTE.",
        magalu_oauth_session_required: "Sua sessão DACH expirou antes da conclusão do OAuth.",
        magalu_oauth_identity_mismatch: "A sessão atual não é a mesma que iniciou o OAuth.",
        magalu_oauth_hub_access_revoked: "O Hub revogou o acesso Magalu antes da conclusão da conexão.",
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
    $("mg-test-connection")?.addEventListener("click", () => void testConnection());
    $("mg-price-preview-btn")?.addEventListener("click", () => void previewWrite("price"));
    $("mg-stock-preview-btn")?.addEventListener("click", () => void previewWrite("stock"));
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

  document.addEventListener("DOMContentLoaded", async () => {
    initShell();
    bindActions();
    oauthResult();
    await Promise.all([loadSession(), loadAccounts()]);
    renderRoute();
  });
})();
