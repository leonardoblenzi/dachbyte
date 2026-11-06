// @ts-check
(function () {
  "use strict";

  const shellApi = /** @type {any} */ (window).DachSellerShell;
  shellApi.mount({
    product: "hub",
    theme: "violet",
    basePath: "/hub",
    brand: { name: "DACHBYTE", sub: "Hub · Multicanal", logo: "/brand/dachbyte/hub/mark.svg", href: "/hub/" },
    navGroups: [
      { id: "overview", label: "Visão geral", hint: "Painel e saúde", icon: "dashboard", items: [{ label: "Painel", path: "/hub/" }, { label: "Saúde das contas", path: "/hub/saude" }] },
      { id: "catalog", label: "Catálogo", hint: "Produtos e vínculos", icon: "package", items: [
        { label: "Produtos", path: "/hub/catalogo" },
        { label: "Pendências", path: "/hub/pendencias" },
      ] },
      { id: "stock", label: "Estoque", hint: "Saldos, regras e observação", icon: "stack", items: [
        { label: "Saldos", path: "/hub/estoque" },
        { label: "O que mudaria", path: "/hub/estoque/observacao" },
        { label: "Movimentos", path: "/hub/estoque/movimentos" },
        { label: "Envios", path: "/hub/estoque/envios" },
        { label: "Divergências", path: "/hub/estoque/divergencias" },
        { label: "Regras por conta", path: "/hub/estoque/regras" },
      ] },
      { id: "sales", label: "Vendas", hint: "Pedidos e baixas", icon: "receipt", items: [
        { label: "Pedidos", path: "/hub/pedidos" },
        { label: "Vendas sem vínculo", path: "/hub/pedidos?pendentes=1" },
      ] },
      { id: "account", label: "Conta", hint: "Acesso e integrações", icon: "user", items: [{ label: "Contas conectadas", path: "/hub/contas" }] },
    ],
    footNote: "Catálogo, estoque, pedidos e preços de todos os canais em um só fluxo.",
    status: { label: "Modo observação", tone: "success", href: "/hub/saude" },
    links: [{ label: "Módulos", href: "/selecao-plataforma", icon: "dashboard" }],
  });

  const main = /** @type {HTMLElement} */ (document.querySelector("[data-shell-content]"));
  const root = /** @type {HTMLElement} */ (document.querySelector("[data-view-root]"));
  const isAdmin = main.dataset.admin === "1";
  /** Rótulos vêm do catálogo de canais da API: canal novo (marketplace ou loja) aparece sem mexer na tela. */
  const CHANNEL_LABELS = /** @type {Record<string, string>} */ ({});
  const KIND_TITLES = /** @type {Record<string, [string, string]>} */ ({
    marketplace: ["Marketplaces", "Você será levado ao marketplace para autorizar o acesso do DACH Hub e voltará para cá."],
    store: ["Lojas virtuais", "Informe os dados de acesso da sua loja. O DACH Hub confere antes de salvar."],
  });
  /** @type {Promise<any[]> | null} */
  let channelsPromise = null;
  const loadChannels = () => (channelsPromise ||= api("/channels").then(({ channels }) => {
    for (const c of channels) CHANNEL_LABELS[c.id] = c.label;
    return channels;
  }));

  /** @param {unknown} value */
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
  const int = (/** @type {unknown} */ v) => new Intl.NumberFormat("pt-BR").format(Number(v) || 0);

  /** @param {string} path @param {RequestInit} [init] */
  async function api(path, init) {
    const response = await fetch(`/hub/api${path}`, { credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, ...init });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.message || "Não foi possível carregar agora.");
    return data;
  }

  /** @param {string} title @param {string} text @param {string} [action] */
  const empty = (title, text, action = "") => `<div class="seller-card"><div class="seller-empty"><strong>${esc(title)}</strong><span>${esc(text)}</span>${action}</div></div>`;

  async function renderOverview() {
    const { overview: o } = await api("/overview");
    root.innerHTML = `
      <section class="seller-grid">
        <article class="seller-kpi"><span>Produtos</span><strong>${int(o?.items)}</strong><small>SKUs DACH no catálogo</small></article>
        <article class="seller-kpi"><span>Anúncios</span><strong>${int(o?.listings)}</strong><small>em ${int(o?.accounts)} conta(s) conectada(s)</small></article>
        <article class="seller-kpi"><span>Vinculados</span><strong>${int(o?.linked)}</strong><small>ligados a um produto</small></article>
        <article class="seller-kpi"><span>Sem vínculo</span><strong>${int(o?.unlinked)}</strong><small>${int(o?.with_suggestion)} com sugestão</small></article>
      </section>
      ${Number(o?.accounts) ? "" : empty("Nenhuma conta conectada ainda", "Conecte seus marketplaces e lojas virtuais para importar os anúncios.", '<a class="seller-btn seller-btn--primary" href="/hub/contas">Ver contas</a>')}`;
  }

  async function renderItems() {
    const { items } = await api("/items");
    if (!items.length) { root.innerHTML = empty("Nenhum produto no catálogo", "Os produtos aparecem aqui depois da primeira importação de anúncios."); return; }
    root.innerHTML = `<section class="seller-card"><h2>Produtos</h2><p>Cada linha é um SKU DACH com os anúncios ligados a ele.</p>
      <div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>SKU</th><th>Produto</th><th>Anúncios</th></tr></thead><tbody>
      ${items.map((/** @type {any} */ item) => `<tr><td><strong>${esc(item.sku)}</strong></td><td>${esc(item.name || "—")}</td><td>${(item.listings || []).map((/** @type {any} */ l) => `<span class="seller-badge" title="${esc(l.account)}">${esc(CHANNEL_LABELS[l.channel] || l.channel)}${l.fulfillment ? " · Full" : ""}</span>`).join(" ") || "—"}</td></tr>`).join("")}
      </tbody></table></div></section>`;
  }

  async function renderPending() {
    const { listings } = await api("/pending");
    if (!listings.length) { root.innerHTML = empty("Nenhuma pendência", "Todos os anúncios importados estão ligados a um produto."); return; }
    root.innerHTML = `<section class="seller-card"><h2>Anúncios sem vínculo</h2><p>Vincule cada anúncio ao produto certo para a venda baixar o estoque.</p>
      <div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>Canal</th><th>Anúncio</th><th>SKU no canal</th><th>Sugestão</th><th></th></tr></thead><tbody>
      ${listings.map((/** @type {any} */ l) => `<tr><td><span class="seller-badge">${esc(CHANNEL_LABELS[l.channel] || l.channel)}</span></td><td>${esc(l.title || l.listingId)}<br><small>${esc(l.listingId)}${l.variationId ? ` · ${esc(l.variationId)}` : ""}</small></td><td>${esc(l.channelSku || "sem SKU")}</td>
        <td>${l.suggestionItemId ? `<span class="seller-badge" data-tone="accent">${esc(l.suggestionSku)}</span> ${esc(l.suggestionName || "")}` : "—"}</td>
        <td>${isAdmin && l.suggestionItemId ? `<button class="seller-btn" type="button" data-link="${esc(l.id)}" data-item="${esc(l.suggestionItemId)}">Vincular</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div></section>`;
  }

  const CONNECT_ERRORS = /** @type {Record<string, string>} */ ({
    admin_required: "Somente o administrador da empresa pode conectar contas.",
    channel_not_configured: "Este marketplace ainda não tem o app do DACH Hub configurado.",
    authorization_denied: "A autorização foi cancelada no marketplace.",
    callback_incomplete: "O marketplace não devolveu os dados da conexão. Tente de novo.",
    invalid_state: "O link de conexão expirou. Tente conectar de novo.",
    account_owned_by_other_tenant: "Esta conta do marketplace já está conectada a outra empresa no DACH Hub.",
  });
  const STATUS = /** @type {Record<string, [string, string]>} */ ({
    connected: ["Conectada", "success"],
    reconnect_required: ["Reconectar", "danger"],
  });
  const dateTime = (/** @type {string} */ v) => v ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(v)) : "—";

  /** Andamento da última importação da conta (texto curto para a tabela). @param {any} run */
  function importCell(run) {
    if (!run) return '<span class="hub-muted">Ainda não importada</span>';
    if (run.status === "queued") return '<span class="seller-badge" data-tone="warning">Na fila</span>';
    if (run.status === "running") return `<span class="seller-badge" data-tone="warning">Importando…</span><br><small>${int(run.listingsSeen)} anúncio(s) · ${int(run.pages)} página(s)</small>`;
    if (run.status === "failed") return `<span class="seller-badge" data-tone="danger">Falhou</span><br><small title="${esc(run.error)}">${esc(String(run.error || "").slice(0, 80))}</small>`;
    return `<span class="seller-badge" data-tone="success">Concluída</span><br><small>${esc(dateTime(run.finishedAt))} · ${int(run.listingsSeen)} anúncio(s), ${int(run.unlinked)} sem vínculo</small>`;
  }

  /** Enquanto houver importação ativa, a tela de Contas se atualiza sozinha. */
  /** @type {number | null} */
  let pollTimer = null;
  /** @param {any[]} accounts */
  function schedulePoll(accounts) {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = null;
    const active = accounts.some((a) => a.lastImport && (a.lastImport.status === "queued" || a.lastImport.status === "running"));
    if (active && main.dataset.view === "accounts") pollTimer = window.setTimeout(() => { renderAccounts().catch(() => {}); }, 4000);
  }

  async function renderAccounts() {
    const [channels, { accounts }] = await Promise.all([loadChannels(), api("/accounts")]);
    const byId = Object.fromEntries(channels.map((/** @type {any} */ c) => [c.id, c]));
    const params = new URLSearchParams(location.search);
    const connected = params.get("conectado"), error = params.get("erro");
    const flash = connected
      ? `<div class="hub-flash" data-tone="success">Conta ${esc(CHANNEL_LABELS[connected] || connected)} conectada. A importação dos anúncios começa em modo observação.</div>`
      : error ? `<div class="hub-flash" data-tone="danger">${esc(CONNECT_ERRORS[error] || "Não foi possível conectar a conta. Tente de novo.")}</div>` : "";
    const rows = accounts.map((/** @type {any} */ a) => {
      const [label, tone] = STATUS[a.status] || [a.status, "warning"];
      const importing = a.lastImport && (a.lastImport.status === "queued" || a.lastImport.status === "running");
      const canImport = a.status === "connected" && byId[a.channel]?.capabilities?.listings;
      const actions = isAdmin
        ? `${canImport ? `<button class="seller-btn seller-btn--primary" type="button" data-import="${esc(a.id)}" ${importing ? "disabled" : ""}>${importing ? "Importando…" : "Importar agora"}</button> ` : ""}${a.status === "reconnect_required" && byId[a.channel]?.auth === "oauth" ? `<a class="seller-btn seller-btn--primary" href="/hub/auth/${esc(a.channel)}/start">Reconectar</a> ` : ""}<button class="seller-btn" type="button" data-disconnect="${esc(a.id)}">Desconectar</button>`
        : "";
      return `<tr><td><span class="seller-badge">${esc(CHANNEL_LABELS[a.channel] || a.channel)}</span></td><td><strong>${esc(a.label || a.externalAccountId)}</strong><br><small>${esc(a.externalAccountId)}</small></td>
        <td><span class="seller-badge" data-tone="${tone}">${esc(label)}</span></td><td>${int(a.listings)}</td><td>${importCell(a.lastImport)}</td><td><div class="hub-actions">${actions}</div></td></tr>`;
    }).join("");
    root.innerHTML = `${flash}
      <section class="seller-card"><h2>Contas conectadas</h2><p>Contas ligadas direto ao DACH Hub. A mesma conta pode estar também num módulo DACH; são conexões separadas.</p>
        ${accounts.length ? `<div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>Canal</th><th>Conta</th><th>Situação</th><th>Anúncios</th><th>Importação</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<div class="seller-empty"><strong>Nenhuma conta conectada</strong><span>Conecte abaixo seus marketplaces e lojas virtuais.</span></div>'}
      </section>
      ${Object.entries(KIND_TITLES).map(([kind, [title, text]]) => {
        const group = channels.filter((/** @type {any} */ c) => c.kind === kind);
        return group.length ? `<section class="seller-card"><h2>${esc(title)}</h2><p>${esc(text)}</p><div class="hub-connect-grid">${group.map(connectCard).join("")}</div></section>` : "";
      }).join("")}`;
    schedulePoll(accounts);
  }

  /** Cartão de conexão: botão de OAuth ou formulário de credenciais (lojas virtuais). @param {any} c */
  function connectCard(c) {
    let body;
    if (!c.available) body = '<span class="seller-badge" data-tone="warning">Aguardando app do canal</span>';
    else if (!isAdmin) body = '<span class="seller-badge">Só o administrador conecta</span>';
    else if (c.auth === "credentials") {
      body = `<form class="hub-connect-form" data-connect-form="${esc(c.id)}">${(c.credentialFields || []).map((/** @type {any} */ f) =>
        `<label><span>${esc(f.label)}</span><input name="${esc(f.name)}" type="${f.type === "password" ? "password" : f.type === "url" ? "url" : "text"}" placeholder="${esc(f.placeholder)}" autocomplete="off" required></label>`).join("")}
        <button class="seller-btn seller-btn--primary" type="submit">Conectar ${esc(c.label)}</button><small data-connect-error></small></form>`;
    } else body = `<a class="seller-btn seller-btn--primary" href="/hub/auth/${esc(c.id)}/start">Conectar ${esc(c.label)}</a>`;
    return `<article class="hub-connect"><strong>${esc(c.label)}</strong>${body}</article>`;
  }

  root.addEventListener("submit", async (event) => {
    const form = /** @type {HTMLFormElement} */ (event.target).closest("[data-connect-form]");
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    const channel = form.getAttribute("data-connect-form");
    const error = /** @type {HTMLElement} */ (form.querySelector("[data-connect-error]"));
    form.setAttribute("aria-busy", "true");
    error.textContent = "";
    try {
      await api(`/channels/${channel}/connect`, { method: "POST", body: JSON.stringify(Object.fromEntries(/** @type {any} */ (new FormData(form)))) });
      history.replaceState(null, "", `/hub/contas?conectado=${encodeURIComponent(channel || "")}`);
      await renderAccounts();
    } catch (err) {
      error.textContent = /** @type {Error} */ (err).message;
    } finally {
      form.removeAttribute("aria-busy");
    }
  });

  root.addEventListener("click", async (event) => {
    const button = /** @type {HTMLButtonElement | null} */ (/** @type {HTMLElement} */ (event.target).closest("[data-import]"));
    if (!button) return;
    button.disabled = true;
    button.textContent = "Importando…";
    try {
      await api(`/accounts/${button.getAttribute("data-import")}/import`, { method: "POST" });
      await renderAccounts();
    } catch (error) {
      button.disabled = false;
      button.textContent = /** @type {Error} */ (error).message;
    }
  });

  root.addEventListener("click", async (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest("[data-disconnect]");
    if (!button) return;
    if (!confirm("Desconectar esta conta do DACH Hub? Os tokens serão apagados e a sincronização para.")) return;
    try {
      await api(`/accounts/${button.getAttribute("data-disconnect")}/disconnect`, { method: "POST" });
      history.replaceState(null, "", "/hub/contas");
      await renderAccounts();
    } catch (error) {
      button.textContent = /** @type {Error} */ (error).message;
    }
  });

  root.addEventListener("click", async (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest("[data-link]");
    if (!button) return;
    button.setAttribute("aria-busy", "true");
    try {
      await api(`/listings/${button.getAttribute("data-link")}/link`, { method: "POST", body: JSON.stringify({ itemId: Number(button.getAttribute("data-item")) }) });
      await renderPending();
    } catch (error) {
      button.textContent = /** @type {Error} */ (error).message;
    }
  });

  const views = /** @type {Record<string, () => Promise<void>>} */ ({ overview: renderOverview, items: renderItems, pending: renderPending, accounts: renderAccounts });
  // Views de outros arquivos (hub-stock.js) recebem as mesmas ferramentas.
  const kit = { api, esc, int, dateTime, empty, root, main, isAdmin, loadChannels, CHANNEL_LABELS };
  for (const [name, factory] of Object.entries(/** @type {any} */ (window).DachHubViews || {})) views[name] = factory(kit);
  // Status da barra superior: pausa, alertas, envio ativo ou observação.
  async function refreshStatus() {
    const chip = /** @type {HTMLElement | null} */ (document.querySelector('a.seller-shell__chip[href="/hub/saude"]'));
    const alertsApi = /** @type {any} */ (window).DachHubAlerts;
    if (!chip || !alertsApi) return;
    const { accounts, settings } = await api("/health/accounts");
    const alerts = alertsApi.computeAlerts(accounts, settings, CHANNEL_LABELS);
    const danger = alerts.filter((/** @type {any} */ a) => a.tone === "danger").length;
    const [label, tone] = settings.paused ? ["Envios pausados", "danger"]
      : danger ? [`Atenção (${alerts.length})`, "danger"]
        : alerts.length ? [`Alertas (${alerts.length})`, "warning"]
          : accounts.some((/** @type {any} */ a) => a.mode === "active") ? ["Envio ativo", "success"] : ["Modo observação", "success"];
    chip.setAttribute("data-tone", tone);
    const dot = chip.querySelector(".seller-shell__dot");
    chip.textContent = label;
    if (dot) chip.prepend(dot);
  }

  const view = views[main.dataset.view || "overview"] || renderOverview;
  loadChannels().catch(() => []).then(() => { refreshStatus().catch(() => {}); return view(); }).catch((error) => {
    root.innerHTML = empty("Não foi possível carregar", /** @type {Error} */ (error).message);
  });
})();
