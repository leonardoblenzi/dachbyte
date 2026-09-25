(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const ACCOUNT_KEY = "dachbyte_magalu_account_id";
  let unlinkTarget = null;

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

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function selectedAccountId() {
    const value = Number(localStorage.getItem(ACCOUNT_KEY) || 0);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function accountApi(path = "") { return `/magalu/api/account${path}`; }

  function ensureStructure() {
    const accountGroup = document.querySelector('.mg-nav__group[data-group="account"]');
    const children = accountGroup?.querySelector(".mg-nav__children");
    const copy = accountGroup?.querySelector(".mg-nav__group-copy small");
    if (copy) copy.textContent = "Conta e acesso";
    if (children) {
      children.innerHTML = `
        <a href="/magalu/contas" data-nav-path="/contas" class="mg-nav__item">Contas vinculadas</a>
        <a href="/magalu/usuarios" data-nav-path="/usuarios" class="mg-nav__item">Usuários</a>
        <a href="/magalu/plano" data-nav-path="/plano" class="mg-nav__item">Plano e créditos</a>
        <a href="/magalu/integracoes" data-nav-path="/integracoes" class="mg-nav__item">Integrações</a>
        <a href="/magalu/ajuda" data-nav-path="/ajuda" class="mg-nav__item">Ajuda e contato</a>`;
    }

    const sync = $("mg-sync-page");
    if (sync) {
      sync.dataset.page = "/integracoes";
      const title = sync.querySelector("h1");
      const kicker = sync.querySelector(".mg-kicker");
      const intro = sync.querySelector(".mg-page-head p");
      if (title) title.textContent = "Integrações";
      if (kicker) kicker.textContent = "Conta · integração";
      if (intro) intro.textContent = "Acompanhe OAuth, permissões, API do Portfólio, sincronizações e diagnóstico da conta selecionada.";
    }

    const accountsTitle = $("mg-accounts-page")?.querySelector("h1");
    if (accountsTitle) accountsTitle.textContent = "Contas vinculadas";

    const content = document.querySelector(".mg-content");
    if (!content || $("mg-users-page")) return;
    content.insertAdjacentHTML("beforeend", `
      <section id="mg-users-page" data-page="/usuarios" hidden>
        <section class="mg-page-head"><div><span class="mg-kicker">Conta · acesso</span><h1>Usuários</h1><p>O Magalu usa a identidade central do Hub DACHBYTE e não mantém usuários locais.</p></div></section>
        <section class="mg-account-grid">
          <article class="mg-section-card"><div class="mg-section-head"><div><span class="mg-kicker">Sessão atual</span><h2>Usuário conectado</h2></div><span class="mg-pill" id="mg-user-access-state">—</span></div><dl class="mg-facts"><div><dt>Nome</dt><dd id="mg-account-user-name">—</dd></div><div><dt>Email</dt><dd id="mg-account-user-email">—</dd></div><div><dt>ID global</dt><dd id="mg-account-user-id">—</dd></div><div><dt>Tenant DACH</dt><dd id="mg-account-tenant-id">—</dd></div></dl></article>
          <article class="mg-section-card"><div class="mg-section-head"><div><span class="mg-kicker">Fonte de verdade</span><h2>Hub DACHBYTE</h2></div></div><div class="mg-info-callout"><strong>Gestão centralizada</strong><p>Convites, papéis e permissões pertencem ao Hub. O módulo Magalu apenas consome a identidade e o entitlement <code>magalu</code>; nenhuma cópia local de usuários é criada.</p></div><a class="mg-secondary-btn" href="/selecao-plataforma">Voltar ao Hub</a></article>
        </section>
      </section>

      <section id="mg-plan-page" data-page="/plano" hidden>
        <section class="mg-page-head"><div><span class="mg-kicker">Conta · cobrança</span><h1>Plano e créditos</h1><p>Informações de assinatura vêm da sessão do Hub. Créditos só são exibidos quando o Hub fornece uma carteira para o módulo Magalu.</p></div><button class="mg-secondary-btn" id="mg-plan-refresh" type="button">Atualizar</button></section>
        <section class="mg-account-grid">
          <article class="mg-section-card"><div class="mg-section-head"><div><span class="mg-kicker">Assinatura</span><h2>Plano atual</h2></div><span class="mg-pill" id="mg-plan-status">—</span></div><dl class="mg-facts"><div><dt>Plano</dt><dd id="mg-plan-name">—</dd></div><div><dt>Código</dt><dd id="mg-plan-code">—</dd></div><div><dt>Ciclo</dt><dd id="mg-plan-cycle">—</dd></div><div><dt>Validade</dt><dd id="mg-plan-expiry">—</dd></div></dl><a class="mg-primary-btn" id="mg-plan-renew" href="#" hidden>Gerenciar assinatura</a></article>
          <article class="mg-section-card"><div class="mg-section-head"><div><span class="mg-kicker">Consumo</span><h2>Créditos</h2></div></div><div class="mg-credit-balance"><span>Saldo informado pelo Hub</span><strong id="mg-credit-balance">—</strong><small id="mg-credit-note">Carregando...</small></div><dl class="mg-facts"><div><dt>Modo de cobrança</dt><dd id="mg-billing-mode">—</dd></div><div><dt>Política de uso</dt><dd id="mg-usage-policy">—</dd></div><div><dt>Recurso Magalu</dt><dd id="mg-resource-status">—</dd></div></dl></article>
        </section>
      </section>

      <section id="mg-help-page" data-page="/ajuda" hidden>
        <section class="mg-page-head"><div><span class="mg-kicker">Conta · suporte</span><h1>Ajuda e contato</h1><p>Envie uma mensagem ao suporte com o contexto da conta Magalu e da última sincronização.</p></div></section>
        <section class="mg-account-grid">
          <article class="mg-section-card"><form id="mg-help-form" class="mg-help-form"><label><span>Assunto</span><select id="mg-help-topic" required><option value="duvidas">Dúvidas</option><option value="integracao">Integração Magalu</option><option value="bugs">Problemas / Bugs</option><option value="financeiro">Financeiro</option><option value="sugestoes">Sugestões</option><option value="reclamacoes">Reclamações</option><option value="outro">Outro</option></select></label><label><span>Mensagem</span><textarea id="mg-help-message" rows="8" minlength="10" maxlength="5000" required placeholder="Descreva o que aconteceu e o que você esperava que ocorresse."></textarea></label><fieldset><legend>Como prefere receber retorno?</legend><label class="mg-radio"><input type="radio" name="mg_reply" value="email" checked> Email do login</label><label class="mg-radio"><input type="radio" name="mg_reply" value="cellphone"> Celular</label></fieldset><label id="mg-help-phone-row" hidden><span>Celular</span><input id="mg-help-phone" type="tel" autocomplete="tel" placeholder="(43) 99999-9999"></label><div class="mg-help-actions"><button class="mg-primary-btn" id="mg-help-submit" type="submit">Enviar mensagem</button><span id="mg-help-feedback" class="mg-form-feedback"></span></div></form></article>
          <article class="mg-section-card"><div class="mg-section-head"><div><span class="mg-kicker">Contexto</span><h2>Informações anexadas</h2></div></div><dl class="mg-facts"><div><dt>Usuário</dt><dd id="mg-help-user">—</dd></div><div><dt>Conta Magalu</dt><dd id="mg-help-account">—</dd></div><div><dt>Tenant DACH</dt><dd id="mg-help-tenant">—</dd></div><div><dt>Página</dt><dd id="mg-help-page-path">—</dd></div></dl><div class="mg-info-callout"><strong>Sem credenciais</strong><p>Tokens OAuth, secrets e headers de autorização nunca são enviados no formulário de suporte.</p></div></article>
        </section>
      </section>

      <dialog class="mg-unlink-dialog" id="mg-unlink-dialog">
        <form method="dialog" class="mg-unlink-dialog__card">
          <div class="mg-section-head"><div><span class="mg-kicker">Conta Magalu</span><h2>Desvincular conexão?</h2></div><button class="mg-icon-btn" value="cancel" aria-label="Fechar">×</button></div>
          <p>Os tokens OAuth serão removidos, webhooks locais serão desativados e a conta deixará de aparecer como ativa. Histórico de sincronização e auditoria serão preservados.</p>
          <div class="mg-warning-callout" id="mg-unlink-warning">Se existir uma escrita de preço ou estoque pendente, a desvinculação será bloqueada até a reverificação.</div>
          <label><span>Motivo (opcional)</span><textarea id="mg-unlink-reason" rows="3" maxlength="500" placeholder="Ex.: conectei a conta pessoal por engano"></textarea></label>
          <label class="mg-confirm-unlink"><input id="mg-unlink-confirm" type="checkbox"> <span>Entendi que terei de autorizar novamente para usar esta organização.</span></label>
          <div class="mg-dialog-actions"><button class="mg-secondary-btn" value="cancel">Cancelar</button><button class="mg-danger-btn" id="mg-unlink-submit" type="button" disabled>Desvincular conta</button></div>
        </form>
      </dialog>`);
  }

  function decorateAccountRows() {
    const list = $("mg-account-list");
    if (!list) return;
    list.querySelectorAll(".mg-account-row[data-account-id]").forEach((row) => {
      const actions = row.querySelector(".mg-account-row__actions");
      if (!actions || actions.dataset.enhanced === "1") return;
      actions.dataset.enhanced = "1";
      const id = row.dataset.accountId;
      const reconnect = document.createElement("a");
      reconnect.className = "mg-secondary-btn";
      reconnect.href = `/magalu/auth/start?return=${encodeURIComponent("/magalu/contas")}`;
      reconnect.textContent = "Reconectar";
      const test = document.createElement("button");
      test.type = "button"; test.className = "mg-secondary-btn"; test.dataset.accountTest = id; test.textContent = "Testar conexão";
      const unlink = document.createElement("button");
      unlink.type = "button"; unlink.className = "mg-danger-btn mg-danger-btn--soft"; unlink.dataset.accountUnlink = id; unlink.textContent = "Desvincular";
      actions.append(reconnect, test, unlink);
    });
  }

  async function loadContext() {
    const id = selectedAccountId();
    return fetchJson(accountApi(`/context${id ? `?account_id=${id}` : ""}`));
  }

  function dateLabel(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR");
  }

  async function renderAccountPages() {
    const path = location.pathname.replace(/^\/magalu/, "").replace(/\/$/, "") || "/";
    if (!["/usuarios", "/plano", "/ajuda"].includes(path)) return;
    try {
      const data = await loadContext();
      if (path === "/usuarios") {
        $("mg-account-user-name").textContent = data.user?.name || "—";
        $("mg-account-user-email").textContent = data.user?.email || "—";
        $("mg-account-user-id").textContent = data.user?.id || "—";
        $("mg-account-tenant-id").textContent = data.tenant_id || "—";
        $("mg-user-access-state").textContent = data.access?.allow ? "Acesso ativo" : (data.access?.status || data.access?.reason || "Indisponível");
        $("mg-user-access-state").dataset.state = data.access?.allow ? "active" : "warning";
      }
      if (path === "/plano") {
        const subscription = data.subscription || {};
        const access = data.access || {};
        $("mg-plan-status").textContent = subscription.status || (subscription.active ? "active" : "não informado");
        $("mg-plan-status").dataset.state = subscription.active ? "active" : "idle";
        $("mg-plan-name").textContent = subscription.plan_name || subscription.plan_code || "Não informado pelo Hub";
        $("mg-plan-code").textContent = subscription.plan_code || "—";
        $("mg-plan-cycle").textContent = subscription.cycle || "—";
        $("mg-plan-expiry").textContent = dateLabel(subscription.expires_at);
        const renew = $("mg-plan-renew");
        if (subscription.renewal_url) { renew.href = subscription.renewal_url; renew.hidden = false; }
        const balance = data.credits?.balance;
        $("mg-credit-balance").textContent = Number.isFinite(Number(balance)) ? `${Number(balance).toLocaleString("pt-BR")} c` : "—";
        $("mg-credit-note").textContent = Number.isFinite(Number(balance)) ? "Carteira informada pelo Hub." : "O Hub ainda não informou uma carteira de créditos para o módulo Magalu.";
        $("mg-billing-mode").textContent = access.billing_mode || "—";
        $("mg-usage-policy").textContent = access.usage_policy || "—";
        $("mg-resource-status").textContent = access.resource_status || access.status || "—";
      }
      if (path === "/ajuda") {
        $("mg-help-user").textContent = `${data.user?.name || "Usuário"} · ${data.user?.email || "—"}`;
        $("mg-help-account").textContent = data.selected_account?.magalu_tenant_name || data.selected_account?.magalu_tenant_id || "Nenhuma conta selecionada";
        $("mg-help-tenant").textContent = data.tenant_id || "—";
        $("mg-help-page-path").textContent = location.pathname;
      }
    } catch (error) {
      console.warn("[magalu-account] context", error);
    }
  }

  function openUnlink(accountId) {
    unlinkTarget = Number(accountId);
    $("mg-unlink-reason").value = "";
    $("mg-unlink-confirm").checked = false;
    $("mg-unlink-submit").disabled = true;
    $("mg-unlink-dialog")?.showModal();
  }

  async function submitUnlink() {
    if (!unlinkTarget || !$("mg-unlink-confirm")?.checked) return;
    const button = $("mg-unlink-submit");
    button.disabled = true;
    button.textContent = "Desvinculando...";
    try {
      const result = await fetchJson(accountApi(`/accounts/${unlinkTarget}/unlink`), {
        method: "POST",
        body: JSON.stringify({ reason: $("mg-unlink-reason")?.value || "" }),
      });
      if (result.replacement_account_id) localStorage.setItem(ACCOUNT_KEY, String(result.replacement_account_id));
      else localStorage.removeItem(ACCOUNT_KEY);
      $("mg-unlink-dialog")?.close();
      if (result.hub_unlink?.ok === false) {
        alert("A conexão foi removida do DACHBYTE e os tokens foram apagados, mas o Hub não confirmou o unlink. O evento foi registrado para correção.");
      }
      location.href = "/magalu/contas?unlinked=1";
    } catch (error) {
      const blockers = Array.isArray(error.payload?.blockers) ? error.payload.blockers : [];
      const detail = blockers.length ? `\n\nOperações pendentes: ${blockers.map((item) => `#${item.id} ${item.resource_type}/${item.sku} (${item.status})`).join(", ")}` : "";
      alert(`${error.message}${detail}`);
      button.disabled = false;
    } finally {
      button.textContent = "Desvincular conta";
    }
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

  function bind() {
    const list = $("mg-account-list");
    if (list) {
      new MutationObserver(decorateAccountRows).observe(list, { childList: true, subtree: true });
      decorateAccountRows();
      list.addEventListener("click", (event) => {
        const test = event.target.closest("[data-account-test]");
        if (test) {
          localStorage.setItem(ACCOUNT_KEY, test.dataset.accountTest);
          location.href = "/magalu/integracoes?test=1";
          return;
        }
        const unlink = event.target.closest("[data-account-unlink]");
        if (unlink) openUnlink(unlink.dataset.accountUnlink);
      });
    }
    $("mg-unlink-confirm")?.addEventListener("change", (event) => { $("mg-unlink-submit").disabled = !event.target.checked; });
    $("mg-unlink-submit")?.addEventListener("click", () => void submitUnlink());
    $("mg-plan-refresh")?.addEventListener("click", () => void renderAccountPages());
    $("mg-help-form")?.addEventListener("submit", (event) => void submitHelp(event));
    document.querySelectorAll('input[name="mg_reply"]').forEach((input) => input.addEventListener("change", () => {
      const mobile = document.querySelector('input[name="mg_reply"]:checked')?.value === "cellphone";
      $("mg-help-phone-row").hidden = !mobile;
      $("mg-help-phone").required = mobile;
    }));
    if (location.pathname === "/magalu/integracoes" && new URLSearchParams(location.search).get("test") === "1") {
      setTimeout(() => $("mg-test-connection")?.click(), 500);
    }
  }

  ensureStructure();
  document.addEventListener("DOMContentLoaded", () => {
    bind();
    void renderAccountPages();
    if (new URLSearchParams(location.search).get("unlinked") === "1") {
      const alertBox = $("mg-oauth-alert");
      if (alertBox) { alertBox.hidden = false; alertBox.className = "mg-alert success"; alertBox.textContent = "Conta Magalu desvinculada. Você já pode conectar a organização correta."; }
    }
  });
})();
