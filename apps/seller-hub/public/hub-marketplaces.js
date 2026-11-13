// @ts-check
// Marketplaces do DACH Hub (fase 1): visão geral, anúncios de cada canal e regras de preço e de estoque por conta.
// Nada aqui escreve nos canais: preço é gravado e simulado; estoque segue o modo de cada conta.
(function () {
  "use strict";

  /** Ferramentas entregues pelo hub-app.js (api, esc, int, root, main...). @typedef {any} HubKit */
  const registry = /** @type {Record<string, (kit: any) => () => Promise<void>>} */ ((/** @type {any} */ (window).DachHubViews ||= {}));
  const stockApi = () => /** @type {any} */ (window).DachHubStock || {};

  const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const money = (/** @type {unknown} */ v) => (v == null || v === "" ? "—" : BRL.format(Number(v)));
  /** Número para campo de texto (vírgula decimal). @param {unknown} v */
  const decimal = (v) => (v == null || v === "" ? "" : String(Number(v)).replace(".", ","));
  const PAGE_SIZE = 50;

  /** Marketplaces do menu (id, rótulo e endereço), vindos da página. @param {HTMLElement} main */
  function menuOf(main) {
    try { return /** @type {Array<{ id: string, label: string, slug: string }>} */ (JSON.parse(main.dataset.marketplaces || "[]")); } catch { return []; }
  }

  /** Como cada canal identifica o anúncio. @param {string} channel @param {any} l */
  function channelCodes(channel, l) {
    if (channel === "mercadolivre") return `${l.listingId}${l.variationId ? ` · variação ${l.variationId}` : ""}`;
    if (channel === "shopee") return `Item ${l.listingId}${l.variationId ? ` · modelo ${l.variationId}` : ""}`;
    if (channel === "magalu") return `SKU ${l.listingId}`;
    return `${l.listingId}${l.variationId ? ` · ${l.variationId}` : ""}`;
  }

  const STATUS = /** @type {Record<string, [string, string]>} */ ({ active: ["Ativo", "success"], paused: ["Pausado", ""], other: ["Outro", "warning"] });
  /** Nome da situação que não é ativo nem pausado, como o canal manda (ML closed, Shopee BANNED...). */
  const OTHER_STATUS = /** @type {Record<string, string>} */ ({ closed: "Encerrado", under_review: "Em revisão", reviewing: "Em revisão", banned: "Bloqueado", deleted: "Excluído", inactive: "Inativo" });
  /** Mesmo SKU, sem diferença de maiúsculas, espaços e traços. @param {unknown} a @param {unknown} b */
  const sameSku = (a, b) => String(a || "").toLowerCase().replace(/[\s_-]+/g, "") === String(b || "").toLowerCase().replace(/[\s_-]+/g, "");
  const PRICE_SOURCE = /** @type {Record<string, string>} */ ({ listing: "regra do anúncio", account: "regra da conta", default: "sem regra: preço de venda" });
  const MODE = /** @type {Record<string, [string, string]>} */ ({ off: ["Estoque desligado", ""], observe: ["Observação", "accent"], active: ["Envio ativo", "success"] });

  /* ───────────── Regra de preço: campos, leitura e simulação ───────────── */

  /** Ajuste da tela (com sentido) a partir da regra gravada. @param {any} rule */
  function adjustChoice(rule) {
    if (!rule) return { choice: "pct_up", value: "" };
    if (rule.adjust === "fixed") return { choice: "fixed", value: decimal(rule.value) };
    const kind = rule.adjust === "amount" ? "amount" : "pct";
    return { choice: `${kind}_${Number(rule.value) < 0 ? "down" : "up"}`, value: decimal(Math.abs(Number(rule.value) || 0)) };
  }

  /** @param {string} choice */
  const valueLabel = (choice) => (choice === "fixed" ? "Preço fixo (R$)" : choice.startsWith("pct") ? "Valor (%)" : "Valor (R$)");

  /**
   * Formulário da regra de preço (conta ou anúncio), com simulação por preço de exemplo.
   * @param {(v: unknown) => string} esc
   * @param {{ kind: "account" | "listing", id: number, rule: any, canEdit: boolean, hasRule: boolean }} input
   */
  function priceForm(esc, { kind, id, rule, canEdit, hasRule }) {
    const r = rule || { base: "sale", adjust: "pct", value: 0, rounding: "none", showFrom: "sale", minPrice: null };
    const { choice, value } = adjustChoice(rule);
    const off = canEdit ? "" : "disabled";
    /** @param {string} name @param {Array<[string, string]>} options @param {string} current @param {string} [extra] */
    const select = (name, options, current, extra = "") =>
      `<select name="${name}" ${off} ${extra}>${options.map(([v, t]) => `<option value="${v}" ${v === current ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
    return `<form class="hub-form hub-price-form" data-price-form="${kind}:${id}">
      <div class="hub-form-grid hub-form-grid--3">
        <label><span>Preço de partida</span>${select("base", [["sale", "Preço de venda"], ["promo_or_sale", "Preço promocional (se houver)"], ["cost", "Preço de custo"]], r.base, choice === "fixed" ? "data-fixed-off disabled" : "")}</label>
        <label><span>Ajuste</span>${select("adjust", [["pct_up", "Acréscimo em %"], ["pct_down", "Desconto em %"], ["amount_up", "Acréscimo em R$"], ["amount_down", "Desconto em R$"], ["fixed", "Preço fixo"]], choice)}</label>
        <label><span data-value-label>${valueLabel(choice)}</span><input name="value" type="text" inputmode="decimal" placeholder="0" value="${esc(value)}" ${off}></label>
        <label><span>Arredondar para</span>${select("rounding", [["none", "Não arredondar"], ["90", "Final ,90"], ["99", "Final ,99"]], r.rounding)}</label>
        <label><span>Preço "de" (riscado)</span>${select("showFrom", [["sale", "Preço de venda com o mesmo ajuste"], ["none", "Não mostrar"]], r.showFrom)}</label>
        <label><span>Preço mínimo no canal (R$)</span><input name="minPrice" type="text" inputmode="decimal" placeholder="Sem mínimo" value="${esc(decimal(r.minPrice))}" ${off}></label>
      </div>
      <div class="hub-preview">
        <div class="hub-preview__inputs"><strong>Simular com um produto de exemplo</strong>
          <label><span>Preço de venda</span><input name="sampleSale" type="text" inputmode="decimal" value="100,00"></label>
          <label><span>Promocional</span><input name="samplePromo" type="text" inputmode="decimal" placeholder="—"></label>
          <label><span>Custo</span><input name="sampleCost" type="text" inputmode="decimal" placeholder="—"></label>
        </div>
        <p class="hub-preview__result" data-price-result aria-live="polite">Calculando…</p>
      </div>
      ${canEdit ? `<div class="hub-actions hub-actions--start"><button class="seller-btn seller-btn--primary" type="submit">Salvar regra de preço</button>
        ${hasRule ? `<button class="seller-btn" type="button" data-price-clear="${kind}:${id}">${kind === "listing" ? "Remover regra do anúncio" : "Remover regra"}</button>` : ""}
        <small data-form-error class="hub-error"></small></div>` : ""}
    </form>`;
  }

  /**
   * Regra a partir do formulário (o servidor confere tudo de novo). Lê os campos direto
   * (campo desabilitado fica fora do FormData). @param {HTMLFormElement} form
   */
  function priceRuleFromForm(form) {
    const field = (/** @type {string} */ name) => String(/** @type {HTMLInputElement | null} */ (form.querySelector(`[name="${name}"]`))?.value || "").trim();
    const choice = field("adjust") || "pct_up";
    const raw = field("value");
    return {
      base: field("base") || "sale",
      adjust: choice === "fixed" ? "fixed" : choice.startsWith("amount") ? "amount" : "pct",
      value: raw ? (choice.endsWith("_down") ? `-${raw}` : raw) : "0",
      rounding: field("rounding") || "none",
      showFrom: field("showFrom") || "sale",
      minPrice: field("minPrice"),
    };
  }

  /** Texto do resultado da simulação. @param {any} result */
  function previewText(result) {
    if (result.reason === "no_sale_price") return "Informe o preço de venda do exemplo.";
    if (result.reason === "no_cost") return "Informe o custo do exemplo: esta regra parte do preço de custo.";
    if (result.reason === "non_positive") return "O desconto deixaria o preço zerado ou negativo.";
    const notes = [];
    if (result.baseUsed === "promo") notes.push("partiu do preço promocional");
    if (result.minApplied) notes.push("subiu para o preço mínimo");
    return `Iria para o canal: <strong>${money(result.price)}</strong>${result.fromPrice ? ` <span class="hub-muted">de <s>${money(result.fromPrice)}</s></span>` : ""}${notes.length ? ` <span class="hub-muted">(${notes.join("; ")})</span>` : ""}`;
  }

  /**
   * Liga os formulários de preço de uma tela: troca de ajuste, simulação, salvar e remover.
   * @param {HubKit} kit @param {() => Promise<void>} rerender
   */
  function bindPriceForms(kit, rerender) {
    const { api, root } = kit;
    /** @type {Map<HTMLFormElement, number>} */
    const timers = new Map();
    /** @param {HTMLFormElement} form */
    async function preview(form) {
      const out = /** @type {HTMLElement | null} */ (form.querySelector("[data-price-result]"));
      if (!out) return;
      const data = new FormData(form);
      try {
        const { result } = await api("/marketplaces/price-preview", { method: "POST", body: JSON.stringify({
          rule: priceRuleFromForm(form), sample: { salePrice: data.get("sampleSale"), promoPrice: data.get("samplePromo"), cost: data.get("sampleCost") },
        }) });
        out.innerHTML = previewText(result);
        out.classList.remove("hub-error");
      } catch (error) {
        out.textContent = /** @type {Error} */ (error).message;
        out.classList.add("hub-error");
      }
    }
    /** @param {HTMLFormElement} form */
    function schedule(form) {
      window.clearTimeout(timers.get(form));
      timers.set(form, window.setTimeout(() => { preview(form).catch(() => {}); }, 250));
    }
    /** @param {Event} event */
    function onEdit(event) {
      const form = /** @type {HTMLElement} */ (event.target).closest("[data-price-form]");
      if (!(form instanceof HTMLFormElement)) return;
      const adjust = /** @type {HTMLSelectElement} */ (form.querySelector("[name=adjust]"));
      if (event.target === adjust) {
        const label = form.querySelector("[data-value-label]");
        if (label) label.textContent = valueLabel(adjust.value);
        const base = /** @type {HTMLSelectElement} */ (form.querySelector("[name=base]"));
        base.disabled = adjust.value === "fixed" || adjust.disabled;
      }
      schedule(form);
    }
    root.addEventListener("input", onEdit);
    root.addEventListener("change", onEdit);
    root.addEventListener("submit", async (event) => {
      const form = /** @type {HTMLFormElement} */ (event.target);
      if (!form.matches("[data-price-form]")) return;
      event.preventDefault();
      const [kind, id] = String(form.dataset.priceForm).split(":");
      const error = /** @type {HTMLElement} */ (form.querySelector("[data-form-error]"));
      try {
        await api(`/marketplaces/${kind === "listing" ? "listings" : "accounts"}/${id}/price-rule`, { method: "PUT", body: JSON.stringify({ rule: priceRuleFromForm(form) }) });
        await rerender();
        const again = /** @type {HTMLElement | null} */ (root.querySelector(`[data-price-form="${kind}:${id}"] [data-form-error]`));
        if (again) { again.textContent = "Regra salva."; again.className = "hub-ok"; }
      } catch (err) { error.textContent = /** @type {Error} */ (err).message; error.className = "hub-error"; }
    });
    root.addEventListener("click", async (event) => {
      const clear = /** @type {HTMLElement} */ (event.target).closest("[data-price-clear]");
      if (!clear) return;
      const [kind, id] = String(clear.getAttribute("data-price-clear")).split(":");
      if (!confirm(kind === "listing" ? "Remover a regra deste anúncio? Ele volta a seguir a regra da conta." : "Remover a regra de preço da conta? Os anúncios voltam ao preço de venda do cadastro, sem ajuste.")) return;
      await api(`/marketplaces/${kind === "listing" ? "listings" : "accounts"}/${id}/price-rule`, { method: "PUT", body: JSON.stringify({ rule: null }) });
      await rerender();
    });
    return { previewAll: () => root.querySelectorAll("form[data-price-form]").forEach((f) => { preview(/** @type {HTMLFormElement} */ (f)).catch(() => {}); }) };
  }

  /* ───────────── Visão geral dos marketplaces ───────────── */
  registry.marketplaces = (kit) => {
    const { api, esc, int, root, main } = kit;
    return async () => {
      const { marketplaces } = await api("/marketplaces");
      const slugs = new Map(menuOf(main).map((m) => [m.id, m.slug]));
      root.innerHTML = `<section class="hub-mp-grid">${marketplaces.map((/** @type {any} */ m) => {
        const base = `/hub/marketplaces/${slugs.get(m.id) || m.id}`;
        const state = m.reconnect ? `<span class="seller-badge" data-tone="danger">${int(m.reconnect)} conta(s) para reconectar</span>`
          : !m.accounts && !m.available ? '<span class="seller-badge" data-tone="warning">Aguardando app do canal</span>'
            : !m.accounts ? '<span class="seller-badge">Nenhuma conta conectada</span>' : '<span class="seller-badge" data-tone="success">Conectado</span>';
        return `<article class="seller-card hub-mp-card">
          <div class="hub-account-head"><h2>${esc(m.label)}</h2>${state}</div>
          <div class="hub-metrics hub-metrics--3">
            <div class="hub-metric"><span>Contas</span><strong>${int(m.accounts)}</strong></div>
            <div class="hub-metric"><span>Anúncios</span><strong>${int(m.listings)}</strong></div>
            <div class="hub-metric" ${m.unlinked ? 'data-tone="warning"' : ""}><span>Sem vínculo</span><strong>${int(m.unlinked)}</strong></div>
          </div>
          <div class="hub-actions hub-actions--start">
            ${m.accounts ? `<a class="seller-btn seller-btn--primary" href="${base}">Ver anúncios</a>` : `<a class="seller-btn seller-btn--primary" href="${base}/configuracoes">Conectar conta</a>`}
            <a class="seller-btn" href="${base}/configuracoes">Contas</a><a class="seller-btn" href="${base}/configuracoes/regras">Regras</a>
          </div></article>`;
      }).join("")}</section>`;
    };
  };

  /* ───────────── Anúncios do canal ───────────── */
  registry.mpListings = (kit) => {
    const { api, esc, int, root, main, isAdmin, empty, CHANNEL_LABELS } = kit;
    const channel = String(main.dataset.channel || "");
    const slug = menuOf(main).find((m) => m.id === channel)?.slug || channel;
    const params = new URLSearchParams(location.search);
    const state = {
      accountId: params.get("conta") || "", q: params.get("q") || "", status: params.get("status") || "",
      link: params.get("vinculo") || "", priceRule: params.get("regra") || "", offset: 0,
    };
    /** @type {any[]} */
    let accounts = [];
    /** @type {Map<number, any>} */
    let rowsById = new Map();
    let bound = false;
    /** @type {{ previewAll: () => void } | null} */
    let priceForms = null;

    /** Estoque do anúncio: só leitura, vem do cadastro e da regra da conta. @param {any} s @param {boolean} fulfillment */
    function stockCell(s, fulfillment) {
      const inChannel = s.channel == null ? "—" : int(s.channel);
      if (fulfillment) return `<strong>${inChannel} un.</strong><br><small>${channel === "mercadolivre" ? "Full" : "Fulfillment"}: estoque do canal</small>`;
      if (s.state === "unlinked") return `No canal: ${inChannel}<br><small>sem vínculo: o Hub não calcula</small>`;
      if (s.state === "no_stock") return `No canal: ${inChannel}<br><span class="seller-badge" data-tone="danger">Sem estoque no Hub</span>`;
      if (s.state === "account_off") return `No canal: ${inChannel}<br><small>estoque desligado nesta conta</small>`;
      if (s.state === "sync_off") return `No canal: ${inChannel}<br><small>sincronização pausada no anúncio</small>`;
      const tone = s.state === "increase" ? "success" : s.state === "decrease" ? "warning" : "";
      const label = s.state === "increase" ? "subiria" : s.state === "decrease" ? "desceria" : "igual";
      const describe = stockApi().describeRule;
      return `Hub: <strong>${int(s.desired)} un.</strong> <span class="seller-badge" ${tone ? `data-tone="${tone}"` : ""}>${label}</span><br>
        <small>No canal: ${inChannel} · disponível ${int(s.available)}${describe ? ` · ${esc(describe(s.rule))}` : ""}</small>`;
    }

    async function render() {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(state.offset) });
      if (state.accountId) query.set("accountId", state.accountId);
      for (const [key, value] of /** @type {Array<[string, string]>} */ ([["q", state.q], ["status", state.status], ["link", state.link], ["priceRule", state.priceRule]])) if (value) query.set(key, value);
      const [{ summary, rows, total }, rules] = await Promise.all([
        api(`/marketplaces/${encodeURIComponent(channel)}/listings?${query}`),
        accounts.length ? Promise.resolve({ accounts }) : api(`/marketplaces/${encodeURIComponent(channel)}/rules`),
      ]);
      accounts = rules.accounts;
      rowsById = new Map(rows.map((/** @type {any} */ r) => [Number(r.id), r]));
      const label = CHANNEL_LABELS[channel] || channel;
      if (!summary.total && !state.accountId) {
        root.innerHTML = empty(accounts.length ? "Nenhum anúncio importado ainda" : `Nenhuma conta conectada`,
          accounts.length ? "Os anúncios aparecem aqui depois da importação da conta." : `Conecte uma conta para ver os anúncios aqui.`,
          `<a class="seller-btn seller-btn--primary" href="/hub/marketplaces/${esc(slug)}/configuracoes">${accounts.length ? "Ver contas" : `Conectar ${esc(label)}`}</a>`);
        return;
      }
      const quick = /** @type {Array<[string, string, number, string]>} */ ([
        ["Todos", "", summary.total, ""], ["Ativos", "status:active", summary.active, ""], ["Pausados", "status:paused", summary.paused, ""],
        ...(summary.other ? /** @type {Array<[string, string, number, string]>} */ ([["Outros", "status:other", summary.other, ""]]) : []),
        ["Sem vínculo", "link:unlinked", summary.unlinked, summary.unlinked ? "warning" : ""],
        ["Com regra de preço própria", "priceRule:listing", summary.ownPriceRule, ""],
      ]);
      const activeQuick = state.status ? `status:${state.status}` : state.link ? `link:${state.link}` : state.priceRule ? `priceRule:${state.priceRule}` : "";
      root.innerHTML = `
        <nav class="hub-chips" aria-label="Filtros rápidos">${quick.map(([text, key, n, tone]) =>
          `<button type="button" class="hub-chip ${key === activeQuick ? "is-active" : ""}" data-quick="${key}">${esc(text)} <span class="seller-badge" ${tone ? `data-tone="${tone}"` : ""}>${int(n)}</span></button>`).join("")}</nav>
        <section class="seller-card">
          <form class="hub-mp-filters" data-mp-filter>
            <input type="search" name="q" placeholder="Código no canal, SKU ou título" value="${esc(state.q)}" aria-label="Buscar anúncio">
            <select name="accountId" aria-label="Conta"><option value="">Todas as contas</option>${accounts.map((/** @type {any} */ a) => `<option value="${esc(a.id)}" ${String(a.id) === state.accountId ? "selected" : ""}>${esc(a.label)}</option>`).join("")}</select>
            <select name="status" aria-label="Situação"><option value="">Todas as situações</option>${Object.entries(STATUS).map(([v, [t]]) => `<option value="${v}" ${v === state.status ? "selected" : ""}>${t}</option>`).join("")}</select>
            <select name="link" aria-label="Vínculo"><option value="">Com e sem vínculo</option><option value="linked" ${state.link === "linked" ? "selected" : ""}>Ligados a um produto</option><option value="unlinked" ${state.link === "unlinked" ? "selected" : ""}>Sem vínculo</option></select>
            <select name="priceRule" aria-label="Regra de preço"><option value="">Qualquer regra de preço</option><option value="account" ${state.priceRule === "account" ? "selected" : ""}>Regra da conta</option><option value="listing" ${state.priceRule === "listing" ? "selected" : ""}>Regra do anúncio</option><option value="default" ${state.priceRule === "default" ? "selected" : ""}>Sem regra</option></select>
            <button class="seller-btn seller-btn--primary" type="submit">Filtrar</button><button class="seller-btn" type="button" data-mp-clear>Limpar</button>
          </form>
          <p class="hub-note">Estoque vem do cadastro do produto e da regra de estoque da conta; aqui é só para conferir. A regra de preço fica gravada e o envio de preço aos canais chega numa próxima etapa. Regras da conta em <a href="/hub/marketplaces/${esc(slug)}/configuracoes/regras">Regras de preço e estoque</a>.</p>
          ${rows.length ? `<div class="seller-table-wrap"><table class="seller-table hub-mp-table"><thead><tr><th>Anúncio</th><th class="hub-num">Preço no canal</th><th>Regra de preço</th><th>Estoque</th><th>Situação</th><th></th></tr></thead><tbody>
            ${rows.map((/** @type {any} */ l) => {
              const [groupLabel, tone] = STATUS[l.statusGroup] || STATUS.other;
              const statusLabel = l.statusGroup === "other" ? OTHER_STATUS[String(l.status || "").toLowerCase()] || groupLabel : groupLabel;
              const showChannelSku = l.channelSku && l.channelSku !== l.listingId && !(l.item && sameSku(l.channelSku, l.item.sku));
              const showItemName = l.item?.name && l.item.name !== l.title;
              return `<tr data-row="${esc(l.id)}">
                <td><strong>${esc(l.title || l.listingId)}</strong>${l.fulfillment ? ` <span class="seller-badge">${channel === "mercadolivre" ? "Full" : "Fulfillment"}</span>` : ""}<br>
                  <small>${esc(l.accountLabel)} · ${esc(channelCodes(channel, l))}${showChannelSku ? ` · SKU no canal ${esc(l.channelSku)}` : ""}</small><br>
                  ${l.item ? `<small>Produto no Hub: <strong>${esc(l.item.sku)}</strong>${showItemName ? ` · ${esc(l.item.name)}` : ""}</small>` : `<span class="seller-badge" data-tone="warning">Sem vínculo</span> <a class="hub-link-sm" href="/hub/pendencias">Vincular</a>`}</td>
                <td class="hub-num">${money(l.price.channel)}</td>
                <td>${esc(l.price.ruleText)}<br><small>${esc(PRICE_SOURCE[l.price.ruleSource] || "")}</small></td>
                <td>${stockCell(l.stock, l.fulfillment)}</td>
                <td><span class="seller-badge" ${tone ? `data-tone="${tone}"` : ""} title="${esc(l.status || "")}">${esc(statusLabel)}</span></td>
                <td>${isAdmin ? `<button class="seller-btn hub-btn-xs" type="button" data-listing-price="${esc(l.id)}">Regra de preço</button>` : ""}</td></tr>`;
            }).join("")}</tbody></table></div>`
            : '<div class="seller-empty"><strong>Nada a mostrar</strong><span>Nenhum anúncio com estes filtros.</span></div>'}
          ${total > PAGE_SIZE ? `<div class="hub-pager"><button class="seller-btn" type="button" data-page="${Math.max(0, state.offset - PAGE_SIZE)}" ${state.offset ? "" : "disabled"}>Anterior</button>
            <span>${int(state.offset + 1)}–${int(Math.min(total, state.offset + PAGE_SIZE))} de ${int(total)}</span>
            <button class="seller-btn" type="button" data-page="${state.offset + PAGE_SIZE}" ${state.offset + PAGE_SIZE < total ? "" : "disabled"}>Próxima</button></div>` : ""}
        </section>`;
    }

    function bind() {
      if (bound) return;
      bound = true;
      priceForms = bindPriceForms(kit, render);
      root.addEventListener("submit", async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (!form.matches("[data-mp-filter]")) return;
        event.preventDefault();
        const data = new FormData(form);
        Object.assign(state, { q: String(data.get("q") || ""), accountId: String(data.get("accountId") || ""), status: String(data.get("status") || ""),
          link: String(data.get("link") || ""), priceRule: String(data.get("priceRule") || ""), offset: 0 });
        await render();
      });
      root.addEventListener("click", async (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        const quick = target.closest("[data-quick]");
        if (quick) {
          const [key, value] = String(quick.getAttribute("data-quick")).split(":");
          Object.assign(state, { status: key === "status" ? value : "", link: key === "link" ? value : "", priceRule: key === "priceRule" ? value : "", offset: 0 });
          await render();
          return;
        }
        if (target.closest("[data-mp-clear]")) { Object.assign(state, { q: "", accountId: "", status: "", link: "", priceRule: "", offset: 0 }); await render(); return; }
        const page = target.closest("[data-page]");
        if (page) { state.offset = Number(page.getAttribute("data-page")) || 0; await render(); return; }
        const open = target.closest("[data-listing-price]");
        if (open) {
          const id = Number(open.getAttribute("data-listing-price"));
          const row = rowsById.get(id);
          root.querySelectorAll("[data-inline]").forEach((el) => el.remove());
          const own = row?.price.ruleSource === "listing";
          /** @type {HTMLElement} */ (open.closest("tr")).insertAdjacentHTML("afterend", `<tr data-inline><td colspan="6">
            <p class="hub-muted">${own ? "Este anúncio tem regra de preço própria, que vence a regra da conta." : `Hoje este anúncio segue a regra da conta: <strong>${esc(row?.price.ruleText || "")}</strong>. Salve abaixo uma regra só para ele.`}</p>
            ${priceForm(esc, { kind: "listing", id, rule: own ? row.price.rule : null, canEdit: isAdmin, hasRule: own })}</td></tr>`);
          priceForms?.previewAll();
        }
      });
    }

    return async () => { bind(); await render(); };
  };

  /* ───────────── Regras de preço e estoque por conta ───────────── */
  registry.mpRules = (kit) => {
    const { api, esc, int, root, main, isAdmin, empty, dateTime } = kit;
    const channel = String(main.dataset.channel || "");
    const slug = menuOf(main).find((m) => m.id === channel)?.slug || channel;
    let bound = false;
    /** @type {{ previewAll: () => void } | null} */
    let priceForms = null;

    async function render() {
      const { accounts } = await api(`/marketplaces/${encodeURIComponent(channel)}/rules`);
      if (!accounts.length) {
        root.innerHTML = empty("Nenhuma conta conectada", "Conecte uma conta para definir as regras de preço e de estoque.", `<a class="seller-btn seller-btn--primary" href="/hub/marketplaces/${esc(slug)}/configuracoes">Ver contas</a>`);
        return;
      }
      const stock = stockApi();
      root.innerHTML = `
        <section class="seller-card"><h2>Como as regras funcionam</h2>
          <p><strong>Preço:</strong> parte do preço do cadastro do produto (venda, promocional ou custo), aplica o ajuste, arredonda e respeita o preço mínimo. Nesta etapa a regra fica gravada e você confere com um produto de exemplo; o envio de preço aos canais chega numa próxima etapa.</p>
          <p><strong>Estoque:</strong> o saldo vem do cadastro do produto; a regra define quanto dele vai para a conta (igual, % ou fixo), tira a reserva de segurança, zera no limite e aplica o teto. Anúncio Full nunca recebe envio. O que é enviado depende do modo da conta (desligado, observação ou ativo), em <a href="/hub/estoque/regras">Estoque › Regras por conta</a>.</p>
          <p class="hub-muted">A regra própria de um anúncio vence a regra da conta. Crie na lista de anúncios, no botão "Regra de preço".</p></section>
        ${accounts.map((/** @type {any} */ a) => {
          const [modeLabel, modeTone] = MODE[a.mode] || [a.mode, ""];
          return `<section class="seller-card" id="conta-${esc(a.id)}">
            <div class="hub-account-head"><div><strong class="hub-account-name">${esc(a.label)}</strong>
              ${a.status === "reconnect_required" ? ' <span class="seller-badge" data-tone="danger">Reconectar</span>' : ""}
              <br><small class="hub-muted">${int(a.listings)} anúncio(s) · ${int(a.linked)} vinculado(s)</small></div>
              <div><span class="seller-badge" ${modeTone ? `data-tone="${modeTone}"` : ""}>${esc(modeLabel)}</span> <a class="hub-link-sm" href="/hub/estoque/regras">Alterar modo</a></div></div>
            <div class="hub-two-col">
              <div class="hub-rule-block"><h3>Regra de preço</h3>
                <p class="hub-muted">${a.priceRule ? `Atual: <strong>${esc(a.priceRuleText)}</strong>${a.priceRuleUpdatedAt ? ` · salva em ${esc(dateTime(a.priceRuleUpdatedAt))}` : ""}` : "Sem regra: os anúncios recebem o preço de venda do cadastro, sem ajuste."}
                  ${a.listingPriceRules ? `<br><a href="/hub/marketplaces/${esc(slug)}?conta=${esc(a.id)}&regra=listing">${int(a.listingPriceRules)} anúncio(s) com regra própria</a>` : ""}</p>
                ${priceForm(esc, { kind: "account", id: Number(a.id), rule: a.priceRule, canEdit: isAdmin, hasRule: Boolean(a.priceRule) })}
              </div>
              <div class="hub-rule-block"><h3>Regra de estoque</h3>
                <p class="hub-muted">Atual: <strong>${esc(stock.describeRule ? stock.describeRule(a.stockRule) : "")}</strong>${a.listingStockRules ? ` · ${int(a.listingStockRules)} anúncio(s) com exceção` : ""}
                  <br><a href="/hub/estoque/observacao?conta=${esc(a.id)}">Ver o que mudaria nesta conta</a></p>
                ${isAdmin && stock.ruleFields ? `<form class="hub-form" data-stock-rule="${esc(a.id)}">${stock.ruleFields(kit, a.stockRule, `a${a.id}`)}
                  <div class="hub-actions hub-actions--start"><button class="seller-btn seller-btn--primary" type="submit">Salvar regra de estoque</button><small data-form-error class="hub-error"></small></div></form>` : ""}
              </div>
            </div></section>`;
        }).join("")}`;
      priceForms?.previewAll();
    }

    function bind() {
      if (bound) return;
      bound = true;
      priceForms = bindPriceForms(kit, render);
      const onModeChange = stockApi().onRuleModeChange;
      if (onModeChange) root.addEventListener("change", onModeChange);
      root.addEventListener("submit", async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (!form.matches("[data-stock-rule]")) return;
        event.preventDefault();
        const error = /** @type {HTMLElement} */ (form.querySelector("[data-form-error]"));
        try {
          await api(`/stock/accounts/${form.dataset.stockRule}/rule`, { method: "PUT", body: JSON.stringify({ rule: stockApi().ruleFromForm(form) }) });
          await render();
          const again = /** @type {HTMLElement | null} */ (root.querySelector(`[data-stock-rule="${form.dataset.stockRule}"] [data-form-error]`));
          if (again) { again.textContent = "Regra salva."; again.className = "hub-ok"; }
        } catch (err) { error.textContent = /** @type {Error} */ (err).message; error.className = "hub-error"; }
      });
    }

    return async () => { bind(); await render(); };
  };

  /** Exposto para os testes de navegador e para depuração. */
  /** @type {any} */ (window).DachHubMarketplaces = { adjustChoice, channelCodes, previewText };
})();
