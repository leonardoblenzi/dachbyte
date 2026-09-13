(function initBasePath() {
  if (typeof window === "undefined") return;
  if (window.__ML_BASE_PATH != null) return;
  const p = window.location && window.location.pathname ? window.location.pathname : "";
  const m = String(p).match(
    /^\/([^/]+)\/(?:login|cadastro|ativar|esqueci-senha|redefinir-senha|selecao-plataforma|select-conta|vincular-conta|api|painel|admin)(?:\/|$)/i,
  );
  window.__ML_BASE_PATH = m && m[1] ? `/${m[1]}` : "";
})();

function withBase(path) {
  const base =
    typeof window !== "undefined" && window.__ML_BASE_PATH ? window.__ML_BASE_PATH : "";
  if (!path || typeof path !== "string") return path;
  if (/^https?:\/\//i.test(path)) return path;
  if (!base) return path;
  if (path === base || path.startsWith(base + "/")) return path;
  if (path.startsWith("/")) return base + path;
  return path;
}

(() => {
  const $ = (sel) => document.querySelector(sel);

  const state = {
    isMaster: false,
    accounts: [],
    currentId: null,
    q: "",
    onlyActive: true,
    page: 1,
    pageSize: 24,
    total: 0,
    totalPages: 1,
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[<>&'"]/g, (c) => ({
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  function debounce(fn, ms = 220) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function fmtDateShort(value) {
    const date = parseDate(value);
    return date
      ? date.toLocaleString("pt-BR", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "-";
  }

  function fmtDate(value) {
    const date = parseDate(value);
    return date ? date.toLocaleString("pt-BR") : "-";
  }

  function tokenLabel(account) {
    if (!account?.has_tokens) return { label: "Sem token", tone: "warn" };
    const mins = Number(account.expires_in_min);
    if (!Number.isFinite(mins)) return { label: "Token OK", tone: "ok" };
    if (mins < 0) return { label: "Expirado", tone: "err" };
    if (mins <= 10) return { label: `Expira em ${mins} min`, tone: "warn" };
    return { label: "Token OK", tone: "ok" };
  }

  function showAlert(message, tone = "info") {
    const alert = $("#alert");
    if (!alert) return;
    alert.hidden = false;
    alert.textContent = message;
    alert.dataset.tone = tone;
  }

  function clearAlert() {
    const alert = $("#alert");
    if (!alert) return;
    alert.hidden = true;
    alert.textContent = "";
  }

  async function fetchJson(url, opts = {}) {
    const response = await fetch(withBase(url), {
      credentials: "include",
      cache: "no-store",
      ...opts,
    });
    const payload = await response.json().catch(() => null);
    return { response, payload };
  }

  function isMasterPayload(payload) {
    if (payload?.flags?.is_master === true) return true;
    if (payload?.is_master === true) return true;
    return String(payload?.user?.nivel || "").trim().toLowerCase() === "admin_master";
  }

  async function loadMe() {
    const { response, payload } = await fetchJson("/api/auth/me");
    if (!response.ok || !payload?.logged) {
      window.location.href = withBase("/login");
      return false;
    }
    state.isMaster = isMasterPayload(payload);
    if (!state.isMaster) {
      window.location.href = withBase("/painel");
      return false;
    }
    return true;
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function renderLoginChart(series = []) {
    const root = $("#login-chart");
    if (!root) return;

    const rows = Array.isArray(series) ? series : [];
    const max = Math.max(1, ...rows.map((row) => Number(row.total || 0)));
    const width = 640;
    const height = 180;
    const padX = 22;
    const padY = 24;
    const step = rows.length > 1 ? (width - padX * 2) / (rows.length - 1) : 0;
    const points = rows.map((row, index) => {
      const x = padX + index * step;
      const y = height - padY - (Number(row.total || 0) / max) * (height - padY * 2);
      return { x, y, ...row };
    });
    const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
    const area = points.length
      ? `${padX},${height - padY} ${polyline} ${width - padX},${height - padY}`
      : "";

    root.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Logins dos ultimos 7 dias">
        <polyline class="login-chart__area" points="${area}"></polyline>
        <polyline class="login-chart__line" points="${polyline}"></polyline>
        ${points.map((point) => `
          <g>
            <circle class="login-chart__dot" cx="${point.x}" cy="${point.y}" r="4"></circle>
            <text class="login-chart__value" x="${point.x}" y="${Math.max(14, point.y - 10)}">${Number(point.total || 0)}</text>
            <text class="login-chart__label" x="${point.x}" y="${height - 6}">${escapeHtml(String(point.day || "").slice(5).replace("-", "/"))}</text>
          </g>
        `).join("")}
      </svg>
    `;
  }

  function renderSparkline(series = []) {
    const rows = Array.isArray(series) ? series : [];
    const max = Math.max(1, ...rows.map((row) => Number(row.total || 0)));
    const width = 168;
    const height = 48;
    const step = rows.length > 1 ? width / (rows.length - 1) : 0;
    const points = rows.map((row, index) => {
      const x = index * step;
      const y = height - 4 - (Number(row.total || 0) / max) * (height - 10);
      return `${x},${y}`;
    }).join(" ");
    const area = points ? `0,${height - 4} ${points} ${width},${height - 4}` : "";
    return `
      <svg class="company-sparkline" viewBox="0 0 ${width} ${height}" aria-hidden="true">
        <polyline class="company-sparkline__area" points="${area}"></polyline>
        <polyline class="company-sparkline__line" points="${points}"></polyline>
      </svg>
    `;
  }

  function renderCompanyActivityChart(companies = []) {
    const root = $("#company-activity-chart");
    if (!root) return;

    const rows = Array.isArray(companies) ? companies.slice(0, 6) : [];
    if (!rows.length) {
      root.innerHTML = `<div class="company-empty">Sem atividade registrada por empresa.</div>`;
      return;
    }

    const max = Math.max(1, ...rows.map((company) => Number(company.logins_7d || 0)));
    root.innerHTML = rows.map((company, index) => {
      const total = Number(company.logins_7d || 0);
      const width = Math.max(4, Math.round((total / max) * 100));
      return `
        <div class="company-bar-row">
          <div class="company-bar-row__label">
            <strong>${escapeHtml(company.nome || `Empresa ${company.id}`)}</strong>
            <span>${total} login${total === 1 ? "" : "s"}</span>
          </div>
          <div class="company-bar-track">
            <span class="company-bar-fill tone-${index % 4}" style="width:${width}%"></span>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderCompanyActivityCards(companies = []) {
    const root = $("#company-activity-cards");
    if (!root) return;

    const rows = Array.isArray(companies) ? companies : [];
    if (!rows.length) {
      root.innerHTML = `<article class="company-card is-empty">Nenhuma empresa com atividade recente.</article>`;
      return;
    }

    root.innerHTML = rows.map((company) => {
      const latest = company.latest_login || null;
      const latestLabel = latest
        ? `${latest.nome || latest.email || "Usuario"} - ${fmtDateShort(latest.at)}`
        : "Sem login recente";
      return `
        <article class="company-card">
          <div class="company-card__head">
            <div>
              <strong>${escapeHtml(company.nome || `Empresa ${company.id}`)}</strong>
              <small>${Number(company.usuarios_count || 0)} usuario(s) - ${Number(company.contas_ml_count || 0)} conta(s) ML</small>
            </div>
            <span>${Number(company.logins_7d || 0)}</span>
          </div>
          ${renderSparkline(company.series)}
          <div class="company-card__footer">
            <span>Ultimo login</span>
            <strong>${escapeHtml(latestLabel)}</strong>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderCompanyActivity(companies = []) {
    const rows = Array.isArray(companies) ? companies : [];
    const total = rows.reduce((sum, company) => sum + Number(company.logins_7d || 0), 0);
    setText(
      "company-activity-meta",
      rows.length
        ? `${total} login${total === 1 ? "" : "s"} nas principais empresas`
        : "Sem atividade recente",
    );
    renderCompanyActivityChart(rows);
    renderCompanyActivityCards(rows);
  }

  function prettifyEvent(evento) {
    return String(evento || "")
      .replace(/^admin_/, "")
      .replaceAll("_", " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function renderUsageInsights(insights = []) {
    const root = $("#usage-insights-grid");
    if (!root) return;

    const rows = Array.isArray(insights) ? insights : [];
    const total = rows.reduce((sum, item) => sum + Number(item.total || 0), 0);
    setText(
      "usage-insights-meta",
      total
        ? `${total} evento${total === 1 ? "" : "s"} auditado${total === 1 ? "" : "s"} em 7 dias`
        : "Sem eventos auditados recentes",
    );

    if (!rows.length) {
      root.innerHTML = `<article class="usage-card is-empty">Sem atividade auditada nos ultimos 7 dias.</article>`;
      return;
    }

    const max = Math.max(1, ...rows.map((item) => Number(item.total || 0)));
    root.innerHTML = rows.map((item, index) => {
      const totalArea = Number(item.total || 0);
      const width = Math.max(6, Math.round((totalArea / max) * 100));
      const topEvents = Array.isArray(item.top_events) ? item.top_events : [];
      return `
        <article class="usage-card">
          <div class="usage-card__head">
            <div>
              <strong>${escapeHtml(item.area || "Outros")}</strong>
              <small>${fmtDateShort(item.last_at) === "-" ? "Sem atividade recente" : `Ultima acao ${fmtDateShort(item.last_at)}`}</small>
            </div>
            <span>${totalArea}</span>
          </div>
          <div class="usage-track">
            <span class="usage-fill tone-${index % 4}" style="width:${width}%"></span>
          </div>
          <ul class="usage-events">
            ${topEvents.map((event) => `
              <li>
                <span>${escapeHtml(prettifyEvent(event.evento))}</span>
                <strong>${Number(event.total || 0)}</strong>
              </li>
            `).join("")}
          </ul>
        </article>
      `;
    }).join("");
  }

  async function loadDashboardStats() {
    try {
      const { response, payload } = await fetchJson("/api/admin/dashboard-stats");
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error || "Falha ao carregar indicadores.");
      }

      const users = payload.users || {};
      const accounts = payload.accounts || {};
      const companies = payload.companies || {};
      const latest = payload.latest_login || null;
      const loginSeries = Array.isArray(payload.login_series) ? payload.login_series : [];
      const companyActivity = Array.isArray(payload.company_activity) ? payload.company_activity : [];
      const usageInsights = Array.isArray(payload.usage_insights) ? payload.usage_insights : [];
      const totalLogins = loginSeries.reduce((sum, row) => sum + Number(row.total || 0), 0);

      setText("stat-logged-24h", String(users.logged_24h || 0));
      setText(
        "stat-latest-login",
        latest ? `${latest.nome || latest.email || "Usuario"} - ${fmtDateShort(latest.at)}` : "Sem login",
      );
      setText("kpi-users-total", String(users.total || 0));
      setText("kpi-users-active", `${users.active || 0} ativos`);
      setText("kpi-users-7d", String(users.logged_7d || 0));
      setText("kpi-companies", String(companies.total || 0));
      setText("kpi-accounts", String(accounts.total || 0));
      setText("kpi-accounts-token", `${accounts.with_tokens || 0} com tokens`);
      setText("login-chart-meta", `${totalLogins} login${totalLogins === 1 ? "" : "s"} no periodo`);
      renderLoginChart(loginSeries);
      renderCompanyActivity(companyActivity);
      renderUsageInsights(usageInsights);
    } catch (error) {
      setText("login-chart-meta", "Indicadores indisponiveis");
      setText("company-activity-meta", "Atividade indisponivel");
      setText("usage-insights-meta", "Insights indisponiveis");
      renderLoginChart([]);
      renderCompanyActivity([]);
      renderUsageInsights([]);
      showAlert(error.message || "Nao foi possivel carregar os indicadores.", "err");
    }
  }

  function buildAccountsUrl() {
    const params = new URLSearchParams();
    if (state.q) params.set("q", state.q);
    if (state.onlyActive) params.set("active_only", "1");
    params.set("page", String(state.page));
    params.set("pageSize", String(state.pageSize));
    const query = params.toString();
    return `/api/meli/contas${query ? `?${query}` : ""}`;
  }

  function billingLabel(account) {
    const status = String(account?.billing_status || "").trim().toLowerCase();
    const mode = String(account?.billing_mode || "").trim().toLowerCase();
    const policy = String(account?.usage_policy || "").trim().toLowerCase();
    if (policy === "unlimited" || (status === "legacy_active" && mode === "legacy")) {
      return { label: "Legado ilimitado", tone: "ok" };
    }
    if (status === "active") return { label: "Plano ativo", tone: "ok" };
    if (status === "awaiting_subscription") return { label: "Aguardando assinatura", tone: "warn" };
    if (status === "range_exceeded") return { label: "Faixa excedida", tone: "warn" };
    if (status === "suspended_by_range") return { label: "Suspensa por faixa", tone: "err" };
    if (status === "suspended_by_payment") return { label: "Pagamento pendente", tone: "err" };
    if (status === "internal_unlimited") return { label: "Interna ilimitada", tone: "ok" };
    if (status === "courtesy_unlimited") return { label: "Cortesia ilimitada", tone: "ok" };
    return { label: status || "Sem status", tone: "neutral" };
  }

  function orderRangeLabel(code) {
    const normalized = String(code || "").trim();
    const labels = {
      up_to_30: "Ate 30 pedidos",
      up_to_200: "Ate 200 pedidos",
      from_31_to_200: "31 a 200 pedidos",
      from_201_to_700: "201 a 700 pedidos",
      from_701_to_1500: "701 a 1.500 pedidos",
      above_1500: "Acima de 1.500 pedidos",
    };
    return labels[normalized] || normalized || "Faixa padrao";
  }

  function renderAccounts() {
    const root = $("#accounts-body");
    if (!root) return;

    setText("stat-total", String(state.total || 0));
    setText(
      "cards-meta",
      state.total
        ? `${state.total} conta${state.total === 1 ? "" : "s"} encontrada${state.total === 1 ? "" : "s"}`
        : "Nenhuma conta encontrada",
    );

    const current = state.accounts.find((account) => Number(account.id) === Number(state.currentId));
    setText("stat-current", current ? (current.apelido || `Conta ${current.meli_user_id}`) : "Nenhuma");

    if (!state.accounts.length) {
      root.innerHTML = `<article class="global-account-card is-empty">Nenhuma conta encontrada.</article>`;
      return;
    }

    root.innerHTML = state.accounts.map((account) => {
      const isCurrent = Number(account.id) === Number(state.currentId);
      const token = tokenLabel(account);
      const label = account.apelido || `Conta ${account.meli_user_id}`;
      const initials = String(label).slice(0, 2).toUpperCase();
      const billingStatus = billingLabel(account);
      const orderRange = orderRangeLabel(account.order_range_code || account.recommended_range_code);
      const renewalUrl = String(account.renewal_checkout_url || "").trim();
      return `
        <article class="global-account-card ${isCurrent ? "is-current" : ""}">
          <div class="global-account-card__top">
            <span class="account-avatar">${escapeHtml(initials)}</span>
            <div>
              <strong>${escapeHtml(label)}</strong>
              <small>${escapeHtml(account.empresa_nome || "Empresa sem nome")}</small>
            </div>
          </div>
          <dl class="global-account-card__meta">
            <div>
              <dt>ML User ID</dt>
              <dd>${escapeHtml(account.meli_user_id || "-")}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd><span class="status-pill">${escapeHtml(account.status || "-")}</span></dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd><span class="token-pill is-${token.tone}">${escapeHtml(token.label)}</span></dd>
            </div>
            <div>
              <dt>Plano</dt>
              <dd>${escapeHtml(orderRange)}</dd>
            </div>
            <div>
              <dt>Cobranca</dt>
              <dd><span class="billing-pill is-${billingStatus.tone}">${escapeHtml(billingStatus.label)}</span></dd>
            </div>
          </dl>
          <div class="global-account-card__actions">
            <button class="master-btn ${isCurrent ? "master-btn--ghost" : "master-btn--primary"}" type="button" data-select-account="${escapeHtml(account.id)}">
              ${isCurrent ? "Abrir painel" : "Entrar nesta conta"}
            </button>
            ${renewalUrl ? `<button class="master-btn master-btn--ghost" type="button" data-renew-account="${escapeHtml(renewalUrl)}">Renovar plano desta conta</button>` : ""}
          </div>
        </article>
      `;
    }).join("");
  }

  function renderPagination() {
    const info = $("#page-info");
    const prev = $("#page-prev");
    const next = $("#page-next");
    if (info) {
      info.textContent = state.total ? `Pagina ${state.page} de ${state.totalPages}` : "-";
    }
    if (prev) prev.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= state.totalPages;
  }

  async function loadAccounts() {
    clearAlert();
    const root = $("#accounts-body");
    if (root) root.innerHTML = `<article class="global-account-card is-loading">Carregando contas...</article>`;

    try {
      const { response, payload } = await fetchJson(buildAccountsUrl());
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error || "Falha ao carregar contas.");
      }

      state.accounts = Array.isArray(payload.contas) ? payload.contas : [];
      state.currentId = payload.current_meli_conta_id || null;
      state.total = Number(payload.total || 0);
      state.totalPages = Math.max(1, Number(payload.totalPages || 1));
      state.page = Number(payload.page || state.page);

      renderAccounts();
      renderPagination();
    } catch (error) {
      if (root) root.innerHTML = `<article class="global-account-card is-empty">Nao foi possivel carregar as contas.</article>`;
      showAlert(error.message || "Erro ao carregar contas.", "err");
    }
  }

  async function selectAccount(id) {
    const accountId = Number(id);
    if (!Number.isFinite(accountId) || accountId <= 0) return;

    try {
      const { response, payload } = await fetchJson("/api/meli/selecionar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ meli_conta_id: accountId }),
      });
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error || "Falha ao selecionar conta.");
      }
      window.location.href = withBase("/painel");
    } catch (error) {
      showAlert(error.message || "Falha ao selecionar conta.", "err");
    }
  }

  async function clearSelection() {
    try {
      await fetch(withBase("/api/meli/limpar-selecao"), {
        method: "POST",
        credentials: "include",
      });
      state.currentId = null;
      await loadAccounts();
      showAlert("Selecao limpa.", "ok");
    } catch {
      showAlert("Nao foi possivel limpar a selecao.", "err");
    }
  }

  async function startAccountLink() {
    const button = $("#btn-link-account");
    const originalText = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Abrindo Mercado Livre...";
    }

    try {
      const { response, payload } = await fetchJson("/api/meli/oauth/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ return_to: "/select-conta?linked=1" }),
      });
      if (!response.ok || payload?.ok !== true || !payload?.url) {
        throw new Error(payload?.error || payload?.message || "Falha ao iniciar vinculacao.");
      }
      window.location.href = payload.url;
    } catch (error) {
      showAlert(error.message || "Nao foi possivel iniciar a vinculacao.", "err");
      if (button) {
        button.disabled = false;
        button.textContent = originalText || "Vincular nova conta";
      }
    }
  }

  function bindSelection() {
    const activeOnly = $("#master-only-active");
    if (activeOnly) activeOnly.checked = state.onlyActive;

    $("#master-search")?.addEventListener("input", debounce((event) => {
      state.q = String(event.target.value || "").trim();
      state.page = 1;
      loadAccounts();
    }, 250));

    activeOnly?.addEventListener("change", (event) => {
      state.onlyActive = !!event.target.checked;
      state.page = 1;
      loadAccounts();
    });

    $("#page-prev")?.addEventListener("click", () => {
      if (state.page <= 1) return;
      state.page -= 1;
      loadAccounts();
    });

    $("#page-next")?.addEventListener("click", () => {
      if (state.page >= state.totalPages) return;
      state.page += 1;
      loadAccounts();
    });

    $("#btn-clear")?.addEventListener("click", clearSelection);
    $("#btn-link-account")?.addEventListener("click", startAccountLink);

    $("#accounts-body")?.addEventListener("click", (event) => {
      const renewButton = event.target.closest("[data-renew-account]");
      if (renewButton) {
        const url = String(renewButton.getAttribute("data-renew-account") || "").trim();
        if (url) window.location.href = url;
        return;
      }
      const button = event.target.closest("[data-select-account]");
      if (!button) return;
      selectAccount(button.getAttribute("data-select-account"));
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    if (!(await loadMe())) return;
    if (document.body?.dataset?.masterPage === "global-selection") {
      bindSelection();
      await loadAccounts();
      return;
    }
    await loadDashboardStats();
  });
})();
