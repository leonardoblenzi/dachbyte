// @ts-check
(function () {
  "use strict";

  const shellApi = /** @type {any} */ (window).DachSellerShell;
  shellApi.mount({
    product: "hub",
    theme: "violet",
    basePath: "/hub",
    brand: { name: "DACHBYTE", sub: "Hub · Marketplaces", logo: "/brand/dachbyte/hub/mark.svg", href: "/hub/" },
    navGroups: [
      { id: "overview", label: "Visão geral", hint: "Painel e saúde", icon: "dashboard", items: [{ label: "Painel", path: "/hub/" }] },
      { id: "catalog", label: "Catálogo", hint: "Produtos e vínculos", icon: "package", items: [
        { label: "Produtos", path: "/hub/catalogo" },
        { label: "Pendências", path: "/hub/pendencias" },
      ] },
      { id: "account", label: "Conta", hint: "Acesso e integrações", icon: "user", items: [{ label: "Contas conectadas", path: "/hub/contas" }] },
    ],
    footNote: "Catálogo, estoque, pedidos e preços de todos os canais em um só fluxo.",
    status: { label: "Modo observação", tone: "success", href: "/hub/contas" },
    links: [{ label: "Módulos", href: "/selecao-plataforma", icon: "dashboard" }],
  });

  const main = /** @type {HTMLElement} */ (document.querySelector("[data-shell-content]"));
  const root = /** @type {HTMLElement} */ (document.querySelector("[data-view-root]"));
  const isAdmin = main.dataset.admin === "1";
  const CHANNEL_LABELS = /** @type {Record<string, string>} */ ({ mercadolivre: "Mercado Livre", magalu: "Magalu", shopee: "Shopee" });

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
      ${Number(o?.accounts) ? "" : empty("Nenhuma conta conectada ainda", "Conecte suas contas do Mercado Livre, Magalu e Shopee para importar os anúncios.", '<a class="seller-btn seller-btn--primary" href="/hub/contas">Ver contas</a>')}`;
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

  async function renderAccounts() {
    const [{ channels }, { accounts }] = await Promise.all([api("/channels"), api("/accounts")]);
    const params = new URLSearchParams(location.search);
    const connected = params.get("conectado"), error = params.get("erro");
    const flash = connected
      ? `<div class="hub-flash" data-tone="success">Conta ${esc(CHANNEL_LABELS[connected] || connected)} conectada. A importação dos anúncios começa em modo observação.</div>`
      : error ? `<div class="hub-flash" data-tone="danger">${esc(CONNECT_ERRORS[error] || "Não foi possível conectar a conta. Tente de novo.")}</div>` : "";
    const rows = accounts.map((/** @type {any} */ a) => {
      const [label, tone] = STATUS[a.status] || [a.status, "warning"];
      const actions = isAdmin
        ? `${a.status === "reconnect_required" ? `<a class="seller-btn seller-btn--primary" href="/hub/auth/${esc(a.channel)}/start">Reconectar</a> ` : ""}<button class="seller-btn" type="button" data-disconnect="${esc(a.id)}">Desconectar</button>`
        : "";
      return `<tr><td><span class="seller-badge">${esc(CHANNEL_LABELS[a.channel] || a.channel)}</span></td><td><strong>${esc(a.label || a.externalAccountId)}</strong><br><small>${esc(a.externalAccountId)}</small></td>
        <td><span class="seller-badge" data-tone="${tone}">${esc(label)}</span></td><td>${int(a.listings)}</td><td>${esc(dateTime(a.connectedAt))}</td><td>${actions}</td></tr>`;
    }).join("");
    root.innerHTML = `${flash}
      <section class="seller-card"><h2>Contas conectadas</h2><p>Contas ligadas direto ao DACH Hub. A mesma conta pode estar também num módulo DACH; são conexões separadas.</p>
        ${accounts.length ? `<div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>Canal</th><th>Conta</th><th>Situação</th><th>Anúncios</th><th>Conectada em</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<div class="seller-empty"><strong>Nenhuma conta conectada</strong><span>Conecte abaixo as contas do Mercado Livre, Magalu e Shopee.</span></div>'}
      </section>
      <section class="seller-card"><h2>Conectar marketplace</h2><p>Você será levado ao marketplace para autorizar o acesso do DACH Hub e voltará para cá.</p>
        <div class="hub-connect-grid">${channels.map((/** @type {any} */ c) => `<article class="hub-connect"><strong>${esc(c.label)}</strong>
          ${c.available ? (isAdmin ? `<a class="seller-btn seller-btn--primary" href="/hub/auth/${esc(c.id)}/start">Conectar ${esc(c.label)}</a>` : '<span class="seller-badge">Só o administrador conecta</span>') : '<span class="seller-badge" data-tone="warning">Aguardando app do marketplace</span>'}
        </article>`).join("")}</div>
      </section>`;
  }

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
  (views[main.dataset.view || "overview"] || renderOverview)().catch((error) => {
    root.innerHTML = empty("Não foi possível carregar", /** @type {Error} */ (error).message);
  });
})();
