// @ts-check
// Telas da E3 (Pedidos e Envios). Registra as views; o hub-app.js entrega as ferramentas (kit) e chama.
(function () {
  "use strict";

  const registry = /** @type {Record<string, (kit: any) => () => Promise<void>>} */ ((/** @type {any} */ (window).DachHubViews ||= {}));
  const PAGE = 50;
  /** Paginação com total. @param {any} kit @param {number} offset @param {number} total @param {number} size */
  function pager(kit, offset, total, size) {
    if (total <= size) return "";
    return `<div class="hub-pager"><button class="seller-btn" type="button" data-page="${Math.max(0, offset - size)}" ${offset ? "" : "disabled"}>Anterior</button>
      <span>${kit.int(offset + 1)}–${kit.int(Math.min(total, offset + size))} de ${kit.int(total)}</span>
      <button class="seller-btn" type="button" data-page="${offset + size}" ${offset + size < total ? "" : "disabled"}>Próxima</button></div>`;
  }

  const PUSH_STATES = /** @type {Record<string, [string, string]>} */ ({
    pending: ["Na fila", "warning"], sending: ["Enviando", "warning"], verified: ["Conferido", "success"],
    divergent: ["Divergente", "danger"], failed: ["Falhou", "danger"], skipped: ["Cancelado", ""],
  });

  /* ───────────── Pedidos (central) ───────────── */
  const STAGE_LABELS = /** @type {Record<string, [string, string]>} */ ({
    new: ["Novo", ""], paid: ["Pago", "accent"], invoiced: ["Faturado", "accent"], ready_to_ship: ["Pronto para envio", "warning"],
    shipped: ["Enviado", "success"], delivered: ["Entregue", "success"], cancelled: ["Cancelado", "danger"], returned: ["Devolvido", "danger"],
  });
  const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  /** @param {unknown} v */
  const money = (v) => (v == null ? "—" : BRL.format(Number(v)));
  /** @param {any} kit @param {string} stage */
  const stageBadge = (kit, stage) => { const [l, t] = STAGE_LABELS[stage] || [stage, ""]; return `<span class="seller-badge" ${t ? `data-tone="${t}"` : ""}>${kit.esc(l)}</span>`; };
  /** Prazo de envio: vermelho se venceu, amarelo se vence em 24h. @param {any} kit @param {any} o */
  function dueCell(kit, o) {
    if (!o.shipBy || !["new", "paid", "invoiced", "ready_to_ship"].includes(o.stage)) return '<span class="hub-muted">—</span>';
    const ms = Date.parse(o.shipBy) - Date.now();
    const tone = ms < 0 ? "danger" : ms < 24 * 3600e3 ? "warning" : "";
    return `<span class="seller-badge" ${tone ? `data-tone="${tone}"` : ""}>${ms < 0 ? "Atrasado · " : ""}${kit.esc(kit.dateTime(o.shipBy))}</span>`;
  }

  /** Selo do status interno e etiquetas (definidos em hub-automations.js). @param {any} kit @param {any} o */
  const statusAndTags = (kit, o) => {
    const auto = /** @type {any} */ (window).DachHubAuto;
    return auto ? `${auto.statusBadge(kit, o.customStatus, o.customStatusColor)} ${auto.tagsHtml(kit, o.tags)}` : "";
  };

  registry.orders = (kit) => {
    const { api, esc, int, root, empty, dateTime, CHANNEL_LABELS, isAdmin } = kit;
    /** @type {Set<string>} */
    const selected = new Set();
    const query = new URLSearchParams(location.search);
    const state = {
      stage: query.get("situacao") || "", accountId: query.get("account") || "", q: query.get("q") || "",
      from: query.get("de") || "", to: query.get("ate") || "", due: query.get("prazo") || "",
      pendingOnly: query.get("pendentes") === "1", customStatus: query.get("status") || "", tag: query.get("etiqueta") || "", offset: 0,
      message: "", tone: "success",
    };
    let bound = false;

    function params() {
      const p = new URLSearchParams({ limit: String(PAGE), offset: String(state.offset) });
      if (state.stage) p.set("stage", state.stage);
      if (state.accountId) p.set("accountId", state.accountId);
      if (state.q) p.set("q", state.q);
      if (state.from) p.set("from", `${state.from}T00:00:00-03:00`);
      if (state.to) p.set("to", `${state.to}T23:59:59-03:00`);
      if (state.due) p.set("due", state.due);
      if (state.pendingOnly) p.set("pending", "1");
      if (state.customStatus) p.set("customStatus", state.customStatus);
      if (state.tag) p.set("tag", state.tag);
      return p;
    }

    async function render() {
      const [{ orders, total, summary }, { accounts }, { statuses }, { rules }] = await Promise.all([
        api(`/orders?${params()}`), api("/stock/rules"), api("/automations/statuses").catch(() => ({ statuses: [] })), api("/automations/rules").catch(() => ({ rules: [] }))]);
      const manualRules = rules.filter((/** @type {any} */ r) => r.event === "manual" && r.active);
      for (const id of [...selected]) if (!orders.some((/** @type {any} */ o) => String(o.id) === id)) selected.delete(id);
      const s = summary || {};
      const chips = /** @type {Array<[string, string, number, string]>} */ ([
        ["stage", "paid", s.paid, "Pagos (a preparar)"], ["stage", "invoiced", s.invoiced, "Faturados"], ["stage", "ready_to_ship", s.readyToShip, "Prontos para envio"],
        ["due", "late", s.late, "Atrasados"], ["due", "today", s.dueToday, "Vencem em 24h"], ["stage", "new", s.new, "Aguardando pagamento"],
      ]);
      const exportParams = params(); exportParams.delete("limit"); exportParams.delete("offset");
      root.innerHTML = `
        <section class="hub-attention hub-attention--orders">${chips.map(([field, value, n, label]) => `<button type="button" class="seller-kpi hub-attention__card ${(field === "stage" ? state.stage : state.due) === value ? "is-active" : ""}"
          data-chip-field="${field}" data-chip-value="${value}" data-tone="${value === "late" ? "danger" : value === "today" ? "warning" : ""}"><span>${esc(label)}</span><strong>${int(n || 0)}</strong></button>`).join("")}</section>
        ${state.message ? `<div class="hub-flash" data-tone="${state.tone}">${esc(state.message)}</div>` : ""}
        <section class="seller-card">
          <form class="hub-toolbar" data-orders-filter>
            <input type="search" name="q" placeholder="Pedido, SKU, comprador, rastreio ou NF" value="${esc(state.q)}">
            <select name="stage"><option value="">Todas as situações</option>${Object.entries(STAGE_LABELS).map(([k, [l]]) => `<option value="${k}" ${state.stage === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
            <select name="accountId"><option value="">Todas as contas</option>${accounts.map((/** @type {any} */ a) => `<option value="${esc(a.id)}" ${String(a.id) === state.accountId ? "selected" : ""}>${esc(CHANNEL_LABELS[a.channel] || a.channel)} · ${esc(a.label)}</option>`).join("")}</select>
            <label class="hub-check">De <input type="date" name="from" value="${esc(state.from)}"></label>
            <label class="hub-check">Até <input type="date" name="to" value="${esc(state.to)}"></label>
            <select name="due"><option value="">Qualquer prazo</option><option value="late" ${state.due === "late" ? "selected" : ""}>Atrasados</option><option value="today" ${state.due === "today" ? "selected" : ""}>Vencem em 24h</option></select>
            <select name="customStatus"><option value="">Qualquer status interno</option><option value="none" ${state.customStatus === "none" ? "selected" : ""}>Sem status interno</option>${statuses.map((/** @type {any} */ s) => `<option value="${esc(s.id)}" ${state.customStatus === String(s.id) ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
            <input name="tag" placeholder="Etiqueta" value="${esc(state.tag)}" class="hub-input-md">
            <label class="hub-check"><input type="checkbox" name="pending" ${state.pendingOnly ? "checked" : ""}> Só sem vínculo</label>
            <button class="seller-btn" type="submit">Filtrar</button>
            <span class="hub-toolbar__spacer"></span>
            <a class="seller-btn" href="/hub/api/orders/export.csv?${esc(exportParams.toString())}">Exportar</a>
          </form>
          ${isAdmin && orders.length ? `<form class="hub-bulk" data-bulk>
            <strong>${selected.size ? `${int(selected.size)} selecionado(s)` : "Selecione pedidos para agir em lote"}</strong>
            <select name="statusId"><option value="">Status interno…</option><option value="clear">Limpar status</option>${statuses.map((/** @type {any} */ s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</select>
            <button class="seller-btn" type="button" data-bulk-status ${selected.size ? "" : "disabled"}>Aplicar status</button>
            <input name="tag" placeholder="Etiqueta" maxlength="40" class="hub-input-md">
            <button class="seller-btn" type="button" data-bulk-tag="add" ${selected.size ? "" : "disabled"}>Pôr</button><button class="seller-btn" type="button" data-bulk-tag="remove" ${selected.size ? "" : "disabled"}>Tirar</button>
            ${manualRules.length ? `<select name="ruleId">${manualRules.map((/** @type {any} */ r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}</select>
              <button class="seller-btn" type="button" data-bulk-run ${selected.size ? "" : "disabled"}>Executar automação</button>` : ""}
          </form>` : ""}
          ${orders.length ? `<div class="seller-table-wrap"><table class="seller-table"><thead><tr>${isAdmin ? `<th><input type="checkbox" data-select-all aria-label="Selecionar todos" ${selected.size && selected.size === orders.length ? "checked" : ""}></th>` : ""}<th>Data</th><th>Canal</th><th>Pedido</th><th>Itens</th><th>Enviar até</th><th class="hub-num">Produtos</th><th class="hub-num">Tarifas</th><th class="hub-num">Líquido</th><th>Estoque</th></tr></thead><tbody>
          ${orders.map((/** @type {any} */ o) => `<tr class="hub-row-link" data-order="${esc(o.id)}">
            ${isAdmin ? `<td><input type="checkbox" data-select="${esc(o.id)}" ${selected.has(String(o.id)) ? "checked" : ""} aria-label="Selecionar pedido"></td>` : ""}
            <td>${esc(dateTime(o.orderedAt))}</td>
            <td><span class="seller-badge">${esc(CHANNEL_LABELS[o.channel] || o.channel)}</span><br><small>${esc(o.account)}</small></td>
            <td><a href="/hub/pedidos/detalhe?id=${esc(o.id)}"><strong>${esc(o.orderId)}</strong></a><br>${stageBadge(kit, o.stage)}${o.fulfillment ? ' <span class="seller-badge">Full</span>' : ""} ${statusAndTags(kit, o)}</td>
            <td>${(o.lines || []).map((/** @type {any} */ l) => `${int(l.quantity)}× ${esc(l.sku || l.title || l.listingId)}`).join("<br>")}</td>
            <td>${dueCell(kit, o)}</td>
            <td class="hub-num">${money(o.productsTotal ?? o.total)}</td><td class="hub-num">${money(o.feesTotal)}</td><td class="hub-num"><strong>${money(o.netTotal)}</strong></td>
            <td>${(o.lines || []).map((/** @type {any} */ l) => l.pending ? '<span class="seller-badge" data-tone="danger">Sem vínculo</span>'
              : l.returned ? '<span class="seller-badge">Devolvido</span>' : l.applied ? '<span class="seller-badge" data-tone="success">Baixado</span>' : '<span class="seller-badge">Sem baixa</span>').join("<br>")}</td></tr>`).join("")}
          </tbody></table></div>` : (total === 0 && !state.stage && !state.q && !state.due && !state.pendingOnly && !state.accountId && !state.from && !state.to
            ? `<div class="seller-empty"><strong>Nenhum pedido recebido ainda</strong><span>Os pedidos chegam pelos avisos dos canais e por uma leitura de segurança a cada 10 minutos.</span></div>`
            : '<div class="seller-empty"><strong>Nenhum pedido com este filtro</strong></div>')}
          ${pager(kit, state.offset, total, PAGE)}
        </section>`;
    }

    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("submit", async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (!form.matches("[data-orders-filter]")) return;
        event.preventDefault();
        const d = new FormData(form);
        Object.assign(state, {
          q: String(d.get("q") || ""), stage: String(d.get("stage") || ""), accountId: String(d.get("accountId") || ""),
          from: String(d.get("from") || ""), to: String(d.get("to") || ""), due: String(d.get("due") || ""), pendingOnly: d.get("pending") === "on",
          customStatus: String(d.get("customStatus") || ""), tag: String(d.get("tag") || "").trim(), offset: 0, message: "",
        });
        await render();
      });
      root.addEventListener("click", async (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        const page = target.closest("[data-page]");
        if (page) { state.offset = Number(page.getAttribute("data-page")) || 0; await render(); return; }
        const chip = target.closest("[data-chip-field]");
        if (chip) {
          const field = /** @type {"stage" | "due"} */ (chip.getAttribute("data-chip-field"));
          const value = String(chip.getAttribute("data-chip-value"));
          state[field] = state[field] === value ? "" : value;
          if (field === "due") state.stage = ""; else state.due = "";
          state.offset = 0;
          await render();
          return;
        }
        if (target.matches("[data-select-all]")) {
          const on = /** @type {HTMLInputElement} */ (target).checked;
          root.querySelectorAll("[data-select]").forEach((el) => { const id = String(el.getAttribute("data-select")); if (on) selected.add(id); else selected.delete(id); });
          await render(); return;
        }
        if (target.matches("[data-select]")) {
          const id = String(target.getAttribute("data-select"));
          if (/** @type {HTMLInputElement} */ (target).checked) selected.add(id); else selected.delete(id);
          await render(); return;
        }
        const bulk = /** @type {HTMLFormElement | null} */ (root.querySelector("[data-bulk]"));
        const orderIds = [...selected].map(Number);
        const done = async (/** @type {Promise<any>} */ call, /** @type {(r: any) => string} */ text) => {
          try { const r = await call; Object.assign(state, { message: text(r), tone: "success" }); selected.clear(); }
          catch (error) { Object.assign(state, { message: /** @type {Error} */ (error).message, tone: "danger" }); }
          await render();
        };
        if (bulk && target.closest("[data-bulk-status]")) {
          const v = String(new FormData(bulk).get("statusId") || "");
          if (!v) { state.message = "Escolha o status interno."; state.tone = "danger"; await render(); return; }
          await done(api("/orders/status", { method: "POST", body: JSON.stringify({ orderIds, statusId: v === "clear" ? null : Number(v) }) }), (r) => `Status aplicado em ${r.changed} pedido(s).`);
          return;
        }
        if (bulk && target.closest("[data-bulk-tag]")) {
          const tag = String(new FormData(bulk).get("tag") || "").trim();
          if (!tag) { state.message = "Informe a etiqueta."; state.tone = "danger"; await render(); return; }
          const add = target.closest("[data-bulk-tag]")?.getAttribute("data-bulk-tag") === "add";
          await done(api("/orders/tags", { method: "POST", body: JSON.stringify({ orderIds, add: add ? [tag] : [], remove: add ? [] : [tag] }) }), (r) => `Etiqueta ${add ? "posta" : "tirada"} em ${r.changed} pedido(s).`);
          return;
        }
        if (bulk && target.closest("[data-bulk-run]")) {
          const ruleId = Number(new FormData(bulk).get("ruleId"));
          await done(api(`/automations/rules/${ruleId}/run`, { method: "POST", body: JSON.stringify({ orderIds }) }), (r) => `Automação executada em ${r.ran} pedido(s) (os que batem nas condições).`);
          return;
        }
        if (target.closest("[data-bulk]")) return;
        const row = target.closest("[data-order]");
        if (row && !target.closest("a") && !target.closest("input")) location.href = `/hub/pedidos/detalhe?id=${row.getAttribute("data-order")}`;
      });
    }
    return async () => { bind(); await render(); };
  };

  /* ───────────── Detalhe do pedido ───────────── */
  registry.orderDetail = (kit) => {
    const { api, esc, int, root, empty, dateTime, CHANNEL_LABELS, isAdmin } = kit;
    let bound = false;
    const render = async () => {
      const id = new URLSearchParams(location.search).get("id");
      if (!id) { root.innerHTML = empty("Pedido não informado", "Abra um pedido pela lista.", '<a class="seller-btn" href="/hub/pedidos">Ver pedidos</a>'); return; }
      const [{ order: o }, { statuses }, { rules }, exp] = await Promise.all([api(`/orders/${encodeURIComponent(id)}`),
        api("/automations/statuses").catch(() => ({ statuses: [] })), api("/automations/rules").catch(() => ({ rules: [] })),
        api(`/expedition/orders/${encodeURIComponent(id)}`).catch(() => null)]);
      const ex = exp?.order || {};
      const manualRules = rules.filter((/** @type {any} */ r) => r.event === "manual" && r.active);
      const EVENT_LABELS = /** @type {Record<string, string>} */ ({ received: "Pedido recebido", stage: "Situação mudou", stock: "Estoque", custom_status: "Status interno", tags: "Etiquetas", automation: "Automação" });
      /** @param {string} label @param {string} value */
      const row = (label, value) => `<div class="hub-metric"><span>${esc(label)}</span><strong>${value}</strong></div>`;
      root.innerHTML = `
        <section class="seller-card">
          <div class="hub-account-head"><div><span class="seller-badge">${esc(CHANNEL_LABELS[o.channel] || o.channel)}</span> <small>${esc(o.account)}</small>
            <h2 class="hub-order-title">Pedido ${esc(o.orderId)}</h2>${stageBadge(kit, o.stage)}${o.fulfillment ? ' <span class="seller-badge">Full</span>' : ""}
            <small class="hub-muted"> no canal: ${esc(o.channelStatus || "—")}</small> ${statusAndTags(kit, o)}</div>
            <a class="seller-btn" href="/hub/pedidos">Voltar aos pedidos</a></div>
          ${isAdmin ? `<form class="hub-bulk" data-order-actions="${esc(o.id)}">
            <select name="statusId"><option value="clear" ${o.customStatusId ? "" : "selected"}>Sem status interno</option>${statuses.map((/** @type {any} */ s) => `<option value="${esc(s.id)}" ${Number(o.customStatusId) === Number(s.id) ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
            <button class="seller-btn" type="button" data-order-status>Salvar status</button>
            <input name="tag" placeholder="Nova etiqueta" maxlength="40" class="hub-input-md"><button class="seller-btn" type="button" data-order-tag>Pôr etiqueta</button>
            ${(o.tags || []).map((/** @type {string} */ t) => `<button class="hub-tag hub-tag--remove" type="button" data-order-untag="${esc(t)}" title="Tirar etiqueta">${esc(t)} ✕</button>`).join("")}
            ${manualRules.map((/** @type {any} */ r) => `<button class="seller-btn" type="button" data-order-run="${esc(r.id)}">${esc(r.name)}</button>`).join("")}
            <small data-form-error class="hub-error"></small></form>` : ""}
          <div class="hub-metrics">
            ${row("Data do pedido", esc(dateTime(o.orderedAt)))}${row("Enviar até", dueCell(kit, o))}
            ${row("Enviado em", esc(dateTime(o.shippedAt)))}${row("Entregue em", esc(dateTime(o.deliveredAt)))}
          </div>
        </section>
        <section class="hub-two-col">
          <article class="seller-card"><h2>Valores</h2><div class="hub-metrics hub-metrics--2">
            ${row("Produtos", money(o.productsTotal ?? o.total))}${row("Frete pago pelo comprador", money(o.shippingPaid))}
            ${row("Descontos", money(o.discountTotal))}${row("Tarifas do canal", money(o.feesTotal))}
            ${row("Líquido estimado", `<strong>${money(o.netTotal)}</strong>`)}${row("Total no canal", money(o.total))}
          </div><p class="hub-muted">Líquido estimado = produtos − tarifas − descontos (quando o canal informa). A margem com custo do produto entra na Fase 2.</p></article>
          <article class="seller-card"><h2>Envio e comprador</h2><div class="hub-metrics hub-metrics--2">
            ${row("Logística", esc(o.logisticType || "—"))}${row("Transportadora", esc(o.carrier || "—"))}
            ${row("Rastreio", esc(o.trackingCode || "—"))}${row("Nota fiscal", esc(o.invoiceNumber || "—"))}
            ${row("Comprador", esc(o.buyerName || "—"))}${row("Cidade / UF", esc([o.buyerCity, o.buyerState].filter(Boolean).join(" / ") || "—"))}
          </div></article>
        </section>
        <section class="seller-card"><h2>Expedição</h2><div class="hub-metrics">
            <div class="hub-metric"><span>Lote de separação</span><strong>${ex.batchId ? `<a href="/hub/expedicao/lote?id=${esc(ex.batchId)}">#${esc(ex.batchId)}</a>` : "—"}</strong></div>
            <div class="hub-metric"><span>Conferido</span><strong>${ex.packedAt ? `${esc(dateTime(ex.packedAt))}<br><small>${esc(ex.packedBy || "")}</small>` : ex.packIssue ? `<span class="hub-error">${esc(ex.packIssue)}</span>` : "Ainda não"}</strong></div>
            <div class="hub-metric"><span>Coleta</span><strong>${ex.pickupId ? `<a href="/hub/expedicao/coleta?id=${esc(ex.pickupId)}">#${esc(ex.pickupId)}</a>` : "—"}</strong></div>
            <div class="hub-metric"><span>Entregue à transportadora</span><strong>${esc(dateTime(ex.handedOverAt))}</strong></div></div>
          ${(exp?.photos || []).length ? `<div class="hub-photos">${exp.photos.map((/** @type {any} */ p) => `<a href="/hub/api/expedition/photos/${esc(p.id)}" target="_blank" rel="noopener"><img class="hub-photo" src="/hub/api/expedition/photos/${esc(p.id)}" alt="Foto do pacote"></a>`).join("")}</div>` : ""}
          <div class="hub-actions hub-actions--start">${ex.packedAt ? "" : `<a class="seller-btn" href="/hub/expedicao/conferencia">Conferir na expedição</a>`}
            ${["shipped", "delivered", "returned", "cancelled"].includes(o.stage) || o.fulfillment ? "" : `<a class="seller-btn" href="/hub/expedicao/etiquetas?pedido=${esc(o.id)}">Imprimir etiqueta</a>`}</div></section>
        <section class="seller-card"><h2>Itens</h2>
          <div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>Produto</th><th>Anúncio</th><th class="hub-num">Qtd</th><th class="hub-num">Preço</th><th class="hub-num">Tarifa</th><th>Estoque</th></tr></thead><tbody>
          ${(o.lines || []).map((/** @type {any} */ l) => `<tr><td>${l.sku ? `<a href="/hub/estoque/movimentos?item=${esc(l.itemId)}"><strong>${esc(l.sku)}</strong></a><br><small>${esc(l.itemName || "")}</small>` : '<span class="seller-badge" data-tone="danger">Sem vínculo</span>'}</td>
            <td>${esc(l.title || l.listingId)}<br><small>${esc(l.listingId)}${l.variationId ? ` · ${esc(l.variationId)}` : ""}${l.channelSku ? ` · SKU ${esc(l.channelSku)}` : ""}</small></td>
            <td class="hub-num">${int(l.quantity)}</td><td class="hub-num">${money(l.unitPrice)}</td><td class="hub-num">${money(l.saleFee)}</td>
            <td>${l.pendingLink ? '<a href="/hub/pendencias">Vincular</a>' : l.cancelApplied ? "Devolvido" : l.saleApplied ? "Baixado" : o.fulfillment ? "Full (estoque do canal)" : "Sem baixa"}</td></tr>`).join("")}
          </tbody></table></div></section>
        <section class="seller-card"><h2>Linha do tempo</h2>
          <ol class="hub-timeline">${(o.events || []).map((/** @type {any} */ e) => `<li><time>${esc(dateTime(e.createdAt))}</time><strong>${esc(EVENT_LABELS[e.kind] || e.kind)}</strong>
            ${e.stage ? stageBadge(kit, e.stage) : ""}${e.channelStatus ? ` <small class="hub-muted">${esc(e.channelStatus)}</small>` : ""}${e.note ? `<div>${esc(e.note)}</div>` : ""}</li>`).join("") || "<li>Sem eventos.</li>"}</ol>
        </section>`;
    };
    const bind = () => {
      if (bound) return;
      bound = true;
      root.addEventListener("click", async (event) => {
        const t = /** @type {HTMLElement} */ (event.target);
        const form = /** @type {HTMLFormElement | null} */ (t.closest("[data-order-actions]"));
        if (!form) return;
        const orderIds = [Number(form.getAttribute("data-order-actions"))];
        const d = new FormData(form);
        const error = /** @type {HTMLElement} */ (form.querySelector("[data-form-error]"));
        try {
          if (t.closest("[data-order-status]")) {
            const v = String(d.get("statusId") || "clear");
            await api("/orders/status", { method: "POST", body: JSON.stringify({ orderIds, statusId: v === "clear" ? null : Number(v) }) });
          } else if (t.closest("[data-order-tag]")) {
            const tag = String(d.get("tag") || "").trim();
            if (!tag) return;
            await api("/orders/tags", { method: "POST", body: JSON.stringify({ orderIds, add: [tag] }) });
          } else if (t.closest("[data-order-untag]")) {
            await api("/orders/tags", { method: "POST", body: JSON.stringify({ orderIds, remove: [t.closest("[data-order-untag]")?.getAttribute("data-order-untag")] }) });
          } else if (t.closest("[data-order-run]")) {
            await api(`/automations/rules/${t.closest("[data-order-run]")?.getAttribute("data-order-run")}/run`, { method: "POST", body: JSON.stringify({ orderIds }) });
          } else return;
          await render();
        } catch (err) { error.textContent = /** @type {Error} */ (err).message; }
      });
    };
    return async () => { bind(); await render(); };
  };

  /* ───────────── Vendas do mês (cobrança) ───────────── */
  registry.billing = (kit) => {
    const { api, esc, int, root, dateTime, CHANNEL_LABELS } = kit;
    const state = { month: new URLSearchParams(location.search).get("mes") || "", offset: 0 };
    const KIND = /** @type {Record<string, [string, string]>} */ ({ counted: ["Entra na base", "success"], excluded: ["Cancelado/devolvido no mês", ""], credit: ["Crédito (mês já fechado)", "warning"] });
    let bound = false;

    async function render() {
      const { month: m } = await api(`/billing/month${state.month ? `?month=${encodeURIComponent(state.month)}` : ""}`);
      state.month = m.month;
      const { statement } = await api(`/billing/statement?month=${encodeURIComponent(m.month)}&limit=${PAGE}&offset=${state.offset}`);
      root.innerHTML = `
        <section class="seller-card">
          <form class="hub-toolbar" data-billing-month><label class="hub-check">Mês <input type="month" name="month" value="${esc(m.month)}"></label><button class="seller-btn" type="submit">Ver</button>
            <span class="hub-toolbar__spacer"></span>${m.closing ? `<span class="seller-badge" data-tone="success">Fechado em ${esc(dateTime(m.closing.closedAt))}</span>` : m.current ? '<span class="seller-badge" data-tone="accent">Mês em andamento</span>' : '<span class="seller-badge" data-tone="warning">Aguardando fechamento</span>'}</form>
          <p>Base da cobrança: valor dos produtos <strong>sem frete</strong>, de pedidos do mês (fuso de São Paulo). Cancelado ou devolvido dentro do mês sai da base; depois do fechamento vira crédito no mês seguinte.</p>
        </section>
        <section class="seller-grid">
          <article class="seller-kpi"><span>Pedidos</span><strong>${int(m.orders)}</strong><small>${int(m.cancelledOrders)} cancelado(s)/devolvido(s)</small></article>
          <article class="seller-kpi"><span>Vendas (GMV)</span><strong>${money(m.gmv)}</strong><small>produtos, sem frete</small></article>
          <article class="seller-kpi"><span>Créditos</span><strong>${money(m.credits)}</strong><small>cancelados de meses fechados</small></article>
          <article class="seller-kpi"><span>Base do mês</span><strong>${money(m.base)}</strong><small>vendas − créditos</small></article>
        </section>
        <section class="seller-card"><h2>Extrato</h2>
          ${statement.length ? `<div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>Data</th><th>Canal</th><th>Pedido</th><th>Situação</th><th class="hub-num">Valor</th><th>Na cobrança</th></tr></thead><tbody>
          ${statement.map((/** @type {any} */ r) => { const [label, tone] = KIND[r.kind] || [r.kind, ""]; return `<tr><td>${esc(dateTime(r.orderedAt))}</td>
            <td><span class="seller-badge">${esc(CHANNEL_LABELS[r.channel] || r.channel)}</span><br><small>${esc(r.account)}</small></td>
            <td><a href="/hub/pedidos/detalhe?id=${esc(r.id)}">${esc(r.orderId)}</a></td><td>${stageBadge(kit, r.stage)}</td>
            <td class="hub-num">${r.kind === "counted" ? money(r.value) : r.kind === "credit" ? `−${money(r.value)}` : `<s>${money(r.value)}</s>`}</td>
            <td><span class="seller-badge" ${tone ? `data-tone="${tone}"` : ""}>${esc(label)}</span></td></tr>`; }).join("")}
          </tbody></table></div>` : '<div class="seller-empty"><strong>Nenhum pedido neste mês</strong></div>'}
          <div class="hub-pager"><button class="seller-btn" type="button" data-page="${Math.max(0, state.offset - PAGE)}" ${state.offset ? "" : "disabled"}>Anterior</button>
            <button class="seller-btn" type="button" data-page="${state.offset + PAGE}" ${statement.length === PAGE ? "" : "disabled"}>Próxima</button></div>
        </section>`;
    }

    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("submit", async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (!form.matches("[data-billing-month]")) return;
        event.preventDefault();
        state.month = String(new FormData(form).get("month") || "");
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
    if (attention?.notificationsUnread) alerts.push({ tone: "warning", text: `${attention.notificationsUnread} aviso(s) das automações não lido(s).`, href: "/hub/avisos" });
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
