(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    accounts: [],
    selectedAccountId: Number(localStorage.getItem("dachbyte_magalu_account_id") || 0) || null,
    offset: 0,
    limit: 50,
    total: 0,
    rows: [],
    writeStatus: null,
    activePreview: null,
  };
  const routes = {
    "/": ["Painel","mg-dashboard"],
    "/catalogo": ["SKUs","mg-catalog-page"],
    "/precos": ["Preços","mg-price-page"],
    "/estoque": ["Estoque","mg-stock-page"],
    "/contas": ["Contas Magalu","mg-accounts-page"],
  };
  const route = () => {
    const p = location.pathname.replace(/^\/magalu/, "").replace(/\/$/, "") || "/";
    return routes[p] ? p : "/";
  };

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
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

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
  }
  function money(value) {
    const number = Number(value);
    return Number.isFinite(number) ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(number) : "—";
  }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
  }
  function accountLabel(account) { return account?.magalu_tenant_name || account?.magalu_tenant_id || `Conta ${account?.id || ""}`; }
  function selected() { return state.accounts.find((account) => Number(account.id) === Number(state.selectedAccountId)) || null; }
  function showAlert(message, tone = "success") {
    const element = $("mg-oauth-alert");
    if (!element) return;
    element.hidden = false;
    element.dataset.tone = tone;
    element.textContent = message;
  }

  function updateAccountSidebar() {
    const account = selected();
    $("mg-account-name").textContent = account ? accountLabel(account) : "Nenhuma conta conectada";
    $("mg-account-meta").textContent = account
      ? (account.status === "active" ? `Sync: ${account.catalog_sync_status || "idle"}` : `Status: ${account.status}`)
      : "Conecte uma organização pelo ID Magalu";
    document.querySelector(".mg-status-dot")?.setAttribute("data-state", account?.status === "active" ? "active" : "pending");
  }

  function renderRoute() {
    const path = route();
    document.querySelectorAll("[data-page]").forEach((element) => { element.hidden = element.dataset.page !== path; });
    document.querySelectorAll("[data-nav-path]").forEach((element) => element.classList.toggle("is-active", element.dataset.navPath === path));
    $("mg-page-title").textContent = routes[path][0];
    if (["/", "/catalogo", "/precos", "/estoque"].includes(path)) void loadCatalog();
  }

  async function loadSession() {
    try {
      const data = await fetchJson("/magalu/api/session");
      $("mg-user-name").textContent = data.user?.name || "Usuário";
      $("mg-user-email").textContent = data.user?.email || "DACHBYTE";
    } catch (error) { console.warn(error); }
  }

  async function loadAccounts() {
    try {
      const data = await fetchJson("/magalu/api/oauth/status");
      state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
      if (!selected() && state.accounts.length) state.selectedAccountId = Number(state.accounts[0].id);
      if (state.selectedAccountId) localStorage.setItem("dachbyte_magalu_account_id", String(state.selectedAccountId));
      updateAccountSidebar();
      renderAccounts();
    } catch (error) { console.warn(error); }
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
      const writeLabel = scopeSet.has("open:portfolio-prices-seller:write") && scopeSet.has("open:portfolio-stocks-seller:write") ? "preço + estoque" : "somente leitura";
      row.innerHTML = `<div class="mg-account-row__identity"><strong>${escapeHtml(accountLabel(account))}</strong><small>${escapeHtml(account.magalu_tenant_id || "")}</small></div><div class="mg-account-row__meta"><span>Conexão</span><strong>${escapeHtml(account.status || "—")}</strong></div><div class="mg-account-row__meta"><span>Permissões</span><strong>${escapeHtml(writeLabel)}</strong></div>`;
      const actions = document.createElement("div");
      actions.className = "mg-account-row__actions";
      const button = document.createElement("button");
      button.className = "mg-secondary-btn";
      button.textContent = Number(account.id) === Number(state.selectedAccountId) ? "Selecionada" : "Selecionar";
      button.disabled = Number(account.id) === Number(state.selectedAccountId);
      button.onclick = () => {
        state.selectedAccountId = Number(account.id);
        state.offset = 0;
        state.activePreview = null;
        localStorage.setItem("dachbyte_magalu_account_id", String(account.id));
        updateAccountSidebar();
        renderAccounts();
        void loadCatalog();
      };
      actions.append(button);
      row.append(actions);
      list.append(row);
    }
  }

  async function loadCatalog() {
    const account = selected();
    if (!account) { renderStats(null); renderWriteReadiness(); return; }
    try {
      const [status, list, writeStatus] = await Promise.all([
        fetchJson(`/magalu/api/catalog/status?account_id=${account.id}`),
        fetchJson(`/magalu/api/catalog/skus?account_id=${account.id}&offset=${state.offset}&limit=${state.limit}`),
        fetchJson(`/magalu/api/writes/status?account_id=${account.id}&limit=15`).catch((error) => ({ ok:false, enabled:false, error:error.message, scopes:{} })),
      ]);
      state.rows = list.rows || [];
      state.total = Number(list.total || 0);
      state.writeStatus = writeStatus;
      renderStats(status);
      renderCatalog();
      renderWriteReadiness();
      renderOperations(writeStatus.operations || []);
    } catch (error) { console.warn(error); }
  }

  function renderStats(data) {
    const stats = data?.stats || {};
    $("kpi-skus").textContent = stats.sku_count ?? "—";
    $("kpi-prices").textContent = stats.priced_count ?? "—";
    $("kpi-zero").textContent = stats.zero_stock_count ?? "—";
    $("kpi-sync").textContent = data ? formatDate(data.account?.catalog_last_synced_at) : "—";
    $("kpi-sync-status").textContent = data?.account?.catalog_sync_status || "aguardando conta";
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
        button.textContent = "Reconciliar";
        button.onclick = () => void reconcile(row.sku, button);
        td.append(button);
        tr.append(td);
        body.append(tr);
      }
    }
    const meta = $("mg-page-meta");
    if (meta) meta.textContent = state.total ? `${state.total} itens · ${state.offset + 1}-${Math.min(state.offset + state.limit, state.total)}` : "0 itens";
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
    for (const resource of ["price","stock"]) {
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
          ? "Ative MAGALU_WRITE_ENABLED somente após liberar os scopes no IDM."
          : available
            ? "Preview ao vivo + confirmação + fila + verificação pós-202."
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
    for (const row of state.rows) {
      const item = document.createElement("label");
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
      const preview = await fetchJson("/magalu/api/writes/preview", { method:"POST", body:JSON.stringify({ account_id:account.id, resource, changes }) });
      state.activePreview = preview;
      renderPreview(preview);
      showAlert(`Preview pronto: ${preview.summary.changed} alteração(ões), ${preview.summary.noop} sem mudança, ${preview.summary.invalid} inválida(s).`);
    } catch (error) { showAlert(error.message, "danger"); }
    finally { button.disabled = !writeCapability(resource); }
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
      const before = preview.resource === "price" ? `${money(row.before?.price)} / lista ${money(row.before?.list_price)}` : String(row.before?.quantity ?? "sem registro");
      const after = preview.resource === "price" ? `${money(row.requested?.price)} / lista ${money(row.requested?.list_price)}` : String(row.requested?.quantity ?? "—");
      const status = !row.valid ? `Erro: ${row.error || row.error_code}` : !row.changed ? "Sem alteração" : `${row.method} pendente`;
      tr.innerHTML = `<td><code>${escapeHtml(row.sku)}</code></td><td>${escapeHtml(before)}</td><td>${escapeHtml(after)}</td><td>${escapeHtml(status)}</td>`;
      if (!row.valid) tr.dataset.tone = "danger";
      else if (!row.changed) tr.dataset.tone = "muted";
      body.append(tr);
    }
    const apply = $("mg-write-apply-btn");
    apply.disabled = !(preview.summary?.changed > 0);
    panel.scrollIntoView({ behavior:"smooth", block:"nearest" });
  }

  async function applyPreview() {
    const preview = state.activePreview;
    if (!preview?.preview_id) return showAlert("Gere um preview antes de confirmar.", "danger");
    const confirmBox = $("mg-write-confirm");
    if (!confirmBox?.checked) return showAlert("Marque a confirmação antes de aplicar as alterações.", "danger");
    const button = $("mg-write-apply-btn");
    button.disabled = true;
    try {
      const result = await fetchJson("/magalu/api/writes/apply", { method:"POST", body:JSON.stringify({ preview_id:preview.preview_id }) });
      showAlert(`${result.operations.length} operação(ões) enviada(s) à fila protegida. A escrita não será reenviada automaticamente em caso de resposta incerta.`);
      state.activePreview = null;
      confirmBox.checked = false;
      $("mg-write-preview").hidden = true;
      setTimeout(() => void loadCatalog(), 1800);
    } catch (error) { showAlert(error.message, "danger"); }
    finally { button.disabled = false; }
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
      if (["dispatching","accepted","divergent","uncertain"].includes(String(operation.status))) {
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
      const result = await fetchJson(`/magalu/api/writes/operations/${encodeURIComponent(operationId)}/reverify`, { method:"POST", body:JSON.stringify({}) });
      showAlert(`Reverificação enfileirada em modo somente leitura para a operação ${result.operation_id}. Nenhuma nova escrita será enviada.`);
      setTimeout(() => void loadCatalog(), 1600);
    } catch (error) { showAlert(error.message, "danger"); }
    finally { button.disabled = false; }
  }

  async function sync() {
    const account = selected();
    if (!account) return showAlert("Selecione ou conecte uma conta Magalu.", "danger");
    try {
      await fetchJson("/magalu/api/catalog/sync", { method:"POST", body:JSON.stringify({ account_id:account.id }) });
      showAlert("Sincronização enfileirada. SKU, preço e estoque serão atualizados em segundo plano.");
      setTimeout(() => void loadCatalog(), 1800);
    } catch (error) { showAlert(error.message, "danger"); }
  }

  async function reconcile(sku, button) {
    const account = selected();
    if (!account) return;
    button.disabled = true;
    try {
      await fetchJson(`/magalu/api/catalog/skus/${encodeURIComponent(sku)}/reconcile`, { method:"POST", body:JSON.stringify({ account_id:account.id }) });
      showAlert(`Reconciliação de ${sku} enfileirada.`);
      setTimeout(() => void loadCatalog(), 1200);
    } catch (error) { showAlert(error.message, "danger"); }
    finally { button.disabled = false; }
  }

  function oauthResult() {
    const params = new URLSearchParams(location.search);
    if (params.get("oauth") === "connected") showAlert("Conta Magalu conectada. A primeira sincronização de catálogo foi enfileirada.");
    else if (params.get("oauth") === "error") {
      const reason = params.get("reason") || "oauth_failed";
      const map = {
        magalu_tenant_already_linked:"Esta organização Magalu já pertence a outra empresa DACHBYTE.",
        magalu_oauth_session_required:"Sua sessão DACH expirou antes da conclusão do OAuth.",
        magalu_oauth_identity_mismatch:"A sessão atual não é a mesma que iniciou o OAuth.",
        magalu_oauth_hub_access_revoked:"O Hub revogou o acesso Magalu antes da conclusão da conexão.",
        state_invalid:"Falha na validação do state OAuth.",
        state_expired:"O state OAuth expirou.",
      };
      showAlert(map[reason] || "Não foi possível concluir o OAuth Magalu.", "danger");
    }
  }

  async function logout() {
    try { await fetch("/api/auth/logout", { method:"POST", credentials:"include" }); }
    finally { location.href = "/login"; }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const app = document.querySelector(".mg-app");
    const theme = localStorage.getItem("dachbyte_magalu_theme") || "light";
    app.dataset.theme = theme;
    $("mg-theme-toggle")?.addEventListener("click", () => {
      app.dataset.theme = app.dataset.theme === "dark" ? "light" : "dark";
      localStorage.setItem("dachbyte_magalu_theme", app.dataset.theme);
    });
    $("mg-menu-toggle")?.addEventListener("click", () => $("mg-sidebar")?.classList.toggle("is-open"));
    $("mg-logout")?.addEventListener("click", logout);
    $("mg-sync-now")?.addEventListener("click", sync);
    document.querySelectorAll("[data-sync]").forEach((button) => button.addEventListener("click", sync));
    $("mg-catalog-filter")?.addEventListener("click", async () => {
      const account = selected();
      if (!account) return;
      state.offset = 0;
      const q = encodeURIComponent($("mg-catalog-search").value || "");
      const status = encodeURIComponent($("mg-catalog-status").value || "");
      const data = await fetchJson(`/magalu/api/catalog/skus?account_id=${account.id}&q=${q}&status=${status}&offset=0&limit=${state.limit}`);
      state.rows = data.rows || [];
      state.total = Number(data.total || 0);
      renderCatalog();
    });
    $("mg-prev")?.addEventListener("click", () => { state.offset = Math.max(0, state.offset - state.limit); void loadCatalog(); });
    $("mg-next")?.addEventListener("click", () => { state.offset += state.limit; void loadCatalog(); });
    $("mg-price-preview-btn")?.addEventListener("click", () => void previewWrite("price"));
    $("mg-stock-preview-btn")?.addEventListener("click", () => void previewWrite("stock"));
    $("mg-write-apply-btn")?.addEventListener("click", () => void applyPreview());
    $("mg-write-preview-close")?.addEventListener("click", () => { state.activePreview = null; $("mg-write-preview").hidden = true; });
    renderRoute();
    oauthResult();
    void loadSession();
    void loadAccounts();
  });
})();
