// @ts-check
// Expedição (Fase 3 / P3): separação em lote, conferência com leitor de código de barras e foto, coletas.
(function () {
  "use strict";

  const registry = /** @type {Record<string, (kit: any) => () => Promise<void>>} */ ((/** @type {any} */ (window).DachHubViews ||= {}));
  const CARRIERS = ["Mercado Envios (coleta)", "Mercado Envios Flex", "Correios", "Shopee Xpress", "Magalu Entregas", "J&T Express", "Loggi", "Jadlog"];

  /** Bipe curto: agudo = ok, grave = erro. Ignora se o navegador não deixar tocar som. @param {boolean} ok */
  function beep(ok) {
    try {
      const Ctx = /** @type {any} */ (window).AudioContext || /** @type {any} */ (window).webkitAudioContext;
      const ctx = new Ctx(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.frequency.value = ok ? 1046 : 220; gain.gain.value = 0.08; osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + (ok ? 0.08 : 0.3)); osc.onended = () => ctx.close();
    } catch (_error) { /* sem som */ }
  }

  /** Foto reduzida no navegador (máx. 1280 px, JPEG 0,7 ≈ 150 KB). @param {File} file @returns {Promise<string>} */
  function shrinkPhoto(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
        /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d")).drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(img.src);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      };
      img.onerror = () => reject(new Error("Não foi possível ler a foto."));
      img.src = URL.createObjectURL(file);
    });
  }


  const CHANNEL_NAMES = /** @type {Record<string, string>} */ ({ mercadolivre: "Mercado Livre", magalu: "Magalu", shopee: "Shopee" });

  /** Pede as etiquetas ao Hub (um arquivo por conta). @param {any} kit @param {number[]} orderIds @param {string} format */
  async function requestLabels(kit, orderIds, format) {
    return (await kit.api("/expedition/labels", { method: "POST", body: JSON.stringify({ orderIds, format }) })).batch;
  }

  /** Resultado de um lote de etiquetas: arquivos para abrir/baixar e pedidos com problema. @param {any} kit @param {any} b */
  function labelBatchHtml(kit, b) {
    const { esc, int, dateTime } = kit;
    const files = b.files || [];
    const failures = b.failures || [];
    return `<div class="hub-label-batch">
      <div><strong>Etiquetas #${esc(b.id)}</strong> <small class="hub-muted">${esc(dateTime(b.createdAt))} · ${b.format === "zpl" ? "térmica" : "PDF"} · ${int(b.orders)} pedido(s)</small></div>
      <div class="hub-actions hub-actions--start">${files.map((/** @type {any} */ f) => `<a class="seller-btn seller-btn--primary" href="/hub/api/expedition/label-files/${esc(f.id)}" target="_blank" rel="noopener">
        ${/\.pdf$/i.test(f.filename) ? "Abrir" : "Baixar"} ${esc(CHANNEL_NAMES[f.channel] || f.channel)} · ${esc(f.account || "")} (${int(f.orders)})</a>`).join("") || '<span class="hub-muted">Nenhum arquivo gerado.</span>'}</div>
      ${failures.length ? `<ul class="hub-errors">${failures.map((/** @type {any} */ f) => `<li><a href="/hub/pedidos/detalhe?id=${esc(f.id)}">${esc(f.orderId)}</a>: ${esc(f.error)}</li>`).join("")}</ul>` : ""}
    </div>`;
  }

  /** Seletor de formato (PDF comum ou térmica). */
  const formatSelect = () => `<select data-label-format aria-label="Formato da etiqueta"><option value="pdf">Etiqueta PDF</option><option value="zpl">Térmica (ZPL; Shopee em PDF A6)</option></select>`;

  /** @param {any} kit @param {any} o */
  function due(kit, o) {
    if (!o.shipBy) return '<span class="hub-muted">—</span>';
    const ms = Date.parse(o.shipBy) - Date.now();
    const tone = ms < 0 ? "danger" : ms < 24 * 3600e3 ? "warning" : "";
    return `<span class="seller-badge" ${tone ? `data-tone="${tone}"` : ""}>${ms < 0 ? "Atrasado · " : ""}${kit.esc(kit.dateTime(o.shipBy))}</span>`;
  }

  /* ───────────── Separação (fila + lotes) ───────────── */
  registry.expedition = (kit) => {
    const { api, esc, int, root, dateTime, CHANNEL_LABELS } = kit;
    const state = { due: "", selected: /** @type {Set<string>} */ (new Set()), message: "", tone: "success", labelBatch: /** @type {any} */ (null) };
    let bound = false;

    async function render() {
      const [{ summary: s }, { orders }, { batches }] = await Promise.all([api("/expedition/summary"), api(`/expedition/queue${state.due ? `?due=${state.due}` : ""}`), api("/expedition/batches")]);
      for (const id of [...state.selected]) if (!orders.some((/** @type {any} */ o) => String(o.id) === id)) state.selected.delete(id);
      root.innerHTML = `
        ${state.message ? `<div class="hub-flash" data-tone="${state.tone}">${esc(state.message)}</div>` : ""}
        ${state.labelBatch ? `<section class="seller-card">${labelBatchHtml(kit, state.labelBatch)}</section>` : ""}
        <section class="hub-attention hub-attention--orders">
          <a class="seller-kpi hub-attention__card" href="/hub/expedicao"><span>A separar</span><strong>${int(s.toPick)}</strong><small>sem lote</small></a>
          <a class="seller-kpi hub-attention__card" href="/hub/expedicao/conferencia"><span>Em lote</span><strong>${int(s.inBatch)}</strong><small>aguardando conferência</small></a>
          <a class="seller-kpi hub-attention__card" href="/hub/expedicao/coletas"><span>Conferidos</span><strong>${int(s.packed)}</strong><small>${int(s.packedNoPickup)} sem coleta</small></a>
          <button type="button" class="seller-kpi hub-attention__card ${state.due === "late" ? "is-active" : ""}" data-due="late" data-tone="danger"><span>Atrasados</span><strong>${int(s.late)}</strong><small>prazo vencido</small></button>
          <a class="seller-kpi hub-attention__card" href="/hub/pedidos?q=" data-tone="${s.issues ? "danger" : ""}"><span>Com problema</span><strong>${int(s.issues)}</strong><small>na conferência</small></a>
          <a class="seller-kpi hub-attention__card" href="/hub/expedicao/conferencia"><span>Conferir</span><strong>▶</strong><small>abrir a bipagem</small></a>
        </section>
        <section class="seller-card">
          <div class="hub-account-head"><div><h2>Fila de separação</h2><p>Pedidos pagos que ainda não saíram, do prazo mais curto ao mais longo. Escolha e crie um lote: a lista de separação soma tudo por produto.</p></div>
            <div class="hub-actions"><select data-due-select><option value="">Todos</option><option value="today" ${state.due === "today" ? "selected" : ""}>Vencem em 24h</option><option value="late" ${state.due === "late" ? "selected" : ""}>Atrasados</option></select>
              ${formatSelect()}<button class="seller-btn" type="button" data-print-labels ${state.selected.size ? "" : "disabled"}>Imprimir etiquetas (${int(state.selected.size)})</button>
              <button class="seller-btn seller-btn--primary" type="button" data-create-batch ${state.selected.size ? "" : "disabled"}>Criar lote (${int(state.selected.size)})</button></div></div>
          ${orders.length ? `<div class="seller-table-wrap"><table class="seller-table"><thead><tr><th><input type="checkbox" data-select-all aria-label="Selecionar todos" ${state.selected.size && state.selected.size === orders.length ? "checked" : ""}></th><th>Enviar até</th><th>Pedido</th><th>Itens</th><th>Logística</th></tr></thead><tbody>
            ${orders.map((/** @type {any} */ o) => `<tr><td><input type="checkbox" data-select="${esc(o.id)}" ${state.selected.has(String(o.id)) ? "checked" : ""} aria-label="Selecionar"></td>
              <td>${due(kit, o)}</td><td><a href="/hub/pedidos/detalhe?id=${esc(o.id)}"><strong>${esc(o.orderId)}</strong></a><br><small>${esc(CHANNEL_LABELS[o.channel] || o.channel)} · ${esc(o.account)}</small>${o.packIssue ? `<br><span class="seller-badge" data-tone="danger">${esc(o.packIssue)}</span>` : ""}</td>
              <td>${esc(o.summary || "")}</td><td>${esc(o.carrier || o.logisticType || "—")}</td></tr>`).join("")}
          </tbody></table></div>` : '<div class="seller-empty"><strong>Nada a separar</strong><span>Pedidos pagos aparecem aqui até serem conferidos.</span></div>'}
        </section>
        <section class="seller-card"><h2>Lotes</h2>
          ${batches.length ? `<div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>Lote</th><th>Criado</th><th>Conferidos</th><th>Situação</th><th></th></tr></thead><tbody>
            ${batches.map((/** @type {any} */ b) => `<tr><td><strong>#${esc(b.id)}</strong></td><td>${esc(dateTime(b.createdAt))}<br><small>${esc(b.createdBy || "")}</small></td>
              <td><div class="hub-progress"><span style="width:${b.orders ? Math.round((b.packed / b.orders) * 100) : 0}%"></span></div><small>${int(b.packed)} de ${int(b.orders)}</small></td>
              <td>${b.status === "open" ? '<span class="seller-badge" data-tone="warning">Aberto</span>' : '<span class="seller-badge" data-tone="success">Concluído</span>'}</td>
              <td><div class="hub-actions"><a class="seller-btn hub-btn-xs" href="/hub/expedicao/lote?id=${esc(b.id)}">Lista de separação</a>${b.status === "open" ? `<a class="seller-btn hub-btn-xs seller-btn--primary" href="/hub/expedicao/conferencia?lote=${esc(b.id)}">Conferir</a>` : ""}</div></td></tr>`).join("")}
          </tbody></table></div>` : '<p class="hub-muted">Nenhum lote nos últimos 7 dias.</p>'}
        </section>`;
    }

    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("change", async (event) => {
        const t = /** @type {HTMLInputElement} */ (event.target);
        if (t.matches("[data-due-select]")) { state.due = t.value; await render(); return; }
        if (t.matches("[data-select-all]")) { root.querySelectorAll("[data-select]").forEach((el) => { const id = String(el.getAttribute("data-select")); if (t.checked) state.selected.add(id); else state.selected.delete(id); }); await render(); return; }
        if (t.matches("[data-select]")) { const id = String(t.getAttribute("data-select")); if (t.checked) state.selected.add(id); else state.selected.delete(id); await render(); }
      });
      root.addEventListener("click", async (event) => {
        const t = /** @type {HTMLElement} */ (event.target);
        const d = t.closest("[data-due]");
        if (d) { state.due = state.due === d.getAttribute("data-due") ? "" : String(d.getAttribute("data-due")); await render(); return; }
        if (t.closest("[data-print-labels]")) {
          const button = /** @type {HTMLButtonElement} */ (t.closest("[data-print-labels]"));
          button.disabled = true; button.textContent = "Gerando etiquetas…";
          try {
            const format = /** @type {HTMLSelectElement} */ (root.querySelector("[data-label-format]")).value;
            state.labelBatch = await requestLabels(kit, [...state.selected].map(Number), format);
            state.message = "";
          } catch (error) { Object.assign(state, { message: /** @type {Error} */ (error).message, tone: "danger" }); }
          await render(); return;
        }
        if (t.closest("[data-create-batch]")) {
          try {
            const { batch } = await api("/expedition/batches", { method: "POST", body: JSON.stringify({ orderIds: [...state.selected].map(Number) }) });
            state.selected.clear();
            location.href = `/hub/expedicao/lote?id=${batch.id}`;
          } catch (error) { Object.assign(state, { message: /** @type {Error} */ (error).message, tone: "danger" }); await render(); }
        }
      });
    }
    return async () => { bind(); await render(); };
  };

  /* ───────────── Lote: lista de separação (imprimível) ───────────── */
  registry.pickingBatch = (kit) => {
    const { api, esc, int, root, empty, dateTime, CHANNEL_LABELS } = kit;
    let bound = false;
    /** @type {any} */
    let labelBatch = null;
    /** @type {any} */
    let current = null;
    const id = new URLSearchParams(location.search).get("id");
    async function render() {
      if (!id) { root.innerHTML = empty("Lote não informado", "Abra um lote pela Separação.", '<a class="seller-btn" href="/hub/expedicao">Separação</a>'); return; }
      const { batch: b } = await api(`/expedition/batches/${encodeURIComponent(id)}`);
      current = b;
      const total = b.picking.reduce((/** @type {number} */ s, /** @type {any} */ r) => s + r.quantity, 0);
      root.innerHTML = `
        <section class="seller-card hub-no-print"><div class="hub-account-head"><div><h2>Lote #${esc(b.id)}</h2><small>${esc(dateTime(b.createdAt))} · ${int(b.orders.length)} pedido(s) · ${b.status === "open" ? "aberto" : "concluído"}</small></div>
          <div class="hub-actions"><button class="seller-btn" type="button" data-print>Imprimir lista</button>${formatSelect()}<button class="seller-btn" type="button" data-batch-labels>Imprimir etiquetas</button>
            ${b.status === "open" ? `<a class="seller-btn seller-btn--primary" href="/hub/expedicao/conferencia?lote=${esc(b.id)}">Conferir este lote</a><button class="seller-btn" type="button" data-close-batch>Fechar lote</button>` : ""}</div></div></section>
        ${labelBatch ? `<section class="seller-card hub-no-print">${labelBatchHtml(kit, labelBatch)}</section>` : ""}
        <section class="seller-card" data-print-area>
          <h2>Lista de separação · lote #${esc(b.id)}</h2><p>${int(total)} unidade(s) de ${int(b.picking.length)} produto(s) para ${int(b.orders.filter((/** @type {any} */ o) => !o.packedAt).length)} pedido(s) a conferir. Kits já aparecem abertos nos componentes.</p>
          ${b.picking.length ? `<div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>✓</th><th>SKU</th><th>Produto</th><th>EAN</th><th class="hub-num">Qtd</th><th class="hub-num">Pedidos</th></tr></thead><tbody>
            ${b.picking.map((/** @type {any} */ r) => `<tr><td>☐</td><td><strong>${esc(r.sku)}</strong>${r.fromKit ? `<br><small>do kit ${esc(r.fromKit)}</small>` : ""}${r.itemId ? "" : '<br><span class="seller-badge" data-tone="danger">sem vínculo</span>'}</td>
              <td>${esc(r.name || "")}</td><td>${esc(r.ean || "")}</td><td class="hub-num"><strong>${int(r.quantity)}</strong></td><td class="hub-num">${int(r.orders)}</td></tr>`).join("")}
          </tbody></table></div>` : '<p class="hub-ok">Tudo deste lote já foi conferido.</p>'}
        </section>
        <section class="seller-card hub-no-print"><h2>Pedidos do lote</h2>
          <div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>Pedido</th><th>Enviar até</th><th>Itens</th><th>Conferência</th></tr></thead><tbody>
          ${b.orders.map((/** @type {any} */ o) => `<tr><td><a href="/hub/pedidos/detalhe?id=${esc(o.id)}">${esc(o.orderId)}</a><br><small>${esc(CHANNEL_LABELS[o.channel] || o.channel)}</small></td><td>${due(kit, o)}</td><td>${int(o.units)}</td>
            <td>${o.packedAt ? `<span class="seller-badge" data-tone="success">Conferido</span>` : o.packIssue ? `<span class="seller-badge" data-tone="danger">${esc(o.packIssue)}</span>` : '<span class="seller-badge">Aguardando</span>'}</td></tr>`).join("")}
          </tbody></table></div></section>`;
    }
    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("click", async (event) => {
        const t = /** @type {HTMLElement} */ (event.target);
        if (t.closest("[data-print]")) { window.print(); return; }
        if (t.closest("[data-batch-labels]")) {
          const button = /** @type {HTMLButtonElement} */ (t.closest("[data-batch-labels]"));
          button.disabled = true; button.textContent = "Gerando etiquetas…";
          const format = /** @type {HTMLSelectElement} */ (root.querySelector("[data-label-format]")).value;
          try { labelBatch = await requestLabels(kit, current.orders.map((/** @type {any} */ o) => Number(o.id)), format); }
          catch (error) { labelBatch = { id: "—", files: [], failures: [{ id: "", orderId: "lote", error: /** @type {Error} */ (error).message }], orders: 0 }; }
          await render(); return;
        }
        if (t.closest("[data-close-batch]")) {
          if (!confirm("Fechar o lote? Pedidos ainda não conferidos voltam para a fila de separação.")) return;
          await api(`/expedition/batches/${encodeURIComponent(String(id))}/close`, { method: "POST" });
          await render();
        }
      });
    }
    return async () => { bind(); await render(); };
  };

  /* ───────────── Conferência (bipagem) ───────────── */
  registry.checkout = (kit) => {
    const { api, esc, int, root, dateTime, CHANNEL_LABELS, isAdmin } = kit;
    const batchId = new URLSearchParams(location.search).get("lote");
    /** @type {{ mode: "order" | "product", current: any | null, counts: Record<string, { scanned: number, manual: number }>, photo: string | null, message: string, tone: string, last: string }} */
    const state = { mode: "order", current: null, counts: {}, photo: null, message: "", tone: "success", last: "" };
    let bound = false;

    const units = () => (state.current?.units || []);
    const doneOf = (/** @type {any} */ u) => (state.counts[u.key]?.scanned || 0) + (state.counts[u.key]?.manual || 0);
    const complete = () => units().length > 0 && units().every((/** @type {any} */ u) => doneOf(u) === u.quantity);

    /** @param {string} message @param {string} tone */
    const say = (message, tone) => { state.message = message; state.tone = tone; beep(tone !== "danger"); };

    /** Abre o pedido para conferir. @param {any} data */
    function open(data) {
      state.current = data; state.counts = {}; state.photo = null;
      if (data.order.packedAt) say(`Pedido ${data.order.orderId} já foi conferido em ${dateTime(data.order.packedAt)}.`, "danger");
      else if (data.order.status && data.order.status !== "open") say(`Pedido ${data.order.orderId} está cancelado: não envie.`, "danger");
      else if (data.order.fulfillment) say(`Pedido ${data.order.orderId} é Full: sai do centro do marketplace, não do seu estoque.`, "danger");
      else if (["shipped", "delivered", "returned"].includes(data.order.stage)) say(`Pedido ${data.order.orderId} já foi enviado: não precisa conferir.`, "danger");
      else say(`Pedido ${data.order.orderId}: bipe os itens.`, "success");
    }

    /** Registra uma unidade bipada (ou confirmada sem código). @param {string} key @param {"scanned" | "manual"} how */
    function count(key, how) {
      const unit = units().find((/** @type {any} */ u) => u.key === key);
      if (!unit) return;
      if (doneOf(unit) >= unit.quantity) { say(`${unit.sku}: já conferiu as ${unit.quantity} unidade(s). Sobrou item?`, "danger"); return; }
      state.counts[key] = { scanned: state.counts[key]?.scanned || 0, manual: state.counts[key]?.manual || 0 };
      state.counts[key][how] += 1;
      say(`${unit.sku}: ${doneOf(unit)} de ${unit.quantity}.${complete() ? " Tudo conferido — Enter para concluir." : ""}`, "success");
    }

    /** O que fazer com o que foi bipado. @param {string} code */
    async function handleScan(code) {
      state.last = code;
      try {
        if (!state.current || state.current.order.packedAt) {
          if (state.mode === "product") {
            open(await api(`/expedition/product?code=${encodeURIComponent(code)}${batchId ? `&batchId=${encodeURIComponent(batchId)}` : ""}`));
            const unit = state.current && !state.current.order.packedAt ? (await api(`/expedition/orders/${state.current.order.id}/match`, { method: "POST", body: JSON.stringify({ code }) })).unit : null;
            if (unit) count(unit.key, "scanned");
          } else open(await api(`/expedition/lookup?code=${encodeURIComponent(code)}`));
          return;
        }
        if (!code && complete()) { await finish(); return; }
        const { unit } = await api(`/expedition/orders/${state.current.order.id}/match`, { method: "POST", body: JSON.stringify({ code }) });
        count(unit.key, "scanned");
      } catch (error) { say(/** @type {Error} */ (error).message, "danger"); }
    }

    async function finish() {
      if (!state.current || !complete()) return;
      try {
        const checks = units().map((/** @type {any} */ u) => ({ key: u.key, scanned: state.counts[u.key]?.scanned || 0, manual: state.counts[u.key]?.manual || 0 }));
        await api(`/expedition/orders/${state.current.order.id}/pack`, { method: "POST", body: JSON.stringify({ checks, photoBase64: state.photo }) });
        const orderId = state.current.order.orderId;
        state.current = null; state.counts = {}; state.photo = null;
        say(`Pedido ${orderId} conferido. Bipe o próximo.`, "success");
      } catch (error) { say(/** @type {Error} */ (error).message, "danger"); }
    }

    async function render() {
      const c = state.current;
      root.innerHTML = `
        <section class="seller-card hub-scan">
          <div class="hub-account-head"><div class="hub-segment" role="group" aria-label="Modo de conferência">
              <button type="button" class="seller-btn ${state.mode === "order" ? "seller-btn--primary" : ""}" data-mode="order">Por pedido</button>
              <button type="button" class="seller-btn ${state.mode === "product" ? "seller-btn--primary" : ""}" data-mode="product">Por produto</button></div>
            <small class="hub-muted">${batchId ? `Lote #${esc(batchId)} · ` : ""}${state.mode === "order" ? "Bipe o pedido (número, rastreio ou NF) e depois cada item." : "Bipe o item: o Hub acha o pedido mais urgente de 1 unidade dele."}</small></div>
          <form data-scan-form><input class="hub-scan-input" name="code" autocomplete="off" autofocus placeholder="${c && !c.order.packedAt ? "Bipe o item (EAN ou SKU) · Enter vazio conclui" : state.mode === "order" ? "Bipe o pedido" : "Bipe o produto"}"></form>
          ${state.message ? `<div class="hub-flash" data-tone="${state.tone}">${esc(state.message)}</div>` : ""}
        </section>
        ${c ? `<section class="seller-card">
          <div class="hub-account-head"><div><span class="seller-badge">${esc(CHANNEL_LABELS[c.order.channel] || c.order.channel)}</span> <strong class="hub-order-title">Pedido ${esc(c.order.orderId)}</strong>
              <br><small>Enviar até ${due(kit, c.order)} · ${esc(c.order.carrier || c.order.logisticType || "")}</small>${c.order.packIssue ? ` <span class="seller-badge" data-tone="danger">${esc(c.order.packIssue)}</span>` : ""}</div>
            <div class="hub-actions"><button class="seller-btn" type="button" data-change-order>Trocar pedido</button>${c.order.packedAt ? "" : '<button class="seller-btn hub-btn-danger" type="button" data-issue>Falta no estoque / problema</button>'}</div></div>
          <div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>SKU</th><th>Produto</th><th>EAN</th><th class="hub-num">Conferido</th><th></th></tr></thead><tbody>
            ${units().map((/** @type {any} */ u) => { const d = doneOf(u); return `<tr class="${d === u.quantity ? "hub-row-ok" : ""}"><td><strong>${esc(u.sku)}</strong>${u.fromKit ? `<br><small>do kit ${esc(u.fromKit)}</small>` : ""}</td>
              <td>${esc(u.name || "")}</td><td>${esc(u.ean || "—")}</td><td class="hub-num"><strong>${int(d)} / ${int(u.quantity)}</strong></td>
              <td>${c.order.packedAt || d >= u.quantity ? "" : `<button class="seller-btn hub-btn-xs" type="button" data-manual="${esc(u.key)}" title="Item sem código de barras ou etiqueta ilegível">Sem código +1</button>`}</td></tr>`; }).join("")}
          </tbody></table></div>
          ${c.order.packedAt ? `${(c.photos || []).map((/** @type {any} */ p) => `<img class="hub-photo" src="/hub/api/expedition/photos/${esc(p.id)}" alt="Foto do pacote">`).join("")}
              ${isAdmin ? '<button class="seller-btn" type="button" data-unpack>Desfazer conferência</button>' : ""}` : `
          <div class="hub-pack-foot"><label class="seller-btn"><input type="file" accept="image/*" capture="environment" data-photo hidden> ${state.photo ? "Trocar foto" : "Foto do pacote (opcional)"}</label>
            ${state.photo ? `<img class="hub-photo" src="${esc(state.photo)}" alt="Prévia da foto">` : ""}
            <button class="seller-btn seller-btn--primary" type="button" data-finish ${complete() ? "" : "disabled"}>Concluir conferência</button></div>`}
        </section>` : ""}`;
      /** @type {HTMLInputElement | null} */ (root.querySelector(".hub-scan-input"))?.focus();
    }

    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("submit", async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (!form.matches("[data-scan-form]")) return;
        event.preventDefault();
        await handleScan(String(new FormData(form).get("code") || "").trim());
        await render();
      });
      root.addEventListener("change", async (event) => {
        const t = /** @type {HTMLInputElement} */ (event.target);
        if (!t.matches("[data-photo]") || !t.files?.[0]) return;
        try { state.photo = await shrinkPhoto(t.files[0]); } catch (error) { say(/** @type {Error} */ (error).message, "danger"); }
        await render();
      });
      root.addEventListener("click", async (event) => {
        const t = /** @type {HTMLElement} */ (event.target);
        const mode = t.closest("[data-mode]");
        if (mode) { state.mode = /** @type {any} */ (mode.getAttribute("data-mode")); state.current = null; state.message = ""; await render(); return; }
        if (t.closest("[data-change-order]")) { state.current = null; state.message = ""; await render(); return; }
        const manual = t.closest("[data-manual]");
        if (manual) { count(String(manual.getAttribute("data-manual")), "manual"); await render(); return; }
        if (t.closest("[data-finish]")) { await finish(); await render(); return; }
        if (t.closest("[data-issue]")) {
          const note = prompt("Qual o problema? (ex.: falta 1 unidade do SKU X no estoque)");
          if (!note) return;
          try { await api(`/expedition/orders/${state.current.order.id}/issue`, { method: "POST", body: JSON.stringify({ note }) }); say("Problema registrado no pedido. Ele continua na fila.", "success"); state.current = null; }
          catch (error) { say(/** @type {Error} */ (error).message, "danger"); }
          await render(); return;
        }
        if (t.closest("[data-unpack]")) {
          if (!confirm("Desfazer a conferência deste pedido? Ele volta para conferir e sai da coleta aberta.")) return;
          try { await api(`/expedition/orders/${state.current.order.id}/unpack`, { method: "POST" }); open(await api(`/expedition/orders/${state.current.order.id}`)); }
          catch (error) { say(/** @type {Error} */ (error).message, "danger"); }
          await render();
        }
      });
    }
    return async () => { bind(); await render(); };
  };

  /* ───────────── Etiquetas (últimos 7 dias) ───────────── */
  registry.labels = (kit) => {
    const { api, root, empty } = kit;
    const orderId = new URLSearchParams(location.search).get("pedido");
    /** @type {string} */
    let message = "";
    return async () => {
      if (orderId) {
        root.innerHTML = '<div class="seller-card"><div class="seller-empty"><strong>Gerando a etiqueta…</strong></div></div>';
        try { await requestLabels(kit, [Number(orderId)], "pdf"); } catch (error) { message = /** @type {Error} */ (error).message; }
        history.replaceState(null, "", "/hub/expedicao/etiquetas");
      }
      const { batches } = await api("/expedition/labels");
      if (!batches.length && !message) { root.innerHTML = empty("Nenhuma etiqueta nos últimos 7 dias", "Imprima pela Separação, pelo lote ou pelo pedido.", '<a class="seller-btn seller-btn--primary" href="/hub/expedicao">Separação</a>'); return; }
      root.innerHTML = `${message ? `<div class="hub-flash" data-tone="danger">${kit.esc(message)}</div>` : ""}
        <section class="seller-card"><p>Cada canal devolve o próprio arquivo: um por conta. PDF abre no navegador para imprimir; a térmica (ZPL) baixa para a impressora térmica. Os arquivos ficam aqui por 7 dias.</p>
        ${batches.map((/** @type {any} */ b) => labelBatchHtml(kit, b)).join("")}</section>`;
    };
  };

  /* ───────────── Coletas ───────────── */
  registry.pickups = (kit) => {
    const { api, esc, int, root, dateTime } = kit;
    const state = { message: "", tone: "success" };
    let bound = false;
    async function render() {
      const { pickups } = await api("/expedition/pickups");
      const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      root.innerHTML = `
        ${state.message ? `<div class="hub-flash" data-tone="${state.tone}">${esc(state.message)}</div>` : ""}
        <section class="seller-card"><h2>Nova coleta</h2>
          <form class="hub-toolbar" data-pickup-form><input name="carrier" list="hub-carriers" placeholder="Transportadora ou marketplace" required class="hub-input-lg">
            <datalist id="hub-carriers">${CARRIERS.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
            <input type="date" name="scheduledFor" value="${today}" required><button class="seller-btn seller-btn--primary" type="submit">Criar coleta</button></form>
          <p class="hub-muted">Na coleta, bipe cada pacote conferido. Ao fechar, os pedidos ficam como entregues à transportadora e o romaneio pode ser impresso para assinatura.</p></section>
        <section class="seller-card"><h2>Coletas</h2>
          ${pickups.length ? `<div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>Data</th><th>Transportadora</th><th class="hub-num">Pacotes</th><th>Situação</th><th></th></tr></thead><tbody>
            ${pickups.map((/** @type {any} */ p) => `<tr><td>${esc(p.scheduledFor.split("-").reverse().join("/"))}</td><td><strong>${esc(p.carrier)}</strong></td><td class="hub-num">${int(p.orders)}</td>
              <td>${p.status === "open" ? '<span class="seller-badge" data-tone="warning">Aberta</span>' : `<span class="seller-badge" data-tone="success">Entregue ${esc(dateTime(p.closedAt))}</span>`}</td>
              <td><a class="seller-btn hub-btn-xs ${p.status === "open" ? "seller-btn--primary" : ""}" href="/hub/expedicao/coleta?id=${esc(p.id)}">${p.status === "open" ? "Embarcar" : "Romaneio"}</a></td></tr>`).join("")}
          </tbody></table></div>` : '<p class="hub-muted">Nenhuma coleta nos últimos 14 dias.</p>'}</section>`;
    }
    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("submit", async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (!form.matches("[data-pickup-form]")) return;
        event.preventDefault();
        const d = new FormData(form);
        try { const { pickup } = await api("/expedition/pickups", { method: "POST", body: JSON.stringify({ carrier: d.get("carrier"), scheduledFor: d.get("scheduledFor") }) }); location.href = `/hub/expedicao/coleta?id=${pickup.id}`; }
        catch (error) { Object.assign(state, { message: /** @type {Error} */ (error).message, tone: "danger" }); await render(); }
      });
    }
    return async () => { bind(); await render(); };
  };

  /** Coleta: embarque por bipagem e romaneio. */
  registry.pickup = (kit) => {
    const { api, esc, int, root, empty, dateTime, CHANNEL_LABELS } = kit;
    const id = new URLSearchParams(location.search).get("id");
    const state = { message: "", tone: "success" };
    let bound = false;
    async function render() {
      if (!id) { root.innerHTML = empty("Coleta não informada", "Abra pela lista de coletas.", '<a class="seller-btn" href="/hub/expedicao/coletas">Coletas</a>'); return; }
      const { pickup: p } = await api(`/expedition/pickups/${encodeURIComponent(id)}`);
      const open = p.status === "open";
      root.innerHTML = `
        <section class="seller-card hub-no-print"><div class="hub-account-head"><div><h2>${esc(p.carrier)}</h2><small>Coleta #${esc(p.id)} · ${esc(p.scheduledFor.split("-").reverse().join("/"))} · ${int(p.orders.length)} pacote(s)</small></div>
          <div class="hub-actions"><button class="seller-btn" type="button" data-print>Imprimir romaneio</button>${open ? '<button class="seller-btn seller-btn--primary" type="button" data-close-pickup>Fechar coleta (entregue)</button>' : `<span class="seller-badge" data-tone="success">Entregue ${esc(dateTime(p.closedAt))}</span>`}</div></div>
          ${open ? `<form data-embark-form class="hub-scan"><input class="hub-scan-input" name="code" autocomplete="off" autofocus placeholder="Bipe o pacote (número do pedido, rastreio ou NF)"></form>` : ""}
          ${state.message ? `<div class="hub-flash" data-tone="${state.tone}">${esc(state.message)}</div>` : ""}</section>
        <section class="seller-card" data-print-area>
          <h2>Romaneio de coleta · ${esc(p.carrier)}</h2><p>Coleta #${esc(p.id)} · data ${esc(p.scheduledFor.split("-").reverse().join("/"))} · ${int(p.orders.length)} pacote(s)</p>
          <div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>#</th><th>Pedido</th><th>Canal</th><th>Rastreio</th><th class="hub-num">Itens</th>${open ? '<th class="hub-no-print"></th>' : ""}</tr></thead><tbody>
          ${p.orders.map((/** @type {any} */ o, /** @type {number} */ i) => `<tr><td>${i + 1}</td><td><strong>${esc(o.orderId)}</strong></td><td>${esc(CHANNEL_LABELS[o.channel] || o.channel)}</td><td>${esc(o.trackingCode || "—")}</td><td class="hub-num">${int(o.units)}</td>
            ${open ? `<td class="hub-no-print"><button class="seller-btn hub-btn-xs" type="button" data-remove="${esc(o.id)}">Tirar</button></td>` : ""}</tr>`).join("") || `<tr><td colspan="6">Nenhum pacote embarcado.</td></tr>`}
          </tbody></table></div>
          <div class="hub-signatures"><div>Entregue por (nome e assinatura)</div><div>Recebido por / documento / placa</div><div>Data e hora</div></div>
        </section>`;
      /** @type {HTMLInputElement | null} */ (root.querySelector(".hub-scan-input"))?.focus();
    }
    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("submit", async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (!form.matches("[data-embark-form]")) return;
        event.preventDefault();
        const code = String(new FormData(form).get("code") || "").trim();
        if (!code) return;
        try { await api(`/expedition/pickups/${encodeURIComponent(String(id))}/scan`, { method: "POST", body: JSON.stringify({ code }) }); Object.assign(state, { message: `${code} embarcado.`, tone: "success" }); beep(true); }
        catch (error) { Object.assign(state, { message: /** @type {Error} */ (error).message, tone: "danger" }); beep(false); }
        await render();
      });
      root.addEventListener("click", async (event) => {
        const t = /** @type {HTMLElement} */ (event.target);
        if (t.closest("[data-print]")) { window.print(); return; }
        const rm = t.closest("[data-remove]");
        if (rm) { await api(`/expedition/pickups/${encodeURIComponent(String(id))}/orders/${rm.getAttribute("data-remove")}`, { method: "DELETE" }); await render(); return; }
        if (t.closest("[data-close-pickup]")) {
          if (!confirm("Fechar a coleta? Os pacotes ficam como entregues à transportadora.")) return;
          try { const { pickup } = await api(`/expedition/pickups/${encodeURIComponent(String(id))}/close`, { method: "POST" }); Object.assign(state, { message: `Coleta fechada: ${pickup.orders} pacote(s) entregues.`, tone: "success" }); }
          catch (error) { Object.assign(state, { message: /** @type {Error} */ (error).message, tone: "danger" }); }
          await render();
        }
      });
    }
    return async () => { bind(); await render(); };
  };
})();
