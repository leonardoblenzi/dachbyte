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
  /* ───────────── Alertas (Saúde e status da barra superior) ───────────── */
  const HOUR = 3600e3;
  /**
   * Alertas a partir da saúde das contas. tone: danger (agir já) ou warning (olhar).
   * @param {any[]} accounts @param {any} settings @param {Record<string, string>} labels @param {any} [attention]
   */
  function computeAlerts(accounts, settings, labels, attention) {
    /** @type {Array<{ tone: string, text: string, href: string }>} */
    const alerts = [];
    if (settings?.paused) alerts.push({ tone: "danger", text: "Envios de estoque pausados: nada é enviado aos canais.", href: "/hub/estoque/regras" });
    for (const a of accounts) {
      const name = `${labels[a.channel] || a.channel} · ${a.label}`;
      if (a.status === "reconnect_required") alerts.push({ tone: "danger", text: `${name}: conexão expirou. Reconecte a conta.`, href: "/hub/contas" });
      if (a.divergencesRecurring) alerts.push({ tone: "danger", text: `${name}: ${a.divergencesRecurring} anúncio(s) com estoque mudando fora do Hub várias vezes. Outro sistema pode estar escrevendo estoque nesta conta.`, href: `/hub/estoque/divergencias?account=${a.id}` });
      else if (a.divergencesOpen) alerts.push({ tone: "warning", text: `${name}: ${a.divergencesOpen} divergência(s) de estoque para decidir.`, href: `/hub/estoque/divergencias?account=${a.id}` });
      if (a.pushesFailed24h || a.pushesDivergent24h) alerts.push({ tone: "warning", text: `${name}: ${a.pushesFailed24h} envio(s) com falha e ${a.pushesDivergent24h} divergente(s) nas últimas 24h.`, href: `/hub/estoque/envios?account=${a.id}` });
      if (a.pendingSales) alerts.push({ tone: "warning", text: `${name}: ${a.pendingSales} venda(s) sem vínculo não baixaram estoque.`, href: "/hub/pedidos?pendentes=1" });
      if (a.mode === "active" && a.status === "connected" && !a.webhooks24h) alerts.push({ tone: "warning", text: `${name}: nenhum aviso de pedido nas últimas 24h. Confira o webhook do app no canal (a leitura a cada 10 min continua).`, href: "/hub/saude" });
      if (a.webhookFailures24h) alerts.push({ tone: "warning", text: `${name}: ${a.webhookFailures24h} aviso(s) de pedido falharam ao processar nas últimas 24h.`, href: "/hub/pedidos" });
      if (a.lastRun?.status === "failed") alerts.push({ tone: "warning", text: `${name}: a última conferência falhou (${a.lastRun.error || "erro"}).`, href: "/hub/saude" });
      if (a.mode === "active" && a.lastReconciledAt && Date.now() - Date.parse(a.lastReconciledAt) > 12 * HOUR) alerts.push({ tone: "warning", text: `${name}: estoque não é conferido há mais de 12h.`, href: "/hub/saude" });
    }
    if (attention?.itemsLowStock) alerts.push({ tone: "warning", text: `${attention.itemsLowStock} produto(s) com estoque baixo (disponível até ${attention.threshold}).`, href: "/hub/estoque?filtro=low" });
    if (attention?.itemsZero) alerts.push({ tone: "warning", text: `${attention.itemsZero} produto(s) zerados no estoque do Hub.`, href: "/hub/estoque?filtro=zero" });
    return alerts;
  }
  /** @type {any} */ (window).DachHubAlerts = { computeAlerts };

  const MODE_LABELS = /** @type {Record<string, [string, string]>} */ ({ off: ["Desligado", ""], observe: ["Observação", "accent"], active: ["Ativo", "success"] });

  /* ───────────── Saúde das contas ───────────── */
  registry.health = (kit) => {
    const { api, esc, int, root, isAdmin, empty, dateTime, CHANNEL_LABELS } = kit;
    let bound = false;
    /** @type {number | null} */
    let timer = null;

    /** @param {string} label @param {string} value @param {string} [tone] */
    const metric = (label, value, tone = "") => `<div class="hub-metric" ${tone ? `data-tone="${tone}"` : ""}><span>${esc(label)}</span><strong>${value}</strong></div>`;

    async function render() {
      const { accounts, settings, attention } = await api("/health/accounts");
      if (!accounts.length) { root.innerHTML = empty("Nenhuma conta conectada", "Conecte uma conta para acompanhar a saúde da integração.", '<a class="seller-btn seller-btn--primary" href="/hub/contas">Ver contas</a>'); return; }
      const alerts = computeAlerts(accounts, settings, CHANNEL_LABELS, attention);
      const running = accounts.some((/** @type {any} */ a) => a.lastRun && (a.lastRun.status === "queued" || a.lastRun.status === "running"));
      root.innerHTML = `
        <section class="seller-card"><h2>Alertas</h2>
          ${alerts.length ? `<ul class="hub-alerts">${alerts.map((al) => `<li data-tone="${al.tone}"><a href="${esc(al.href)}">${esc(al.text)}</a></li>`).join("")}</ul>`
            : '<p class="hub-ok">Tudo em ordem: conexões ativas, sem divergências abertas e sem falhas de envio nas últimas 24h.</p>'}
        </section>
        ${accounts.map((/** @type {any} */ a) => {
          const [modeLabel, modeTone] = MODE_LABELS[a.mode] || [a.mode, ""];
          const run = a.lastRun;
          const runText = !run ? "Nunca" : run.status === "queued" ? "Na fila" : run.status === "running" ? `Conferindo… ${int(run.checked)}` : run.status === "failed" ? "Falhou" : `${dateTime(run.finishedAt)} · ${int(run.checked)} anúncio(s)`;
          const expiresIn = a.tokenExpiresAt ? Date.parse(a.tokenExpiresAt) - Date.now() : null;
          return `<section class="seller-card">
            <div class="hub-account-head"><div><span class="seller-badge">${esc(CHANNEL_LABELS[a.channel] || a.channel)}</span> <strong>${esc(a.label)}</strong>
              <span class="seller-badge" ${modeTone ? `data-tone="${modeTone}"` : ""}>${esc(modeLabel)}</span>${a.status === "reconnect_required" ? ' <span class="seller-badge" data-tone="danger">Reconectar</span>' : ""}</div>
              ${isAdmin ? `<div class="hub-actions"><button class="seller-btn" type="button" data-reconcile="${esc(a.id)}" ${run && (run.status === "queued" || run.status === "running") ? "disabled" : ""}>Conferir agora</button>
                <a class="seller-btn" href="/hub/estoque/divergencias?account=${esc(a.id)}">Divergências</a></div>` : ""}</div>
            <div class="hub-metrics">
              ${metric("Conexão", a.status === "connected" ? (expiresIn != null && expiresIn < 0 ? "Renova no próximo uso" : "Ativa") : "Expirada", a.status === "connected" ? "" : "danger")}
              ${metric("Última importação", esc(dateTime(a.lastImportAt)))}
              ${metric("Pedidos lidos até", esc(dateTime(a.ordersSyncedAt)))}
              ${metric("Avisos de pedido (24h)", `${int(a.webhooks24h)}${a.webhookFailures24h ? ` · ${int(a.webhookFailures24h)} falha(s)` : ""}`, a.webhookFailures24h ? "warning" : "")}
              ${metric("Última conferência", esc(runText), run?.status === "failed" ? "danger" : "")}
              ${metric("Divergências abertas", `${int(a.divergencesOpen)}${a.divergencesRecurring ? ` · ${int(a.divergencesRecurring)} recorrente(s)` : ""}`, a.divergencesRecurring ? "danger" : a.divergencesOpen ? "warning" : "")}
              ${metric("Envios (24h)", `${int(a.pushesOpen)} na fila · ${int(a.pushesFailed24h)} falha(s) · ${int(a.pushesDivergent24h)} divergente(s)`, a.pushesFailed24h ? "warning" : "")}
              ${metric("Vendas sem vínculo", int(a.pendingSales), a.pendingSales ? "warning" : "")}
            </div>
            ${a.mode === "active" ? `<form class="hub-toolbar hub-policy" data-policy="${esc(a.id)}"><label>Quando o estoque mudar fora do Hub:
              <select name="policy" ${isAdmin ? "" : "disabled"}><option value="overwrite" ${a.policy === "overwrite" ? "selected" : ""}>Reenviar o valor do Hub</option><option value="alert" ${a.policy === "alert" ? "selected" : ""}>Só avisar</option></select></label>
              <small>Se o mesmo anúncio mudar por fora várias vezes em 24h, o Hub para de reenviar e só avisa.</small></form>` : ""}
          </section>`;
        }).join("")}`;
      if (timer) window.clearTimeout(timer);
      timer = running ? window.setTimeout(() => { render().catch(() => {}); }, 4000) : null;
    }

    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("click", async (event) => {
        const button = /** @type {HTMLButtonElement | null} */ (/** @type {HTMLElement} */ (event.target).closest("[data-reconcile]"));
        if (!button) return;
        button.disabled = true;
        try { await api(`/accounts/${button.getAttribute("data-reconcile")}/reconcile`, { method: "POST" }); await render(); }
        catch (error) { button.textContent = /** @type {Error} */ (error).message; }
      });
      root.addEventListener("change", async (event) => {
        const select = /** @type {HTMLSelectElement} */ (event.target);
        const form = select.closest("[data-policy]");
        if (!form) return;
        await api(`/accounts/${form.getAttribute("data-policy")}/divergence-policy`, { method: "PUT", body: JSON.stringify({ policy: select.value }) });
        await render();
      });
    }
    return async () => { bind(); await render(); };
  };

  /* ───────────── Divergências ───────────── */
  registry.divergences = (kit) => {
    const { api, esc, int, root, isAdmin, empty, dateTime, CHANNEL_LABELS } = kit;
    const query = new URLSearchParams(location.search);
    const state = { status: "open", accountId: query.get("account") || "", offset: 0 };
    const STATUS = /** @type {Record<string, [string, string]>} */ ({ open: ["Aberta", "warning"], overwritten: ["Reenviado o valor do Hub", "success"], ignored: ["Ignorada", ""], resolved: ["Resolvida", "success"] });
    let bound = false;

    async function render() {
      const params = new URLSearchParams({ status: state.status, limit: String(PAGE), offset: String(state.offset) });
      if (state.accountId) params.set("accountId", state.accountId);
      const [{ divergences }, { accounts }] = await Promise.all([api(`/divergences?${params}`), api("/stock/rules")]);
      const toolbar = `<form class="hub-toolbar" data-div-filter>
        <select name="status"><option value="open" ${state.status === "open" ? "selected" : ""}>Abertas</option><option value="overwritten" ${state.status === "overwritten" ? "selected" : ""}>Reenviadas</option><option value="ignored" ${state.status === "ignored" ? "selected" : ""}>Ignoradas</option><option value="" ${state.status === "" ? "selected" : ""}>Todas</option></select>
        <select name="accountId"><option value="">Todas as contas</option>${accounts.map((/** @type {any} */ a) => `<option value="${esc(a.id)}" ${String(a.id) === state.accountId ? "selected" : ""}>${esc(CHANNEL_LABELS[a.channel] || a.channel)} · ${esc(a.label)}</option>`).join("")}</select>
        <button class="seller-btn" type="submit">Filtrar</button>
        ${isAdmin && state.accountId && state.status === "open" && divergences.length ? `<span class="hub-toolbar__spacer"></span><button class="seller-btn" type="button" data-ignore-all="${esc(state.accountId)}">Ignorar todas desta conta</button>` : ""}
      </form>`;
      if (!divergences.length && !state.offset) {
        root.innerHTML = `<section class="seller-card"><p>O Hub confere o estoque nos canais a cada 3 horas. Divergência = valor no canal que vendas e envios do Hub não explicam (alguém mexeu por fora).</p>${toolbar}
          <div class="seller-empty"><strong>Nenhuma divergência com este filtro</strong></div></section>`;
        return;
      }
      root.innerHTML = `<section class="seller-card">
        <p>Divergência = o canal mostra um valor que vendas e envios do Hub não explicam. Normalmente é outro sistema (Tray, ANYMARKET, Bling) ou alguém mexendo no painel do canal. <strong>Recorrente</strong> = o mesmo anúncio várias vezes em 24h.</p>
        ${toolbar}
        <div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>Quando</th><th>Canal</th><th>Anúncio</th><th class="hub-num">Esperado</th><th class="hub-num">No canal</th><th>Situação</th><th></th></tr></thead><tbody>
        ${divergences.map((/** @type {any} */ d) => {
          const [label, tone] = STATUS[d.status] || [d.status, ""];
          const diff = Number(d.observed) - Number(d.expected);
          return `<tr><td>${esc(dateTime(d.detectedAt))}</td>
            <td><span class="seller-badge">${esc(CHANNEL_LABELS[d.channel] || d.channel)}</span><br><small>${esc(d.account)}</small></td>
            <td>${esc(d.sku || "")} · ${esc(d.title || d.listingId)}<br><small>${esc(d.listingId)}${d.variationId ? ` · ${esc(d.variationId)}` : ""}</small></td>
            <td class="hub-num">${int(d.expected)}</td><td class="hub-num"><strong>${int(d.observed)}</strong><br><small>${diff > 0 ? "+" : ""}${int(diff)}</small></td>
            <td><span class="seller-badge" ${tone ? `data-tone="${tone}"` : ""}>${esc(label)}</span>${d.recurring ? ' <span class="seller-badge" data-tone="danger">Recorrente</span>' : ""}</td>
            <td>${isAdmin && d.status === "open" ? `<div class="hub-actions">${d.accountMode === "active" ? `<button class="seller-btn seller-btn--primary" type="button" data-resolve="${esc(d.id)}" data-action="resend">Reenviar valor do Hub</button>` : ""}
              <button class="seller-btn" type="button" data-resolve="${esc(d.id)}" data-action="ignore">Ignorar</button></div>` : ""}</td></tr>`;
        }).join("")}</tbody></table></div>
        <div class="hub-pager"><button class="seller-btn" type="button" data-page="${Math.max(0, state.offset - PAGE)}" ${state.offset ? "" : "disabled"}>Anterior</button>
          <button class="seller-btn" type="button" data-page="${state.offset + PAGE}" ${divergences.length === PAGE ? "" : "disabled"}>Próxima</button></div></section>`;
    }

    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("submit", async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (!form.matches("[data-div-filter]")) return;
        event.preventDefault();
        const data = new FormData(form);
        Object.assign(state, { status: String(data.get("status") ?? "open"), accountId: String(data.get("accountId") || ""), offset: 0 });
        await render();
      });
      root.addEventListener("click", async (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        const page = target.closest("[data-page]");
        if (page) { state.offset = Number(page.getAttribute("data-page")) || 0; await render(); return; }
        const all = target.closest("[data-ignore-all]");
        if (all) {
          if (!confirm("Ignorar todas as divergências abertas desta conta?")) return;
          await api(`/accounts/${all.getAttribute("data-ignore-all")}/divergences/ignore-all`, { method: "POST" });
          await render();
          return;
        }
        const resolve = target.closest("[data-resolve]");
        if (!resolve) return;
        try {
          await api(`/divergences/${resolve.getAttribute("data-resolve")}/resolve`, { method: "POST", body: JSON.stringify({ action: resolve.getAttribute("data-action") }) });
          await render();
        } catch (error) { resolve.textContent = /** @type {Error} */ (error).message; }
      });
    }
    return async () => { bind(); await render(); };
  };
})();
