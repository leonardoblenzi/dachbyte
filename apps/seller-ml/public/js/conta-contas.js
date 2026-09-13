(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = {
    accounts: [],
    currentId: null,
    query: "",
    selectedUnlinkId: null,
    viewer: null,
  };

  function withBase(path) {
    if (window.ML_BASE_URL && typeof window.ML_BASE_URL.withBase === "function") {
      return window.ML_BASE_URL.withBase(path);
    }
    const base = document.body?.dataset?.baseUrl || "";
    return `${base}${path}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  async function api(path, options = {}) {
    const response = await fetch(withBase(path), {
      credentials: "include",
      ...options,
      headers: {
        accept: "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    if (!response.ok || payload.ok === false) {
      const fallback = text
        ? text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220)
        : "";
      throw new Error(
        payload.error ||
          payload.message ||
          fallback ||
          `Falha na operacao. HTTP ${response.status}`
      );
    }
    return payload;
  }

  function normalize(value) {
    return String(value || "").trim().toLowerCase();
  }

  function isUnlinked(account) {
    return ["desvinculada", "revogada", "unlinked", "revoked"].includes(normalize(account?.status));
  }

  function tokenLabel(account) {
    if (isUnlinked(account)) return { label: "Removido", tone: "muted" };
    if (!account?.has_tokens) return { label: "Sem token", tone: "warn" };
    return { label: "Conectado", tone: "ok" };
  }

  function billingLabel(account) {
    const billing = account?.billing || {};
    const status = normalize(account?.billing_status || billing.status);
    const mode = normalize(account?.billing_mode || billing.billing_mode);
    const policy = normalize(account?.usage_policy || billing.usage_policy);
    if (isUnlinked(account) || status === "unlinked") return { label: "Desvinculada", tone: "danger" };
    if (policy === "unlimited" || (status === "legacy_active" && mode === "legacy")) {
      return { label: "Ilimitada", tone: "ok" };
    }
    if (status === "active") return { label: "Plano ativo", tone: "ok" };
    if (status === "awaiting_subscription") return { label: "Aguardando assinatura", tone: "warn" };
    if (status === "range_exceeded") return { label: "Faixa excedida", tone: "warn" };
    if (status === "suspended_by_payment") return { label: "Pagamento pendente", tone: "danger" };
    if (status === "suspended_by_range") return { label: "Suspensa por faixa", tone: "danger" };
    if (status === "courtesy_unlimited") return { label: "Cortesia", tone: "ok" };
    if (status === "internal_unlimited") return { label: "Interna", tone: "ok" };
    return { label: status || "Sem politica", tone: "muted" };
  }

  function shouldShowRegularize(account) {
    const billing = account?.billing || {};
    const status = normalize(account?.billing_status || billing.status);
    const mode = normalize(account?.billing_mode || billing.billing_mode);
    const policy = normalize(account?.usage_policy || billing.usage_policy);
    const unlimited =
      policy === "unlimited" ||
      status === "courtesy_unlimited" ||
      status === "internal_unlimited" ||
      (status === "legacy_active" && mode === "legacy");

    if (isUnlinked(account) || unlimited) return false;
    if (billing.requires_regularization === true || billing.requires_upgrade === true) return true;
    if (billing.can_operate === false) return true;
    return [
      "awaiting_subscription",
      "range_exceeded",
      "suspended_by_payment",
      "suspended_by_range",
      "expired",
      "past_due",
      "refunded",
      "chargeback",
    ].includes(status);
  }

  function orderRangeLabel(code) {
    const labels = {
      up_to_30: "Ate 30 vendas",
      up_to_200: "Ate 200 pedidos",
      from_31_to_200: "31 a 200 vendas",
      from_201_to_700: "201 a 700 vendas",
      from_701_to_1500: "701 a 1.500 vendas",
      above_1500: "Acima de 1.500 vendas",
    };
    return labels[String(code || "").trim()] || code || "Faixa nao definida";
  }

  function visibleAccounts() {
    const q = normalize(state.query);
    const showUnlinked = $("show-unlinked")?.checked !== false;
    return state.accounts.filter((account) => {
      if (!showUnlinked && isUnlinked(account)) return false;
      if (!q) return true;
      return [
        account.label,
        account.apelido,
        account.empresa_nome,
        account.meli_user_id,
        account.id,
      ].some((value) => normalize(value).includes(q));
    });
  }

  function renderStats() {
    const total = state.accounts.length;
    const unlinked = state.accounts.filter(isUnlinked).length;
    const tokenless = state.accounts.filter((account) => !isUnlinked(account) && !account.has_tokens).length;
    setText("stat-total", String(total));
    setText("stat-active", String(total - unlinked));
    setText("stat-tokenless", String(tokenless));
    setText("stat-unlinked", String(unlinked));
  }

  function renderAccounts() {
    const root = $("accounts-grid");
    if (!root) return;
    renderStats();

    const rows = visibleAccounts();
    setText("accounts-counter", rows.length ? `${rows.length} conta(s) visivel(is)` : "Nenhuma conta visivel");
    if (!rows.length) {
      root.innerHTML = '<article class="linked-account-card is-empty">Nenhuma conta encontrada.</article>';
      return;
    }

    root.innerHTML = rows.map((account) => {
      const canManageAccounts = state.viewer?.is_admin_any === true;
      const label = account.label || account.apelido || `Conta ${account.meli_user_id || account.id}`;
      const initials = String(label).slice(0, 2).toUpperCase();
      const current = Number(account.id) === Number(state.currentId);
      const unlinked = isUnlinked(account);
      const token = tokenLabel(account);
      const billing = billingLabel(account);
      const renewalUrl = String(account.renewal_checkout_url || account.billing?.renewal_checkout_url || "").trim();
      const showRegularize = renewalUrl && shouldShowRegularize(account);
      const range = orderRangeLabel(account.order_range_code || account.recommended_range_code || account.billing?.order_range_code);
      return `
        <article class="linked-account-card ${current ? "is-current" : ""} ${unlinked ? "is-unlinked" : ""}">
          <header class="linked-account-card__head">
            <div class="linked-account-identity">
              <span class="linked-account-avatar">${escapeHtml(initials)}</span>
              <div>
                <strong>${escapeHtml(label)}</strong>
                <small>${escapeHtml(account.empresa_nome || "Empresa atual")} - ID local ${escapeHtml(account.id || "-")}</small>
              </div>
            </div>
            <div class="linked-account-badges">
              ${current ? '<span class="linked-pill is-ok">Padrao atual</span>' : ""}
              <span class="linked-pill is-${token.tone}">${escapeHtml(token.label)}</span>
              <span class="linked-pill is-${billing.tone}">${escapeHtml(billing.label)}</span>
            </div>
          </header>
          <dl class="linked-account-meta">
            <div><dt>ML User ID</dt><dd>${escapeHtml(account.meli_user_id || "-")}</dd></div>
            <div><dt>Status local</dt><dd>${escapeHtml(account.status || "-")}</dd></div>
            <div><dt>Faixa</dt><dd>${escapeHtml(range)}</dd></div>
          </dl>
          <footer class="linked-account-actions">
            <button class="au-btn au-btn-primary" type="button" data-enter-account="${escapeHtml(account.id)}" ${unlinked ? "disabled" : ""}>
              ${current ? "Abrir painel" : "Entrar nesta conta"}
            </button>
            ${canManageAccounts ? `<button class="au-btn au-btn-secondary" type="button" data-default-account="${escapeHtml(account.id)}" ${current || unlinked ? "disabled" : ""}>Definir padrao</button>` : ""}
            ${showRegularize ? `<button class="au-btn au-btn-secondary" type="button" data-renew-account="${escapeHtml(renewalUrl)}">Regularizar</button>` : ""}
            ${canManageAccounts ? `<button class="au-btn au-btn-danger" type="button" data-unlink-account="${escapeHtml(account.id)}" ${unlinked ? "disabled" : ""}>Desvincular</button>` : ""}
          </footer>
        </article>
      `;
    }).join("");
  }

  async function loadAccounts() {
    const root = $("accounts-grid");
    if (root) root.innerHTML = '<article class="linked-account-card is-loading">Carregando contas...</article>';
    const payload = await api("/api/account/list?include_unlinked=1");
    state.accounts = Array.isArray(payload.oauth) ? payload.oauth : [];
    state.currentId = payload.current?.id || payload.accountKey || null;
    state.viewer = payload.viewer || payload.current?.viewer || null;
    renderAccounts();
  }

  async function enterAccount(id) {
    await api("/api/meli/selecionar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meli_conta_id: Number(id) }),
    });
    window.location.href = withBase("/painel");
  }

  async function setDefaultAccount(id) {
    await api("/api/meli/default", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meli_conta_id: Number(id) }),
    });
    await enterAccount(id);
  }

  async function startAccountLink() {
    const button = $("btn-link-account");
    const original = button?.textContent || "Vincular nova conta";
    if (button) {
      button.disabled = true;
      button.textContent = "Abrindo Mercado Livre...";
    }
    try {
      const payload = await api("/api/meli/oauth/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ return_to: "/conta/contas?linked=1" }),
      });
      if (!payload.url) throw new Error("URL de autorizacao nao retornada.");
      window.location.href = payload.url;
    } catch (error) {
      alert(error.message || "Nao foi possivel iniciar a vinculacao.");
      if (button) {
        button.disabled = false;
        button.textContent = original;
      }
    }
  }

  function openUnlinkDialog(id) {
    const account = state.accounts.find((item) => Number(item.id) === Number(id));
    if (!account || isUnlinked(account)) return;
    state.selectedUnlinkId = Number(id);
    const label = account.label || account.apelido || `Conta ${account.meli_user_id || account.id}`;
    setText("unlink-title", `Desvincular ${label}`);
    setText("unlink-subtitle", `ML User ID ${account.meli_user_id || "-"} - esta acao mantem o historico.`);
    const reason = $("unlink-reason");
    if (reason) reason.value = "Conta desvinculada a pedido do cliente.";
    $("unlink-dialog")?.showModal();
  }

  async function confirmUnlink() {
    const id = Number(state.selectedUnlinkId || 0);
    if (!Number.isFinite(id) || id <= 0) return;
    const reason = String($("unlink-reason")?.value || "").trim();
    if (!reason) {
      alert("Informe o motivo administrativo.");
      return;
    }
    const button = $("btn-confirm-unlink");
    if (button) button.disabled = true;
    try {
      await api(`/api/account/${encodeURIComponent(String(id))}/unlink`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      $("unlink-dialog")?.close();
      state.selectedUnlinkId = null;
      await loadAccounts();
    } catch (error) {
      alert(error.message || "Nao foi possivel desvincular a conta.");
    } finally {
      if (button) button.disabled = false;
    }
  }

  function bindEvents() {
    $("btn-refresh-accounts")?.addEventListener("click", loadAccounts);
    $("btn-link-account")?.addEventListener("click", startAccountLink);
    $("show-unlinked")?.addEventListener("change", renderAccounts);
    $("account-search")?.addEventListener("input", (event) => {
      state.query = event.target.value || "";
      renderAccounts();
    });
    $("btn-confirm-unlink")?.addEventListener("click", confirmUnlink);
    $("accounts-grid")?.addEventListener("click", (event) => {
      const renew = event.target.closest("[data-renew-account]");
      if (renew) {
        const url = String(renew.getAttribute("data-renew-account") || "").trim();
        if (url) window.location.href = url;
        return;
      }
      const enter = event.target.closest("[data-enter-account]");
      if (enter) {
        enterAccount(enter.getAttribute("data-enter-account"));
        return;
      }
      const setDefault = event.target.closest("[data-default-account]");
      if (setDefault) {
        setDefaultAccount(setDefault.getAttribute("data-default-account"));
        return;
      }
      const unlink = event.target.closest("[data-unlink-account]");
      if (unlink) {
        openUnlinkDialog(unlink.getAttribute("data-unlink-account"));
      }
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    try {
      await loadAccounts();
    } catch (error) {
      const root = $("accounts-grid");
      if (root) root.innerHTML = '<article class="linked-account-card is-empty">Nao foi possivel carregar as contas.</article>';
      setText("accounts-counter", error.message || "Falha ao carregar contas.");
    }
  });
})();
