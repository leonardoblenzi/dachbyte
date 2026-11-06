// @ts-check
// Telas da E3 (Pedidos e Envios). Registra as views; o hub-app.js entrega as ferramentas (kit) e chama.
(function () {
  "use strict";

  const registry = /** @type {Record<string, (kit: any) => () => Promise<void>>} */ ((/** @type {any} */ (window).DachHubViews ||= {}));
  const PAGE = 50;

  const PUSH_STATES = /** @type {Record<string, [string, string]>} */ ({
    pending: ["Na fila", "warning"], sending: ["Enviando", "warning"], verified: ["Conferido", "success"],
    divergent: ["Divergente", "danger"], failed: ["Falhou", "danger"], skipped: ["Cancelado", ""],
  });

  /* ───────────── Pedidos ───────────── */
  registry.orders = (kit) => {
    const { api, esc, int, root, empty, dateTime, CHANNEL_LABELS } = kit;
    const state = { pendingOnly: new URLSearchParams(location.search).get("pendentes") === "1", offset: 0 };
    let bound = false;

    async function render() {
      const params = new URLSearchParams({ limit: String(PAGE + 1), offset: String(state.offset) });
      if (state.pendingOnly) params.set("pending", "1");
      const { orders } = await api(`/orders?${params}`);
      const hasMore = orders.length > PAGE;
      const list = orders.slice(0, PAGE);
      const toolbar = `<form class="hub-toolbar" data-orders-filter><label class="hub-check"><input type="checkbox" name="pending" ${state.pendingOnly ? "checked" : ""}> Só vendas sem vínculo</label><button class="seller-btn" type="submit">Filtrar</button></form>`;
      if (!list.length && !state.offset) {
        root.innerHTML = state.pendingOnly
          ? `<section class="seller-card">${toolbar}<div class="seller-empty"><strong>Nenhuma venda sem vínculo</strong><span>Toda venda recebida baixou o estoque do produto certo.</span></div></section>`
          : empty("Nenhum pedido recebido ainda", "Os pedidos chegam pelos avisos dos canais e por uma leitura de segurança a cada 10 minutos.");
        return;
      }
      root.innerHTML = `<section class="seller-card">
        <p>Cada venda baixa o estoque do produto; o cancelamento devolve. Venda Full não mexe no estoque central (fica no canal). Devolução física é ajuste manual em Estoque.</p>
        ${toolbar}
        <div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>Quando</th><th>Canal</th><th>Pedido</th><th>Itens</th><th>Estoque</th><th class="hub-num">Total</th></tr></thead><tbody>
        ${list.map((/** @type {any} */ o) => `<tr>
          <td>${esc(dateTime(o.orderedAt))}</td>
          <td><span class="seller-badge">${esc(CHANNEL_LABELS[o.channel] || o.channel)}</span><br><small>${esc(o.account)}</small></td>
          <td><strong>${esc(o.orderId)}</strong><br>${o.status === "cancelled" ? '<span class="seller-badge" data-tone="danger">Cancelado</span>' : `<small>${esc(o.channelStatus || "")}</small>`}${o.fulfillment ? ' <span class="seller-badge">Full</span>' : ""}</td>
          <td>${(o.lines || []).map((/** @type {any} */ l) => `${int(l.quantity)}× ${esc(l.sku || l.title || l.listingId)}`).join("<br>")}</td>
          <td>${(o.lines || []).map((/** @type {any} */ l) => l.pending ? `<span class="seller-badge" data-tone="danger">Sem vínculo</span> <a href="/hub/pendencias">vincular</a>`
            : l.returned ? '<span class="seller-badge">Devolvido</span>' : l.applied ? '<span class="seller-badge" data-tone="success">Baixado</span>' : '<span class="seller-badge">Sem baixa</span>').join("<br>")}</td>
          <td class="hub-num">${o.total == null ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(o.total)}</td></tr>`).join("")}
        </tbody></table></div>
        <div class="hub-pager"><button class="seller-btn" type="button" data-page="${Math.max(0, state.offset - PAGE)}" ${state.offset ? "" : "disabled"}>Anterior</button>
          <button class="seller-btn" type="button" data-page="${state.offset + PAGE}" ${hasMore ? "" : "disabled"}>Próxima</button></div></section>`;
    }

    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("submit", async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (!form.matches("[data-orders-filter]")) return;
        event.preventDefault();
        state.pendingOnly = new FormData(form).get("pending") === "on";
        state.offset = 0;
        await render();
      });
      root.addEventListener("click", async (event) => {
        const page = /** @type {HTMLElement} */ (event.target).closest("[data-page]");
        if (page) { state.offset = Number(page.getAttribute("data-page")) || 0; await render(); }
      });
    }
    return async () => { bind(); await render(); };
  };

  /* ───────────── Envios ───────────── */
  registry.pushes = (kit) => {
    const { api, esc, int, root, isAdmin, empty, dateTime, CHANNEL_LABELS } = kit;
    const query = new URLSearchParams(location.search);
    const state = { state: query.get("estado") || "", accountId: query.get("account") || "", offset: 0 };
    let bound = false;
    /** @type {number | null} */
    let timer = null;

    async function render() {
      const params = new URLSearchParams({ state: state.state, limit: String(PAGE), offset: String(state.offset) });
      if (state.accountId) params.set("accountId", state.accountId);
      const [{ pushes, summary }, { settings }] = await Promise.all([api(`/stock/pushes?${params}`), api("/stock/settings")]);
      const busy = (summary.pending || 0) + (summary.sending || 0);
      if (!pushes.length && !state.state && !state.offset && !busy) {
        root.innerHTML = `${settings.paused ? '<div class="hub-flash" data-tone="danger">Envios pausados. <a href="/hub/estoque/regras">Retomar em Regras por conta</a>.</div>' : ""}
          ${empty("Nenhum envio ainda", "Envios aparecem quando uma conta está em modo ativo e o estoque de um produto muda.", '<a class="seller-btn seller-btn--primary" href="/hub/estoque/regras">Regras por conta</a>')}`;
        return;
      }
      root.innerHTML = `
        ${settings.paused ? '<div class="hub-flash" data-tone="danger"><strong>Envios pausados.</strong> Os envios ficam na fila até retomar em <a href="/hub/estoque/regras">Regras por conta</a>.</div>' : ""}
        <section class="seller-grid">
          <article class="seller-kpi"><span>Na fila</span><strong>${int(busy)}</strong><small>aguardando ou enviando</small></article>
          <article class="seller-kpi"><span>Conferidos (24h)</span><strong>${int(summary.verified || 0)}</strong><small>gravados e relidos no canal</small></article>
          <article class="seller-kpi"><span>Divergentes (24h)</span><strong>${int(summary.divergent || 0)}</strong><small>o canal mostra outro valor</small></article>
          <article class="seller-kpi"><span>Falhas (24h)</span><strong>${int(summary.failed || 0)}</strong><small>recusados pelo canal</small></article>
        </section>
        <section class="seller-card">
          <form class="hub-toolbar" data-pushes-filter><select name="state"><option value="">Todos</option>${Object.entries(PUSH_STATES).map(([k, [label]]) => `<option value="${k}" ${state.state === k ? "selected" : ""}>${esc(label)}</option>`).join("")}</select><button class="seller-btn" type="submit">Filtrar</button></form>
          ${pushes.length ? `<div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>Quando</th><th>Canal</th><th>Anúncio</th><th class="hub-num">Antes</th><th class="hub-num">Enviado</th><th class="hub-num">Lido no canal</th><th>Situação</th><th></th></tr></thead><tbody>
          ${pushes.map((/** @type {any} */ p) => {
            const [label, tone] = PUSH_STATES[p.state] || [p.state, ""];
            return `<tr><td>${esc(dateTime(p.createdAt))}<br><small>${esc(p.reason || "")}</small></td>
              <td><span class="seller-badge">${esc(CHANNEL_LABELS[p.channel] || p.channel)}</span><br><small>${esc(p.account)}</small></td>
              <td>${esc(p.sku || "")} · ${esc(p.title || p.listingId)}<br><small>${esc(p.listingId)}${p.variationId ? ` · ${esc(p.variationId)}` : ""}</small></td>
              <td class="hub-num">${p.previous == null ? "—" : int(p.previous)}</td><td class="hub-num"><strong>${int(p.desired)}</strong></td>
              <td class="hub-num">${p.observed == null ? "—" : int(p.observed)}</td>
              <td><span class="seller-badge" ${tone ? `data-tone="${tone}"` : ""}>${esc(label)}</span>${p.attempts > 1 ? `<br><small>${int(p.attempts)} tentativas</small>` : ""}${p.error ? `<br><small title="${esc(p.error)}">${esc(String(p.error).slice(0, 90))}</small>` : ""}</td>
              <td>${isAdmin && (p.state === "failed" || p.state === "divergent") ? `<button class="seller-btn" type="button" data-retry="${esc(p.id)}">Reenviar</button>` : ""}</td></tr>`;
          }).join("")}</tbody></table></div>` : '<div class="seller-empty"><strong>Nada com este filtro</strong></div>'}
          <div class="hub-pager"><button class="seller-btn" type="button" data-page="${Math.max(0, state.offset - PAGE)}" ${state.offset ? "" : "disabled"}>Anterior</button>
            <button class="seller-btn" type="button" data-page="${state.offset + PAGE}" ${pushes.length === PAGE ? "" : "disabled"}>Próxima</button></div>
        </section>`;
      if (timer) window.clearTimeout(timer);
      timer = busy && !settings.paused ? window.setTimeout(() => { render().catch(() => {}); }, 5000) : null;
    }

    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("submit", async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (!form.matches("[data-pushes-filter]")) return;
        event.preventDefault();
        state.state = String(new FormData(form).get("state") || "");
        state.offset = 0;
        await render();
      });
      root.addEventListener("click", async (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        const page = target.closest("[data-page]");
        if (page) { state.offset = Number(page.getAttribute("data-page")) || 0; await render(); return; }
        const retry = target.closest("[data-retry]");
        if (!retry) return;
        try { await api(`/stock/pushes/${retry.getAttribute("data-retry")}/retry`, { method: "POST" }); await render(); }
        catch (error) { retry.textContent = /** @type {Error} */ (error).message; }
      });
    }
    return async () => { bind(); await render(); };
  };
})();
