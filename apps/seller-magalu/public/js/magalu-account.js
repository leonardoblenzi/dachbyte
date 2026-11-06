(() => {
  "use strict";

  // Secao Conta da Magalu: Contas vinculadas, Usuarios, Plano e creditos,
  // Integracoes e Ajuda e contato, no mesmo fluxo da secao Conta do Seller.
  const $ = (id) => document.getElementById(id);
  const ACCOUNT_KEY = "dachbyte_magalu_account_id";
  const ROLE_LABELS = { admin: "Administrador", administrador: "Administrador", owner: "Owner", operator: "Operador", operador: "Operador", member: "Membro" };
  const state = { viewer: null, users: [], modules: [], editing: null, unlinkTarget: null, renameTarget: null };

  async function fetchJson(url, options = {}) {
    const client = window.MagaluSellerShell;
    if (!client?.fetchJson) throw new Error("Shell Magalu indisponível.");
    const data = await client.fetchJson(url, options);
    if (data?.ok === false) {
      const error = new Error(data.message || data.error || "A solicitação foi recusada.");
      error.payload = data;
      throw error;
    }
    return data;
  }

  function notify(message, tone = "success") {
    const client = window.MagaluSellerShell;
    if (client?.showAlert) client.showAlert(message, tone);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function currentPath() {
    return location.pathname.replace(/^\/magalu/, "").replace(/\/$/, "") || "/";
  }

  function selectedAccountId() {
    const value = Number(localStorage.getItem(ACCOUNT_KEY) || 0);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function accountApi(path = "") { return `/magalu/api/account${path}`; }

  function dateLabel(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  function roleLabel(role) {
    const key = String(role || "").toLowerCase();
    return ROLE_LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Não informado");
  }

  function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
  }

  // Menu Conta fixo, com os mesmos itens da secao Conta do Seller.
  function ensureStructure() {
    const accountGroup = document.querySelector('.mg-nav__group[data-group="account"]');
    const children = accountGroup?.querySelector(".mg-nav__children");
    const copy = accountGroup?.querySelector(".mg-nav__group-copy small");
    if (copy) copy.textContent = "Conta e acesso";
    if (children && !children.querySelector('[data-nav-path="/usuarios"]')) {
      children.innerHTML = `
        <a href="/magalu/contas" data-nav-path="/contas" class="mg-nav__item">Contas vinculadas</a>
        <a href="/magalu/usuarios" data-nav-path="/usuarios" class="mg-nav__item">Usuários</a>
        <a href="/magalu/plano" data-nav-path="/plano" class="mg-nav__item">Plano e créditos</a>
        <a href="/magalu/integracoes" data-nav-path="/integracoes" class="mg-nav__item">Integrações</a>
        <a href="/magalu/ajuda" data-nav-path="/ajuda" class="mg-nav__item">Ajuda e contato</a>`;
    }
  }

  // Esconde do menu as telas que o usuario nao pode abrir (o servidor bloqueia
  // do mesmo jeito; aqui so evitamos um clique que volta ao painel).
  function applyNavPermissions(viewer) {
    const pages = viewer?.pages || {};
    document.querySelectorAll(".mg-nav__item[data-nav-path]").forEach((link) => {
      const path = link.dataset.navPath;
      if (Object.prototype.hasOwnProperty.call(pages, path)) link.hidden = pages[path] === false;
    });
    document.querySelectorAll(".mg-nav__group").forEach((group) => {
      const items = [...group.querySelectorAll(".mg-nav__item")];
      if (items.length) group.hidden = items.every((item) => item.hidden);
    });
  }

  async function loadContext() {
    const id = selectedAccountId();
    const data = await fetchJson(accountApi(`/context${id ? `?account_id=${id}` : ""}`));
    state.viewer = data.viewer || null;
    applyNavPermissions(state.viewer);
    return data;
  }

  // ---------- Usuarios ----------
  function moduleCount(user) {
    const total = state.modules.length || 0;
    const allowed = user.modules.filter((item) => item.can_access).length;
    const editable = user.modules.filter((item) => item.can_edit).length;
    return { total, allowed, editable };
  }

  function accessSummary(user) {
    if (user.is_admin) return '<span class="mg-acct-pill mg-acct-pill--admin">Acesso completo · administrador</span>';
    if (user.access_mode === "full") return '<span class="mg-acct-pill mg-acct-pill--ok">Acesso completo</span>';
    const { total, allowed, editable } = moduleCount(user);
    if (!allowed) return '<span class="mg-acct-pill mg-acct-pill--danger">Sem módulos</span>';
    return `<span class="mg-acct-pill mg-acct-pill--muted">${allowed} de ${total} módulos</span><small class="mg-acct-sub">${editable ? `${editable} com edição` : "somente leitura"}</small>`;
  }

  function renderUsers() {
    const body = $("mg-users-body");
    if (!body) return;
    const users = state.users;
    setText("mg-users-stat-total", String(users.length));
    setText("mg-users-stat-admin", String(users.filter((user) => user.is_admin).length));
    setText("mg-users-stat-full", String(users.filter((user) => !user.is_admin && user.access_mode === "full").length));
    setText("mg-users-stat-restricted", String(users.filter((user) => user.access_mode === "restricted").length));

    const term = String($("mg-users-search")?.value || "").trim().toLowerCase();
    const visible = term ? users.filter((user) => `${user.name} ${user.email}`.toLowerCase().includes(term)) : users;
    if (!visible.length) {
      body.innerHTML = `<tr><td colspan="5" class="mg-acct-empty">${users.length ? "Nenhum usuário encontrado para esta busca." : "Nenhum usuário acessou o módulo ainda."}</td></tr>`;
      return;
    }
    body.innerHTML = visible.map((user) => `
      <tr>
        <td><div class="mg-acct-user"><strong>${escapeHtml(user.name)}</strong><span>${escapeHtml(user.email)}</span></div></td>
        <td><span class="mg-acct-pill ${user.is_admin ? "mg-acct-pill--admin" : "mg-acct-pill--muted"}">${escapeHtml(roleLabel(user.company_role))}</span></td>
        <td><div class="mg-acct-access">${accessSummary(user)}</div></td>
        <td>${escapeHtml(dateLabel(user.last_seen_at))}</td>
        <td>${user.is_admin
          ? '<span class="mg-acct-sub">Gerenciado no Hub</span>'
          : `<button class="mg-secondary-btn" type="button" data-user-edit="${escapeHtml(user.user_id)}">Editar acessos</button>`}</td>
      </tr>`).join("");
  }

  async function loadUsers() {
    const body = $("mg-users-body");
    if (body) body.innerHTML = '<tr><td colspan="5" class="mg-acct-empty">Carregando usuários...</td></tr>';
    try {
      const data = await fetchJson(accountApi("/users"));
      state.users = Array.isArray(data.users) ? data.users : [];
      state.modules = Array.isArray(data.modules) ? data.modules : [];
      renderUsers();
    } catch (error) {
      if (body) body.innerHTML = `<tr><td colspan="5" class="mg-acct-empty">${escapeHtml(error.message || "Não foi possível carregar os usuários.")}</td></tr>`;
    }
  }

  function groupedModules() {
    const groups = new Map();
    for (const item of state.modules) {
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push(item);
    }
    return groups;
  }

  function renderAccessModules(user, fullAccess) {
    const host = $("mg-access-modules");
    if (!host) return;
    const rows = new Map(user.modules.map((item) => [item.module_key, item]));
    const restricted = user.access_mode === "restricted";
    host.innerHTML = [...groupedModules()].map(([group, items]) => `
      <section class="mg-access-group">
        <h4>${escapeHtml(group)}</h4>
        ${items.map((item) => {
          const row = rows.get(item.key);
          const canAccess = restricted ? row?.can_access === true : true;
          const canEdit = restricted ? row?.can_edit === true : true;
          return `
          <div class="mg-access-module" data-module-key="${escapeHtml(item.key)}">
            <div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.path)}</small></div>
            <label class="mg-access-toggle"><input type="checkbox" data-module-access ${canAccess ? "checked" : ""} ${fullAccess ? "disabled" : ""}> Acessar</label>
            <label class="mg-access-toggle"><input type="checkbox" data-module-edit ${canEdit ? "checked" : ""} ${fullAccess || !canAccess ? "disabled" : ""}> Editar</label>
          </div>`;
        }).join("")}
      </section>`).join("");
  }

  function openAccess(userId) {
    const user = state.users.find((item) => item.user_id === userId);
    if (!user || user.is_admin) return;
    state.editing = user;
    setText("mg-access-title", user.name);
    setText("mg-access-subtitle", `${user.email} · último acesso ${dateLabel(user.last_seen_at)}`);
    setText("mg-access-role", roleLabel(user.company_role));
    const full = $("mg-access-full");
    full.checked = user.access_mode === "full";
    renderAccessModules(user, full.checked);
    $("mg-user-access-modal").hidden = false;
  }

  function closeAccess() {
    state.editing = null;
    $("mg-user-access-modal").hidden = true;
  }

  function collectAccessPayload() {
    if ($("mg-access-full")?.checked) return { full_access: true };
    const modules = [...document.querySelectorAll("#mg-access-modules [data-module-key]")].map((row) => {
      const canAccess = row.querySelector("[data-module-access]")?.checked === true;
      return {
        module_key: row.dataset.moduleKey,
        can_access: canAccess,
        can_edit: canAccess && row.querySelector("[data-module-edit]")?.checked === true,
      };
    });
    return { full_access: false, modules };
  }

  async function saveAccess() {
    const user = state.editing;
    if (!user) return;
    const button = $("mg-access-save");
    button.disabled = true;
    try {
      await fetchJson(accountApi(`/users/${encodeURIComponent(user.user_id)}/access`), {
        method: "PUT",
        body: JSON.stringify(collectAccessPayload()),
      });
      closeAccess();
      notify(`Acessos de ${user.name} atualizados.`);
      await loadUsers();
    } catch (error) {
      notify(error.message || "Não foi possível salvar os acessos.", "danger");
    } finally {
      button.disabled = false;
    }
  }

  // ---------- Plano e creditos ----------
  function renderPlan(data) {
    const subscription = data.subscription || {};
    const access = data.access || {};
    const hubActive = access.allow === true && String(access.status || "").toLowerCase() === "active";
    setText("mg-plan-status", subscription.active || hubActive ? "Ativo" : (subscription.status || access.status || "Não informado"));
    setText("mg-plan-name", subscription.plan_name || subscription.plan_code || access.plan_code || "Não informado pelo Hub");
    setText("mg-plan-code", subscription.plan_code || "—");
    setText("mg-plan-cycle", subscription.cycle || "—");
    setText("mg-plan-expiry", subscription.expires_at ? dateLabel(subscription.expires_at) : "—");
    const renew = $("mg-plan-renew");
    if (renew) {
      renew.hidden = !subscription.renewal_url;
      if (subscription.renewal_url) renew.href = subscription.renewal_url;
    }
    const balance = Number(data.credits?.balance);
    const hasBalance = data.credits?.balance != null && Number.isFinite(balance);
    setText("mg-credit-balance", hasBalance ? balance.toLocaleString("pt-BR") : "—");
    setText("mg-credit-note", hasBalance ? "Saldo informado pelo Hub para o módulo Magalu." : "O Hub ainda não informou uma carteira de créditos para o módulo Magalu.");
    setText("mg-billing-mode", access.billing_mode || "—");
    setText("mg-usage-policy", access.usage_policy || "—");
    setText("mg-resource-status", access.resource_status || access.status || "—");
  }

  // ---------- Ajuda ----------
  function renderHelp(data) {
    setText("mg-help-user", `${data.user?.name || "Usuário"} · ${data.user?.email || "—"}`);
    setText("mg-help-account", data.selected_account?.magalu_tenant_name || data.selected_account?.magalu_tenant_id || "Nenhuma conta selecionada");
    setText("mg-help-page-path", location.pathname);
  }

  async function submitHelp(event) {
    event.preventDefault();
    const submit = $("mg-help-submit");
    const feedback = $("mg-help-feedback");
    const reply = document.querySelector('input[name="mg_reply"]:checked')?.value || "email";
    submit.disabled = true;
    feedback.textContent = "Enviando...";
    feedback.dataset.state = "pending";
    try {
      const data = await fetchJson(accountApi("/help"), {
        method: "POST",
        body: JSON.stringify({
          topic: $("mg-help-topic").value,
          message: $("mg-help-message").value,
          reply_preference: reply,
          cellphone: $("mg-help-phone").value,
          account_id: selectedAccountId(),
          page_path: location.pathname,
        }),
      });
      feedback.textContent = data.message || "Mensagem enviada.";
      feedback.dataset.state = "success";
      $("mg-help-message").value = "";
    } catch (error) {
      feedback.textContent = error.message || "Não foi possível enviar.";
      feedback.dataset.state = "error";
    } finally { submit.disabled = false; }
  }

  // ---------- Renomear ----------
  function openRename(accountId, currentLabel) {
    state.renameTarget = Number(accountId);
    const input = $("mg-rename-input");
    input.value = currentLabel || "";
    $("mg-rename-error").hidden = true;
    $("mg-rename-submit").disabled = false;
    $("mg-rename-dialog").hidden = false;
    input.focus();
    input.select();
  }

  function closeRename() {
    state.renameTarget = null;
    $("mg-rename-dialog").hidden = true;
  }

  async function submitRename() {
    if (!state.renameTarget) return;
    const label = String($("mg-rename-input")?.value || "").trim().replace(/\s+/g, " ");
    const error = $("mg-rename-error");
    if (label.length < 2) {
      error.textContent = "Informe um nome com pelo menos 2 caracteres.";
      error.hidden = false;
      return;
    }
    const button = $("mg-rename-submit");
    button.disabled = true;
    try {
      const result = await fetchJson(accountApi(`/accounts/${state.renameTarget}/name`), {
        method: "PUT",
        body: JSON.stringify({ label }),
      });
      closeRename();
      try { sessionStorage.removeItem("magalu:dashboard:cache:v1"); } catch (_error) {}
      location.href = result.hub_rename?.ok === false ? "/magalu/contas?renamed=partial" : "/magalu/contas?renamed=1";
    } catch (failure) {
      error.textContent = failure.message || "Não foi possível renomear a conta.";
      error.hidden = false;
      button.disabled = false;
    }
  }

  // ---------- Desvincular ----------
  function openUnlink(accountId) {
    state.unlinkTarget = Number(accountId);
    $("mg-unlink-reason").value = "";
    $("mg-unlink-confirm").checked = false;
    $("mg-unlink-submit").disabled = true;
    $("mg-unlink-dialog").hidden = false;
  }

  function closeUnlink() {
    state.unlinkTarget = null;
    $("mg-unlink-dialog").hidden = true;
  }

  async function submitUnlink() {
    if (!state.unlinkTarget || !$("mg-unlink-confirm")?.checked) return;
    const button = $("mg-unlink-submit");
    button.disabled = true;
    button.textContent = "Desvinculando...";
    try {
      const result = await fetchJson(accountApi(`/accounts/${state.unlinkTarget}/unlink`), {
        method: "POST",
        body: JSON.stringify({ reason: $("mg-unlink-reason")?.value || "" }),
      });
      if (result.replacement_account_id) localStorage.setItem(ACCOUNT_KEY, String(result.replacement_account_id));
      else localStorage.removeItem(ACCOUNT_KEY);
      closeUnlink();
      if (result.hub_unlink?.ok === false) {
        notify("A conexão foi removida e os tokens apagados, mas o Hub não confirmou a desvinculação. O evento foi registrado para correção.", "warning");
      }
      location.href = "/magalu/contas?unlinked=1";
    } catch (error) {
      const blockers = Array.isArray(error.payload?.blockers) ? error.payload.blockers : [];
      const detail = blockers.length ? ` Operações pendentes: ${blockers.map((item) => `#${item.id} ${item.resource_type}/${item.sku} (${item.status})`).join(", ")}.` : "";
      notify(`${error.message}${detail}`, "danger");
      button.disabled = false;
    } finally {
      button.textContent = "Desvincular conta";
    }
  }

  async function renderAccountPages() {
    const path = currentPath();
    try {
      const data = await loadContext();
      if (path === "/plano") renderPlan(data);
      if (path === "/ajuda") renderHelp(data);
      if (path === "/usuarios") await loadUsers();
    } catch (error) {
      console.warn("[magalu-account] context", error);
    }
  }

  function bind() {
    const list = $("mg-account-list");
    list?.addEventListener("click", (event) => {
      const test = event.target.closest("[data-account-test]");
      if (test) {
        localStorage.setItem(ACCOUNT_KEY, test.dataset.accountTest);
        location.href = "/magalu/integracoes?test=1";
        return;
      }
      const rename = event.target.closest("[data-account-rename]");
      if (rename) { openRename(rename.dataset.accountRename, rename.dataset.accountLabel); return; }
      const unlink = event.target.closest("[data-account-unlink]");
      if (unlink) openUnlink(unlink.dataset.accountUnlink);
    });

    $("mg-users-search")?.addEventListener("input", renderUsers);
    $("mg-users-refresh")?.addEventListener("click", () => void loadUsers());
    $("mg-users-body")?.addEventListener("click", (event) => {
      const edit = event.target.closest("[data-user-edit]");
      if (edit) openAccess(edit.dataset.userEdit);
    });
    $("mg-access-full")?.addEventListener("change", (event) => {
      if (!state.editing) return;
      // Ao restringir quem tinha acesso completo, comeca com tudo marcado
      // (o acesso atual) e o admin so desmarca o que quer tirar.
      const base = state.editing.access_mode === "restricted" ? state.editing : { ...state.editing, access_mode: "full" };
      renderAccessModules(base, event.target.checked);
    });
    $("mg-access-modules")?.addEventListener("change", (event) => {
      if (!event.target.matches("[data-module-access]")) return;
      const edit = event.target.closest("[data-module-key]")?.querySelector("[data-module-edit]");
      if (!edit) return;
      edit.disabled = !event.target.checked;
      if (!event.target.checked) edit.checked = false;
    });
    document.querySelectorAll("[data-access-close]").forEach((button) => button.addEventListener("click", closeAccess));
    $("mg-access-save")?.addEventListener("click", () => void saveAccess());

    $("mg-unlink-confirm")?.addEventListener("change", (event) => { $("mg-unlink-submit").disabled = !event.target.checked; });
    $("mg-unlink-submit")?.addEventListener("click", () => void submitUnlink());
    document.querySelectorAll("[data-unlink-close]").forEach((button) => button.addEventListener("click", closeUnlink));
    $("mg-rename-submit")?.addEventListener("click", () => void submitRename());
    $("mg-rename-input")?.addEventListener("keydown", (event) => { if (event.key === "Enter") void submitRename(); });
    document.querySelectorAll("[data-rename-close]").forEach((button) => button.addEventListener("click", closeRename));

    $("mg-plan-refresh")?.addEventListener("click", () => void renderAccountPages());
    $("mg-help-form")?.addEventListener("submit", (event) => void submitHelp(event));
    document.querySelectorAll('input[name="mg_reply"]').forEach((input) => input.addEventListener("change", () => {
      const mobile = document.querySelector('input[name="mg_reply"]:checked')?.value === "cellphone";
      $("mg-help-phone-row").hidden = !mobile;
      $("mg-help-phone").required = mobile;
    }));
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!$("mg-user-access-modal")?.hidden) closeAccess();
      if (!$("mg-unlink-dialog")?.hidden) closeUnlink();
      if (!$("mg-rename-dialog")?.hidden) closeRename();
    });
    if (location.pathname === "/magalu/integracoes" && new URLSearchParams(location.search).get("test") === "1") {
      setTimeout(() => $("mg-test-connection")?.click(), 500);
    }
  }

  ensureStructure();
  document.addEventListener("DOMContentLoaded", () => {
    bind();
    void renderAccountPages();
    const params = new URLSearchParams(location.search);
    if (params.get("unlinked") === "1") notify("Conta Magalu desvinculada. Você já pode conectar a organização correta.");
    if (params.get("renamed") === "1") notify("Nome da conta atualizado.");
    if (params.get("renamed") === "partial") notify("Nome atualizado no módulo. O portal ainda não confirmou a mudança; tente renomear de novo mais tarde.", "warning");
    if (params.get("acesso") === "negado") notify("Você não tem permissão para abrir essa tela. Fale com o administrador da empresa.", "warning");
  });
})();
