// @ts-check
// Análise (A1): vendas por canal e conta e mais vendidos multicanal. Registra as views; o hub-app.js entrega o kit.
(function () {
  "use strict";

  const registry = /** @type {Record<string, (kit: any) => () => Promise<void>>} */ ((/** @type {any} */ (window).DachHubViews ||= {}));
  const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const money = (/** @type {unknown} */ v) => BRL.format(Number(v) || 0);
  const pct = (/** @type {unknown} */ v) => `${String(Math.round((Number(v) || 0) * 10) / 10).replace(".", ",")}%`;
  /** Cor de cada canal nas barras (outros canais usam o violeta do Hub). */
  const CHANNEL_COLORS = /** @type {Record<string, string>} */ ({ mercadolivre: "#f5c400", shopee: "#ff5a2f", magalu: "#1683e8" });
  const color = (/** @type {string} */ channel) => CHANNEL_COLORS[channel] || "var(--seller-accent, #7c5cff)";

  /** Filtros vêm da URL (de, ate, canal, conta): o link copiado abre a mesma análise. */
  function readFilters() {
    const q = new URLSearchParams(location.search);
    return { from: q.get("de") || "", to: q.get("ate") || "", channel: q.get("canal") || "", accountId: q.get("conta") || "", sort: q.get("ordem") === "units" ? "units" : "revenue" };
  }
  /** @param {ReturnType<typeof readFilters>} f */
  function writeFilters(f) {
    const q = new URLSearchParams();
    if (f.from) q.set("de", f.from);
    if (f.to) q.set("ate", f.to);
    if (f.channel) q.set("canal", f.channel);
    if (f.accountId) q.set("conta", f.accountId);
    if (f.sort === "units") q.set("ordem", "units");
    history.replaceState(null, "", `${location.pathname}${q.toString() ? `?${q}` : ""}`);
  }
  /** @param {ReturnType<typeof readFilters>} f @param {any} [extra] */
  const apiQuery = (f, extra = {}) => {
    const q = new URLSearchParams();
    if (f.from) q.set("from", f.from);
    if (f.to) q.set("to", f.to);
    if (f.channel) q.set("channel", f.channel);
    if (f.accountId) q.set("accountId", f.accountId);
    for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
    return q.toString();
  };
  /** Mesmo período nas outras telas da análise. @param {ReturnType<typeof readFilters>} f */
  const carry = (f) => { const q = new URLSearchParams(); if (f.from) q.set("de", f.from); if (f.to) q.set("ate", f.to); if (f.channel) q.set("canal", f.channel); return q.toString() ? `?${q}` : ""; };

  /** Dia "AAAA-MM-DD" de hoje − n, no fuso do navegador. @param {number} n */
  const daysAgo = (n) => { const d = new Date(Date.now() - n * 86400e3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const PRESETS = [["7", "7 dias"], ["30", "30 dias"], ["90", "90 dias"], ["month", "Este mês"]];

  /** @param {any} kit @param {ReturnType<typeof readFilters>} f @param {any} period @param {string} [extra] */
  function toolbar(kit, f, period, extra = "") {
    const { esc, CHANNEL_LABELS } = kit;
    return `<form class="hub-toolbar" data-analytics-filter>
      <div class="hub-segment" role="group" aria-label="Período rápido">${PRESETS.map(([k, label]) => `<button class="seller-btn hub-btn-xs" type="button" data-preset="${k}">${esc(label)}</button>`).join("")}</div>
      <label class="hub-check">De <input type="date" name="from" value="${esc(period.from)}"></label>
      <label class="hub-check">Até <input type="date" name="to" value="${esc(period.to)}"></label>
      <select name="channel" aria-label="Canal"><option value="">Todos os canais</option>${Object.entries(CHANNEL_LABELS).map(([id, label]) => `<option value="${esc(id)}" ${f.channel === id ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>
      ${extra}
      <button class="seller-btn seller-btn--primary" type="submit">Ver</button>
    </form>
    <p class="hub-muted">${esc(fmtDay(period.from))} a ${esc(fmtDay(period.to))} (${kit.int(period.days)} dias), comparado a ${esc(fmtDay(period.previous.from))} a ${esc(fmtDay(period.previous.to))}.</p>`;
  }
  const fmtDay = (/** @type {string} */ d) => d.split("-").reverse().join("/");

  /** Variação com seta e cor. @param {number | null} v @param {boolean} [inverse] para métricas em que subir é ruim */
  function delta(v, inverse = false) {
    if (v == null) return '<small class="hub-muted">sem base anterior</small>';
    const good = inverse ? v < 0 : v > 0;
    const cls = v === 0 ? "hub-muted" : good ? "hub-up" : "hub-down";
    return `<small class="${cls}">${v > 0 ? "▲" : v < 0 ? "▼" : "="} ${pct(Math.abs(v))} vs. anterior</small>`;
  }

  /** @param {any} kit @param {() => Promise<void>} render @param {() => ReturnType<typeof readFilters>} getState @param {(f: any) => void} setState */
  function bindFilters(kit, render, getState, setState) {
    kit.root.addEventListener("click", (/** @type {Event} */ event) => {
      const preset = /** @type {HTMLElement} */ (event.target).closest("[data-preset]");
      if (!preset) return;
      const k = preset.getAttribute("data-preset");
      const to = daysAgo(0);
      const from = k === "month" ? `${to.slice(0, 8)}01` : daysAgo(Number(k) - 1);
      setState({ ...getState(), from, to });
      render().catch(showError(kit));
    });
    kit.root.addEventListener("submit", (/** @type {Event} */ event) => {
      const form = /** @type {HTMLFormElement} */ (event.target);
      if (!form.matches("[data-analytics-filter]")) return;
      event.preventDefault();
      const data = new FormData(form);
      setState({ ...getState(), from: String(data.get("from") || ""), to: String(data.get("to") || ""), channel: String(data.get("channel") || ""), sort: data.get("sort") === "units" ? "units" : getState().sort });
      render().catch(showError(kit));
    });
  }
  /** @param {any} kit */
  const showError = (kit) => (/** @type {Error} */ error) => {
    const flash = kit.root.querySelector("[data-analytics-error]");
    if (flash) { flash.hidden = false; flash.textContent = error.message; } else kit.root.innerHTML = kit.empty("Não foi possível carregar", error.message);
  };

  /* ───────────── Vendas por canal ───────────── */
  registry.salesAnalysis = (kit) => {
    const { api, esc, int, root, empty, CHANNEL_LABELS } = kit;
    let state = readFilters();
    let bound = false;

    /** @param {any} row @param {boolean} withAccount */
    const line = (row, withAccount) => `<tr>
      <td><span class="seller-badge"><i class="hub-dot" style="background:${color(row.channel)}"></i>${esc(CHANNEL_LABELS[row.channel] || row.channel)}</span>${withAccount ? `<br><small>${esc(row.account)}</small>` : ""}</td>
      <td class="hub-num"><strong>${money(row.gmv)}</strong><br>${delta(row.change.gmv)}</td>
      <td><div class="hub-share" aria-label="${pct(row.share)} do faturamento"><i style="width:${Math.min(100, row.share)}%;background:${color(row.channel)}"></i></div><small>${pct(row.share)}</small></td>
      <td class="hub-num">${int(row.orders)}<br>${delta(row.change.orders)}</td>
      <td class="hub-num">${money(row.ticket)}</td>
      <td class="hub-num">${int(row.cancelledOrders)}<br><small class="hub-muted">${pct(row.cancelRate)}</small></td>
      ${withAccount ? `<td><a class="seller-btn hub-btn-xs" href="/hub/analise/produtos${carry(state)}${carry(state) ? "&" : "?"}conta=${esc(row.accountId)}">Mais vendidos</a></td>` : ""}
    </tr>`;
    /** @param {any[]} rows @param {boolean} withAccount */
    const table = (rows, withAccount) => `<div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>${withAccount ? "Conta" : "Canal"}</th><th class="hub-num">Faturamento</th><th>Participação</th><th class="hub-num">Pedidos</th><th class="hub-num">Ticket médio</th><th class="hub-num">Cancelados</th>${withAccount ? "<th></th>" : ""}</tr></thead>
      <tbody>${rows.map((r) => line(r, withAccount)).join("")}</tbody></table></div>`;

    async function render() {
      writeFilters(state);
      const data = await api(`/analytics/sales?${apiQuery(state)}`);
      state = { ...state, from: data.period.from, to: data.period.to };
      const t = data.totals;
      const filters = toolbar(kit, state, data.period);
      if (!data.accounts.length) {
        root.innerHTML = `<section class="seller-card">${filters}</section>${empty("Nenhuma venda no período", "Escolha outro período ou confira em Saúde das contas se os pedidos estão chegando.")}`;
        return;
      }
      root.innerHTML = `
        <section class="seller-card">${filters}<div class="hub-flash" data-tone="danger" data-analytics-error hidden></div></section>
        <section class="seller-grid">
          <article class="seller-kpi"><span>Faturamento</span><strong>${money(t.gmv)}</strong>${delta(t.change.gmv)}</article>
          <article class="seller-kpi"><span>Pedidos</span><strong>${int(t.orders)}</strong>${delta(t.change.orders)}</article>
          <article class="seller-kpi"><span>Ticket médio</span><strong>${money(t.ticket)}</strong>${delta(t.change.ticket)}</article>
          <article class="seller-kpi"><span>Cancelados e devolvidos</span><strong>${int(t.cancelledOrders)}</strong><small>${pct(t.cancelRate)} dos pedidos · ${money(t.cancelledValue)}</small></article>
        </section>
        <section class="seller-card"><h2>Por canal</h2>${table(data.channels, false)}
          <p class="hub-muted">Faturamento = valor dos produtos dos pedidos não cancelados, pela data da compra. Frete fica de fora.</p></section>
        <section class="seller-card"><h2>Por conta</h2>${table(data.accounts, true)}</section>
        <p><a class="seller-btn" href="/hub/analise/produtos${carry(state)}">Ver os mais vendidos deste período →</a></p>`;
    }

    return async () => {
      if (!bound) { bound = true; bindFilters(kit, render, () => state, (f) => { state = f; }); }
      await render();
    };
  };

  /* ───────────── Mais vendidos ───────────── */
  registry.topProducts = (kit) => {
    const { api, esc, int, root, empty, CHANNEL_LABELS } = kit;
    let state = readFilters();
    let bound = false;
    const ABC_TONES = /** @type {Record<string, string>} */ ({ A: "success", B: "warning", C: "" });

    /** @param {any[]} channels */
    const split = (channels) => `<div class="hub-share">${channels.map((c) => `<i style="width:${c.share}%;background:${color(c.channel)}" title="${esc(CHANNEL_LABELS[c.channel] || c.channel)}: ${pct(c.share)}"></i>`).join("")}</div>
      <small>${channels.map((c) => `<span class="hub-nowrap"><i class="hub-dot" style="background:${color(c.channel)}"></i>${esc(CHANNEL_LABELS[c.channel] || c.channel)} ${pct(c.share)}</span>`).join(" ")}</small>`;

    async function render() {
      writeFilters(state);
      const data = await api(`/analytics/products?${apiQuery(state, { sort: state.sort, limit: 100 })}`);
      state = { ...state, from: data.period.from, to: data.period.to };
      const sortSelect = `<select name="sort" aria-label="Ordenar por"><option value="revenue" ${state.sort === "revenue" ? "selected" : ""}>Por faturamento</option><option value="units" ${state.sort === "units" ? "selected" : ""}>Por unidades</option></select>`;
      const filters = toolbar(kit, state, data.period, sortSelect);
      if (!data.products.length) {
        root.innerHTML = `<section class="seller-card">${filters}</section>${empty("Nenhum produto vendido no período", "Escolha outro período ou outro canal.")}`;
        return;
      }
      const account = state.accountId ? `<div class="hub-flash">Mostrando só uma conta. <a href="/hub/analise/produtos${carry(state)}">Ver todas as contas</a>.</div>` : "";
      const pending = data.pending.products ? `<div class="hub-flash" data-tone="warning"><strong>${int(data.pending.products)} produto(s) vendidos sem vínculo</strong> (${money(data.pending.revenue)}) aparecem pelo SKU do canal e não somam com os outros canais. <a href="/hub/pendencias">Ligar em Pendências</a>.</div>` : "";
      root.innerHTML = `
        <section class="seller-card">${filters}<div class="hub-flash" data-tone="danger" data-analytics-error hidden></div></section>
        ${account}${pending}
        <section class="seller-grid">
          <article class="seller-kpi"><span>Produtos vendidos</span><strong>${int(data.total)}</strong><small>no período</small></article>
          ${data.abc.map((/** @type {any} */ a) => `<article class="seller-kpi"><span>Curva ${a.cls}</span><strong>${int(a.products)}</strong><small>${money(a.revenue)} · ${a.cls === "A" ? "até 80% do total" : a.cls === "B" ? "de 80% a 95%" : "os últimos 5%"}</small></article>`).join("")}
        </section>
        <section class="seller-card">
          <div class="hub-toolbar"><h2>Ranking ${state.sort === "units" ? "por unidades" : "por faturamento"}</h2><span class="hub-toolbar__spacer"></span>
            <a class="seller-btn" href="/hub/api/analytics/products.csv?${apiQuery(state, { sort: state.sort })}">Exportar CSV</a></div>
          <div class="seller-table-wrap"><table class="seller-table"><thead><tr><th class="hub-num">#</th><th>Produto</th><th>Curva</th><th class="hub-num">Unidades</th><th class="hub-num">Faturamento</th><th class="hub-num">Participação</th><th>Por canal</th></tr></thead><tbody>
          ${data.products.map((/** @type {any} */ p) => `<tr>
            <td class="hub-num">${int(p.rank)}</td>
            <td><strong>${esc(p.sku)}</strong>${p.pending ? ' <span class="seller-badge" data-tone="warning">sem vínculo</span>' : ""}<br><small>${esc(p.name || "")}</small></td>
            <td><span class="seller-badge" ${ABC_TONES[p.abc] ? `data-tone="${ABC_TONES[p.abc]}"` : ""}>${esc(p.abc)}</span></td>
            <td class="hub-num">${int(p.units)}</td>
            <td class="hub-num">${money(p.revenue)}</td>
            <td class="hub-num">${pct(p.share)}<br><small class="hub-muted">acum. ${pct(p.cumulative)}</small></td>
            <td>${split(p.channels)}</td></tr>`).join("")}
          </tbody></table></div>
          ${data.total > data.products.length ? `<p class="hub-muted">Mostrando os ${int(data.products.length)} primeiros de ${int(data.total)}. O CSV traz até 500.</p>` : ""}
        </section>`;
    }

    return async () => {
      if (!bound) { bound = true; bindFilters(kit, render, () => state, (f) => { state = f; }); }
      await render();
    };
  };
})();
