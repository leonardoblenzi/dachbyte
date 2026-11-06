// @ts-check
// Telas de estoque do DACH Hub (E2). Registra as views; o hub-app.js entrega as ferramentas (kit) e chama.
(function () {
  "use strict";

  /**
   * @typedef {{
   *   api: (path: string, init?: RequestInit) => Promise<any>, esc: (v: unknown) => string, int: (v: unknown) => string,
   *   dateTime: (v: string) => string, empty: (title: string, text: string, action?: string) => string,
   *   root: HTMLElement, main: HTMLElement, isAdmin: boolean, loadChannels: () => Promise<any[]>, CHANNEL_LABELS: Record<string, string>,
   * }} HubKit
   */

  const registry = /** @type {Record<string, (kit: HubKit) => () => Promise<void>>} */ ((/** @type {any} */ (window).DachHubViews ||= {}));

  const KIND_LABELS = /** @type {Record<string, string>} */ ({
    initial: "Estoque inicial", adjustment: "Ajuste", inventory: "Inventário", spreadsheet: "Planilha",
    sale: "Venda", cancellation: "Cancelamento", return: "Devolução",
  });
  const SOURCE_LABELS = /** @type {Record<string, string>} */ ({
    channels_lowest: "Menor estoque entre os canais", channel_account: "Estoque da conta de referência", manual: "Manual",
  });
  /** Origem legível: motivo digitado, nome da planilha ou o tipo de origem. @param {any} m */
  const movementOrigin = (m) => m.note || (m.sourceType === "spreadsheet" ? m.sourceId : SOURCE_LABELS[m.sourceType]) || m.sourceType || "—";
  const STATE_LABELS =/** @type {Record<string, [string, string]>} */ ({
    increase: ["Subiria", "success"], decrease: ["Desceria", "warning"], same: ["Igual", ""],
    fulfillment: ["Full: do canal", ""], sync_off: ["Sincronização pausada", ""], account_off: ["Conta desligada", ""], no_stock: ["Sem estoque informado", "danger"],
  });
  const PAGE_SIZE = 50;

  /** Texto curto da regra. @param {any} rule */
  function describeRule(rule) {
    if (!rule) return "Igual ao estoque";
    const parts = [rule.mode === "fixed" ? `Fixo: ${rule.value}` : rule.mode === "percent" ? `${rule.value}% do estoque` : "Igual ao estoque"];
    if (Number(rule.safetyReserve) > 0) parts.push(`reserva ${rule.safetyReserve}`);
    if (Number(rule.minLock) > 0) parts.push(`zera com ≤ ${rule.minLock}`);
    if (rule.cap != null) parts.push(`teto ${rule.cap}`);
    return parts.join(" · ");
  }

  /** Campos da regra (conta ou exceção do anúncio). @param {HubKit} kit @param {any} rule @param {string} _prefix */
  function ruleFields(kit, rule, _prefix) {
    const r = rule || { mode: "same", value: 0, cap: null, minLock: 0, safetyReserve: 0 };
    const { esc } = kit;
    return `<div class="hub-form-grid">
      <label><span>Quanto enviar</span><select name="mode" data-rule-mode>
        <option value="same" ${r.mode === "same" ? "selected" : ""}>Igual ao estoque</option>
        <option value="percent" ${r.mode === "percent" ? "selected" : ""}>Percentual do estoque</option>
        <option value="fixed" ${r.mode === "fixed" ? "selected" : ""}>Quantidade fixa</option></select></label>
      <label data-rule-value ${r.mode === "same" ? "hidden" : ""}><span>${r.mode === "percent" ? "Percentual (%)" : "Quantidade"}</span><input name="value" type="number" min="0" step="1" value="${esc(r.value ?? 0)}"></label>
      <label><span>Reserva de segurança</span><input name="safetyReserve" type="number" min="0" step="1" value="${esc(r.safetyReserve ?? 0)}"></label>
      <label><span>Zerar com estoque até</span><input name="minLock" type="number" min="0" step="1" value="${esc(r.minLock ?? 0)}"></label>
      <label><span>Teto (vazio = sem teto)</span><input name="cap" type="number" min="0" step="1" value="${r.cap == null ? "" : esc(r.cap)}"></label>
    </div>`;
  }

  /** @param {HTMLFormElement} form */
  function ruleFromForm(form) {
    const data = new FormData(form);
    return { mode: data.get("mode"), value: data.get("value"), safetyReserve: data.get("safetyReserve"), minLock: data.get("minLock"), cap: data.get("cap") };
  }

  /** Mostra/oculta o valor conforme o modo da regra. @param {Event} event */
  function onRuleModeChange(event) {
    const select = /** @type {HTMLSelectElement} */ (event.target);
    if (!select.matches("[data-rule-mode]")) return;
    const field = select.closest("form")?.querySelector("[data-rule-value]");
    if (!field) return;
    field.toggleAttribute("hidden", select.value === "same");
    const label = field.querySelector("span");
    if (label) label.textContent = select.value === "percent" ? "Percentual (%)" : "Quantidade";
  }

  /** Paginação simples. @param {HubKit} kit @param {number} offset @param {number} total @param {number} size */
  function pager(kit, offset, total, size) {
    if (total <= size) return "";
    return `<div class="hub-pager"><button class="seller-btn" type="button" data-page="${Math.max(0, offset - size)}" ${offset ? "" : "disabled"}>Anterior</button>
      <span>${kit.int(offset + 1)}–${kit.int(Math.min(total, offset + size))} de ${kit.int(total)}</span>
      <button class="seller-btn" type="button" data-page="${offset + size}" ${offset + size < total ? "" : "disabled"}>Próxima</button></div>`;
  }

  /** Lê o arquivo como base64 (sem o prefixo data:). @param {File} file @returns {Promise<string>} */
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || "").replace(/^data:[^,]*,/, ""));
      reader.onerror = () => reject(new Error("Não foi possível ler o arquivo."));
      reader.readAsDataURL(file);
    });
  }

  /** @param {HubKit} kit @param {Array<{ line: number, message: string }>} errors */
  function errorList(kit, errors) {
    if (!errors.length) return "";
    return `<div class="hub-flash" data-tone="danger"><strong>${kit.int(errors.length)} problema(s) na planilha</strong><ul class="hub-errors">${errors.slice(0, 30).map((e) => `<li>${e.line ? `Linha ${kit.int(e.line)}: ` : ""}${kit.esc(e.message)}</li>`).join("")}</ul>${errors.length > 30 ? `<small>… e mais ${kit.int(errors.length - 30)}.</small>` : ""}</div>`;
  }

  /* ───────────── Saldos ───────────── */
  registry.stock = (kit) => {
    const { api, esc, int, root, isAdmin, empty } = kit;
    const initialFilter = new URLSearchParams(location.search).get("filtro") || "all";
    const state = { q: "", filter: ["all", "no_stock", "kits", "low", "zero"].includes(initialFilter) ? initialFilter : "all", offset: 0, panel: /** @type {"" | "sheet" | "initial"} */ (""), sheet: /** @type {any} */ (null), initial: /** @type {any} */ (null) };
    let bound = false;

    async function render() {
      const params = new URLSearchParams({ q: state.q, filter: state.filter, limit: String(PAGE_SIZE), offset: String(state.offset) });
      const [{ summary, items, total }, rules] = await Promise.all([api(`/stock?${params}`), isAdmin ? api("/stock/rules") : Promise.resolve({ accounts: [] })]);
      if (!summary.items) { root.innerHTML = empty("Nenhum produto no catálogo", "O estoque aparece aqui depois da primeira importação de anúncios.", '<a class="seller-btn seller-btn--primary" href="/hub/contas">Ver contas</a>'); return; }
      const rowsHtml = items.map((/** @type {any} */ i) => `<tr data-row="${esc(i.id)}">
        <td><strong>${esc(i.sku)}</strong>${i.kind === "kit" ? ' <span class="seller-badge" data-tone="accent">Kit</span>' : ""}</td><td>${esc(i.name || "—")}</td>
        <td class="hub-num">${i.kind === "kit" ? "—" : i.hasStock ? int(i.onHand) : "—"}</td>
        <td class="hub-num">${i.available == null ? '<span class="seller-badge" data-tone="danger">Não informado</span>' : `<strong>${int(i.available)}</strong>`}</td>
        <td class="hub-num">${int(i.listings)}</td>
        <td><div class="hub-actions">${isAdmin && i.kind !== "kit" ? `<button class="seller-btn" type="button" data-adjust="${esc(i.id)}">Ajustar</button>` : ""}
          ${isAdmin ? `<button class="seller-btn" type="button" data-kit="${esc(i.id)}">Kit</button>` : ""}
          <a class="seller-btn" href="/hub/estoque/movimentos?item=${esc(i.id)}">Histórico</a></div></td></tr>`).join("");
      root.innerHTML = `
        <section class="seller-grid">
          <article class="seller-kpi"><span>Produtos</span><strong>${int(summary.items)}</strong><small>no catálogo</small></article>
          <article class="seller-kpi"><span>Com estoque informado</span><strong>${int(summary.withStock)}</strong><small>${int(summary.zero)} zerado(s)</small></article>
          <article class="seller-kpi"><span>Sem estoque informado</span><strong>${int(summary.missing)}</strong><small>o Hub não calcula envio para eles</small></article>
          <article class="seller-kpi"><span>Modo</span><strong>Observação</strong><small>nada é enviado aos canais</small></article>
        </section>
        ${summary.missing && isAdmin ? `<div class="hub-flash" data-tone="warning">${int(summary.missing)} produto(s) ainda sem estoque. Use <strong>Estoque inicial</strong> ou <strong>Importar planilha</strong> para começar.</div>` : ""}
        ${state.panel === "sheet" ? sheetPanel() : state.panel === "initial" ? initialPanel(rules.accounts) : ""}
        <section class="seller-card">
          <form class="hub-toolbar" data-stock-search>
            <input type="search" name="q" placeholder="Buscar por SKU, nome ou EAN" value="${esc(state.q)}">
            <select name="filter"><option value="all" ${state.filter === "all" ? "selected" : ""}>Todos</option><option value="low" ${state.filter === "low" ? "selected" : ""}>Estoque baixo (até ${int(summary.threshold ?? 5)})</option><option value="zero" ${state.filter === "zero" ? "selected" : ""}>Zerados</option><option value="no_stock" ${state.filter === "no_stock" ? "selected" : ""}>Sem estoque informado</option><option value="kits" ${state.filter === "kits" ? "selected" : ""}>Kits</option></select>
            <button class="seller-btn" type="submit">Filtrar</button>
            <span class="hub-toolbar__spacer"></span>
            <a class="seller-btn" href="/hub/api/stock/export.csv">Exportar planilha</a>
            ${isAdmin ? '<button class="seller-btn" type="button" data-panel="sheet">Importar planilha</button><button class="seller-btn seller-btn--primary" type="button" data-panel="initial">Estoque inicial</button>' : ""}
          </form>
          ${items.length ? `<div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>SKU</th><th>Produto</th><th class="hub-num">Físico</th><th class="hub-num">Disponível</th><th class="hub-num">Anúncios</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`
            : '<div class="seller-empty"><strong>Nada encontrado</strong><span>Mude a busca ou o filtro.</span></div>'}
          ${pager(kit, state.offset, total, PAGE_SIZE)}
        </section>`;
    }

    function sheetPanel() {
      const s = state.sheet;
      return `<section class="seller-card hub-panel"><h2>Importar planilha de estoque</h2>
        <p>Duas colunas: <strong>SKU</strong> e <strong>quantidade</strong> (.xlsx ou .csv). Você vê o resultado antes de aplicar.</p>
        <form class="hub-form" data-sheet-form>
          <input type="file" name="file" accept=".xlsx,.csv,.txt" required>
          <div class="hub-radio"><label><input type="radio" name="mode" value="set" ${s?.mode !== "add" ? "checked" : ""}> Definir o saldo (inventário)</label>
            <label><input type="radio" name="mode" value="add" ${s?.mode === "add" ? "checked" : ""}> Somar ao saldo (entrada de mercadoria)</label></div>
          <div class="hub-actions hub-actions--start"><button class="seller-btn seller-btn--primary" type="submit">Pré-visualizar</button><button class="seller-btn" type="button" data-panel="">Fechar</button></div>
        </form>
        ${s?.preview ? `${errorList(kit, s.preview.errors)}
          <p><strong>${int(s.preview.summary.valid)}</strong> linha(s) válida(s), <strong>${int(s.preview.summary.changed)}</strong> mudariam o estoque.</p>
          ${s.preview.rows.length ? `<div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>Linha</th><th>SKU</th><th class="hub-num">Antes</th><th class="hub-num">Depois</th><th class="hub-num">Diferença</th></tr></thead><tbody>
            ${s.preview.rows.slice(0, 50).map((/** @type {any} */ r) => `<tr><td>${int(r.line)}</td><td>${esc(r.sku)}</td><td class="hub-num">${r.before == null ? "—" : int(r.before)}</td><td class="hub-num">${int(r.after)}</td><td class="hub-num">${r.delta > 0 ? "+" : ""}${int(r.delta)}</td></tr>`).join("")}
          </tbody></table></div>${s.preview.rows.length > 50 ? `<small>Mostrando 50 de ${int(s.preview.rows.length)}.</small>` : ""}` : ""}
          <div class="hub-actions hub-actions--start"><button class="seller-btn seller-btn--primary" type="button" data-sheet-apply ${s.preview.errors.length || !s.preview.rows.length ? "disabled" : ""}>Aplicar planilha</button></div>` : ""}
        ${s?.message ? `<div class="hub-flash" data-tone="${s.tone || "success"}">${esc(s.message)}</div>` : ""}
      </section>`;
    }

    /** @param {any[]} accounts */
    function initialPanel(accounts) {
      const p = state.initial || {};
      return `<section class="seller-card hub-panel"><h2>Estoque inicial a partir dos canais</h2>
        <p>Usa o estoque que está hoje nos anúncios. Anúncios Full ficam de fora. Kits não têm estoque próprio.</p>
        <form class="hub-form" data-initial-form>
          <label><span>Origem</span><select name="source">
            <option value="lowest" ${p.source !== "account" ? "selected" : ""}>Menor estoque entre os canais (mais seguro)</option>
            ${accounts.map((/** @type {any} */ a) => `<option value="account:${esc(a.id)}" ${p.source === "account" && Number(p.accountId) === Number(a.id) ? "selected" : ""}>Conta de referência: ${esc(kit.CHANNEL_LABELS[a.channel] || a.channel)} · ${esc(a.label)}</option>`).join("")}
          </select></label>
          <label class="hub-check"><input type="checkbox" name="onlyMissing" ${p.onlyMissing === false ? "" : "checked"}> Só produtos sem estoque informado</label>
          <div class="hub-actions hub-actions--start"><button class="seller-btn seller-btn--primary" type="submit">Pré-visualizar</button><button class="seller-btn" type="button" data-panel="">Fechar</button></div>
        </form>
        ${p.preview ? `<p><strong>${int(p.preview.count)}</strong> produto(s) receberiam estoque.</p>
          ${p.preview.rows.length ? `<div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>SKU</th><th class="hub-num">Hoje</th><th class="hub-num">Estoque inicial</th></tr></thead><tbody>
            ${p.preview.rows.slice(0, 30).map((/** @type {any} */ r) => `<tr><td>${esc(r.sku)}</td><td class="hub-num">${r.before == null ? "—" : int(r.before)}</td><td class="hub-num">${int(r.quantity)}</td></tr>`).join("")}</tbody></table></div>` : ""}
          <div class="hub-actions hub-actions--start"><button class="seller-btn seller-btn--primary" type="button" data-initial-apply ${p.preview.count ? "" : "disabled"}>Aplicar estoque inicial</button></div>` : ""}
        ${p.message ? `<div class="hub-flash" data-tone="${p.tone || "success"}">${esc(p.message)}</div>` : ""}
      </section>`;
    }

    /** @param {HTMLElement} row @param {string} html */
    function openInline(row, html) {
      root.querySelectorAll("[data-inline]").forEach((el) => el.remove());
      row.insertAdjacentHTML("afterend", `<tr data-inline><td colspan="6">${html}</td></tr>`);
    }

    /** @returns {{ source: "account" | "lowest", accountId: number | null, onlyMissing: boolean }} */
    function initialInput(/** @type {HTMLFormElement} */ form) {
      const data = new FormData(form);
      const raw = String(data.get("source") || "lowest");
      return { source: raw.startsWith("account:") ? "account" : "lowest", accountId: raw.startsWith("account:") ? Number(raw.slice(8)) : null, onlyMissing: data.get("onlyMissing") === "on" };
    }

    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("submit", async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (form.matches("[data-stock-search]")) {
          event.preventDefault();
          const data = new FormData(form);
          Object.assign(state, { q: String(data.get("q") || ""), filter: String(data.get("filter") || "all"), offset: 0 });
          await render();
        } else if (form.matches("[data-sheet-form]")) {
          event.preventDefault();
          const file = /** @type {HTMLInputElement} */ (form.querySelector("input[type=file]")).files?.[0];
          if (!file) return;
          const mode = String(new FormData(form).get("mode") || "set");
          form.setAttribute("aria-busy", "true");
          try {
            const body = { fileName: file.name, contentBase64: await fileToBase64(file), mode };
            state.sheet = { mode, body, preview: await api("/stock/spreadsheet/preview", { method: "POST", body: JSON.stringify(body) }) };
          } catch (error) {
            state.sheet = { mode, message: /** @type {Error} */ (error).message, tone: "danger" };
          }
          await render();
        } else if (form.matches("[data-initial-form]")) {
          event.preventDefault();
          const input = initialInput(form);
          try {
            state.initial = { ...input, preview: await api("/stock/initial", { method: "POST", body: JSON.stringify({ ...input, apply: false }) }) };
          } catch (error) {
            state.initial = { ...input, message: /** @type {Error} */ (error).message, tone: "danger" };
          }
          await render();
        } else if (form.matches("[data-adjust-form]")) {
          event.preventDefault();
          const data = new FormData(form);
          const error = /** @type {HTMLElement} */ (form.querySelector("[data-form-error]"));
          try {
            await api(`/stock/items/${form.dataset.adjustForm}/adjust`, { method: "POST", body: JSON.stringify({ op: data.get("op"), quantity: Number(data.get("quantity")), note: data.get("note") }) });
            await render();
          } catch (err) { error.textContent = /** @type {Error} */ (err).message; }
        } else if (form.matches("[data-kit-form]")) {
          event.preventDefault();
          const error = /** @type {HTMLElement} */ (form.querySelector("[data-form-error]"));
          const components = String(new FormData(form).get("components") || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
            const [sku, qty] = line.split(/[;,\t]| x /i).map((p) => p.trim());
            return { sku, quantity: Number(qty || 1) };
          });
          try {
            await api(`/stock/items/${form.dataset.kitForm}/kit`, { method: "PUT", body: JSON.stringify({ components }) });
            await render();
          } catch (err) { error.textContent = /** @type {Error} */ (err).message; }
        }
      });
      root.addEventListener("click", async (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        const panel = target.closest("[data-panel]");
        if (panel) { state.panel = /** @type {any} */ (panel.getAttribute("data-panel")); state.sheet = null; state.initial = null; await render(); return; }
        const page = target.closest("[data-page]");
        if (page) { state.offset = Number(page.getAttribute("data-page")) || 0; await render(); return; }
        const adjust = target.closest("[data-adjust]");
        if (adjust) {
          const id = adjust.getAttribute("data-adjust");
          openInline(/** @type {HTMLElement} */ (adjust.closest("tr")), `<form class="hub-form hub-form--inline" data-adjust-form="${esc(id)}">
            <label><span>Operação</span><select name="op"><option value="add">Somar / retirar (use − para retirar)</option><option value="set">Definir saldo (contagem)</option></select></label>
            <label><span>Quantidade</span><input name="quantity" type="number" step="1" required></label>
            <label class="hub-grow"><span>Motivo</span><input name="note" maxlength="200" placeholder="Ex.: entrada NF 1234, avaria, contagem" required></label>
            <div class="hub-actions hub-actions--start"><button class="seller-btn seller-btn--primary" type="submit">Salvar</button></div><small data-form-error class="hub-error"></small></form>`);
          return;
        }
        const kitButton = target.closest("[data-kit]");
        if (kitButton) {
          const id = kitButton.getAttribute("data-kit");
          const { item } = await api(`/stock/items/${id}`);
          openInline(/** @type {HTMLElement} */ (kitButton.closest("tr")), `<form class="hub-form" data-kit-form="${esc(id)}">
            <p>Um componente por linha: <code>SKU;quantidade</code>. Deixe vazio para voltar a produto simples. O disponível do kit é o menor dos componentes.</p>
            <textarea name="components" rows="4" placeholder="CADEIRA-PRETA;4&#10;MESA-TAMPO;1">${esc((item.components || []).map((/** @type {any} */ c) => `${c.sku};${c.quantity}`).join("\n"))}</textarea>
            <div class="hub-actions hub-actions--start"><button class="seller-btn seller-btn--primary" type="submit">Salvar kit</button></div><small data-form-error class="hub-error"></small></form>`);
          return;
        }
        if (target.closest("[data-sheet-apply]") && state.sheet?.body) {
          /** @type {HTMLButtonElement} */ (target.closest("button")).disabled = true;
          try {
            const result = await api("/stock/spreadsheet/apply", { method: "POST", body: JSON.stringify(state.sheet.body) });
            state.sheet = { mode: state.sheet.mode, message: `Planilha aplicada: ${int(result.applied)} produto(s) atualizado(s)${result.duplicates ? `, ${int(result.duplicates)} já aplicados antes` : ""}.` };
          } catch (error) { state.sheet = { ...state.sheet, message: /** @type {Error} */ (error).message, tone: "danger" }; }
          await render();
          return;
        }
        if (target.closest("[data-initial-apply]") && state.initial?.preview) {
          /** @type {HTMLButtonElement} */ (target.closest("button")).disabled = true;
          const { source, accountId, onlyMissing } = state.initial;
          try {
            const result = await api("/stock/initial", { method: "POST", body: JSON.stringify({ source, accountId, onlyMissing, apply: true }) });
            state.initial = { source, accountId, onlyMissing, message: `Estoque inicial aplicado em ${int(result.count)} produto(s).` };
          } catch (error) { state.initial = { ...state.initial, message: /** @type {Error} */ (error).message, tone: "danger" }; }
          await render();
        }
      });
    }

    return async () => { bind(); await render(); };
  };

  /* ───────────── O que mudaria (modo observação) ───────────── */
  registry.plan = (kit) => {
    const { api, esc, int, root, isAdmin, empty, CHANNEL_LABELS } = kit;
    const zeroParam = new URLSearchParams(location.search).get("canal_zerado") === "1";
    const state = { accountId: "", q: "", onlyChanges: !zeroParam, zeroInChannel: zeroParam, offset: 0 };
    const SIZE = 100;
    let bound = false;
    /** @type {Map<number, any>} */
    let rowsById = new Map();

    async function render() {
      const params = new URLSearchParams({ q: state.q, onlyChanges: state.onlyChanges ? "1" : "0", zeroInChannel: state.zeroInChannel ? "1" : "0", limit: String(SIZE), offset: String(state.offset) });
      if (state.accountId) params.set("accountId", state.accountId);
      const [{ summary, rows, total }, { accounts }] = await Promise.all([api(`/stock/plan?${params}`), api("/stock/rules")]);
      rowsById = new Map(rows.map((/** @type {any} */ r) => [Number(r.id), r]));
      if (!summary.total && !state.accountId && !state.q) { root.innerHTML = empty("Nenhum anúncio vinculado", "O cálculo aparece quando houver anúncios ligados a produtos.", '<a class="seller-btn seller-btn--primary" href="/hub/pendencias">Ver pendências</a>'); return; }
      root.innerHTML = `
        <div class="hub-flash" data-tone="success">Modo observação: o Hub calcula e mostra o que enviaria. <strong>Nada é alterado nos canais.</strong></div>
        <section class="seller-grid">
          <article class="seller-kpi"><span>Anúncios vinculados</span><strong>${int(summary.total)}</strong><small>${int(summary.skipped)} fora do cálculo</small></article>
          <article class="seller-kpi"><span>Subiriam</span><strong>${int(summary.increase)}</strong><small>o canal está abaixo do Hub</small></article>
          <article class="seller-kpi"><span>Desceriam</span><strong>${int(summary.decrease)}</strong><small>${int(summary.zeroed)} seriam zerados</small></article>
          <article class="seller-kpi"><span>Já iguais</span><strong>${int(summary.same)}</strong><small>sem mudança</small></article>
        </section>
        <section class="seller-card">
          <form class="hub-toolbar" data-plan-filter>
            <select name="accountId"><option value="">Todas as contas</option>${accounts.map((/** @type {any} */ a) => `<option value="${esc(a.id)}" ${String(a.id) === state.accountId ? "selected" : ""}>${esc(CHANNEL_LABELS[a.channel] || a.channel)} · ${esc(a.label)}</option>`).join("")}</select>
            <input type="search" name="q" placeholder="SKU, título ou código do anúncio" value="${esc(state.q)}">
            <label class="hub-check"><input type="checkbox" name="onlyChanges" ${state.onlyChanges ? "checked" : ""}> Só o que muda</label>
            <label class="hub-check"><input type="checkbox" name="zeroInChannel" ${state.zeroInChannel ? "checked" : ""}> Zerados no canal</label>
            <button class="seller-btn" type="submit">Filtrar</button>
          </form>
          ${rows.length ? `<div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>Canal</th><th>Anúncio</th><th>SKU</th><th class="hub-num">Disponível</th><th>Regra</th><th class="hub-num">No canal</th><th class="hub-num">Hub enviaria</th><th>Situação</th><th></th></tr></thead><tbody>
            ${rows.map((/** @type {any} */ r) => {
              const [label, tone] = STATE_LABELS[r.state] || [r.state, ""];
              return `<tr data-row="${esc(r.id)}"><td><span class="seller-badge">${esc(CHANNEL_LABELS[r.channel] || r.channel)}</span><br><small>${esc(r.accountLabel)}</small></td>
                <td>${esc(r.title || r.listingId)}<br><small>${esc(r.listingId)}${r.variationId ? ` · ${esc(r.variationId)}` : ""}</small></td>
                <td>${esc(r.sku)}</td><td class="hub-num">${r.available == null ? "—" : int(r.available)}</td>
                <td>${esc(describeRule(r.rule))}<br><small>${r.ruleSource === "listing" ? "exceção do anúncio" : r.ruleSource === "account" ? "regra da conta" : "padrão"}</small></td>
                <td class="hub-num">${r.channelStock == null ? "—" : int(r.channelStock)}</td>
                <td class="hub-num"><strong>${r.desired == null ? "—" : int(r.desired)}</strong>${r.diff ? `<br><small>${r.diff > 0 ? "+" : ""}${int(r.diff)}</small>` : ""}</td>
                <td><span class="seller-badge" ${tone ? `data-tone="${tone}"` : ""}>${esc(label)}</span></td>
                <td>${isAdmin && !r.fulfillment ? `<div class="hub-actions"><button class="seller-btn" type="button" data-listing-rule="${esc(r.id)}">Regra</button>
                  <button class="seller-btn" type="button" data-listing-sync="${esc(r.id)}" data-enabled="${r.syncEnabled ? "0" : "1"}">${r.syncEnabled ? "Pausar" : "Retomar"}</button></div>` : ""}</td></tr>`;
            }).join("")}</tbody></table></div>`
            : '<div class="seller-empty"><strong>Nada a mostrar</strong><span>Com o filtro atual, nenhum anúncio mudaria.</span></div>'}
          ${pager(kit, state.offset, total, SIZE)}
        </section>`;
    }

    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("change", onRuleModeChange);
      root.addEventListener("submit", async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (form.matches("[data-plan-filter]")) {
          event.preventDefault();
          const data = new FormData(form);
          Object.assign(state, { accountId: String(data.get("accountId") || ""), q: String(data.get("q") || ""), onlyChanges: data.get("onlyChanges") === "on", zeroInChannel: data.get("zeroInChannel") === "on", offset: 0 });
          await render();
        } else if (form.matches("[data-listing-rule-form]")) {
          event.preventDefault();
          const error = /** @type {HTMLElement} */ (form.querySelector("[data-form-error]"));
          try {
            await api(`/stock/listings/${form.dataset.listingRuleForm}/rule`, { method: "PUT", body: JSON.stringify({ rule: ruleFromForm(form) }) });
            await render();
          } catch (err) { error.textContent = /** @type {Error} */ (err).message; }
        }
      });
      root.addEventListener("click", async (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        const page = target.closest("[data-page]");
        if (page) { state.offset = Number(page.getAttribute("data-page")) || 0; await render(); return; }
        const ruleButton = target.closest("[data-listing-rule]");
        if (ruleButton) {
          const id = Number(ruleButton.getAttribute("data-listing-rule"));
          const row = rowsById.get(id);
          root.querySelectorAll("[data-inline]").forEach((el) => el.remove());
          /** @type {HTMLElement} */ (ruleButton.closest("tr")).insertAdjacentHTML("afterend", `<tr data-inline><td colspan="9"><form class="hub-form" data-listing-rule-form="${id}">
            <p>Exceção só para este anúncio. Sem exceção, ele segue a regra da conta.</p>${ruleFields(kit, row?.ruleSource === "listing" ? row.rule : null, `l${id}`)}
            <div class="hub-actions hub-actions--start"><button class="seller-btn seller-btn--primary" type="submit">Salvar exceção</button>
            ${row?.ruleSource === "listing" ? `<button class="seller-btn" type="button" data-listing-rule-clear="${id}">Remover exceção</button>` : ""}</div><small data-form-error class="hub-error"></small></form></td></tr>`);
          return;
        }
        const clear = target.closest("[data-listing-rule-clear]");
        if (clear) {
          await api(`/stock/listings/${clear.getAttribute("data-listing-rule-clear")}/rule`, { method: "PUT", body: JSON.stringify({ rule: null }) });
          await render();
          return;
        }
        const sync = target.closest("[data-listing-sync]");
        if (sync) {
          await api(`/stock/listings/${sync.getAttribute("data-listing-sync")}/sync`, { method: "PUT", body: JSON.stringify({ enabled: sync.getAttribute("data-enabled") === "1" }) });
          await render();
        }
      });
    }

    return async () => { bind(); await render(); };
  };

  /* ───────────── Movimentos ───────────── */
  registry.movements = (kit) => {
    const { api, esc, int, root, empty, dateTime } = kit;
    const itemId = new URLSearchParams(location.search).get("item");
    const state = { offset: 0 };
    let bound = false;

    async function render() {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE + 1), offset: String(state.offset) });
      if (itemId) params.set("itemId", itemId);
      const { movements } = await api(`/stock/movements?${params}`);
      const hasMore = movements.length > PAGE_SIZE;
      const list = movements.slice(0, PAGE_SIZE);
      if (!list.length && !state.offset) { root.innerHTML = empty("Nenhum movimento ainda", "Ajustes, planilhas e o estoque inicial aparecem aqui, com quem fez e quando."); return; }
      root.innerHTML = `<section class="seller-card">
        ${itemId ? `<p>Histórico de <strong>${esc(list[0]?.sku || "")}</strong> · <a href="/hub/estoque/movimentos">ver todos</a></p>` : "<p>Todo número de estoque tem origem. O saldo é a soma destes movimentos.</p>"}
        <div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>Quando</th><th>SKU</th><th>Tipo</th><th class="hub-num">Quantidade</th><th class="hub-num">Saldo depois</th><th>Origem / motivo</th></tr></thead><tbody>
        ${list.map((/** @type {any} */ m) => `<tr><td>${esc(dateTime(m.createdAt))}</td><td><a href="/hub/estoque/movimentos?item=${esc(m.itemId)}">${esc(m.sku)}</a></td>
          <td>${esc(KIND_LABELS[m.kind] || m.kind)}</td><td class="hub-num"><strong class="${m.quantity > 0 ? "hub-up" : "hub-down"}">${m.quantity > 0 ? "+" : ""}${int(m.quantity)}</strong></td>
          <td class="hub-num">${int(m.balanceAfter)}</td><td>${esc(movementOrigin(m))}</td></tr>`).join("")}
        </tbody></table></div>
        <div class="hub-pager"><button class="seller-btn" type="button" data-page="${Math.max(0, state.offset - PAGE_SIZE)}" ${state.offset ? "" : "disabled"}>Anterior</button>
          <button class="seller-btn" type="button" data-page="${state.offset + PAGE_SIZE}" ${hasMore ? "" : "disabled"}>Próxima</button></div></section>`;
    }

    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("click", async (event) => {
        const page = /** @type {HTMLElement} */ (event.target).closest("[data-page]");
        if (page) { state.offset = Number(page.getAttribute("data-page")) || 0; await render(); }
      });
    }
    return async () => { bind(); await render(); };
  };

  /* ───────────── Regras e modo por conta ───────────── */
  registry.rules = (kit) => {
    const { api, esc, int, root, isAdmin, empty, CHANNEL_LABELS } = kit;
    let bound = false;

    async function render() {
      const [{ accounts }, { settings }] = await Promise.all([api("/stock/rules"), api("/stock/settings")]);
      if (!accounts.length) { root.innerHTML = empty("Nenhuma conta conectada", "Conecte uma conta para definir as regras de estoque.", '<a class="seller-btn seller-btn--primary" href="/hub/contas">Ver contas</a>'); return; }
      const activeCount = accounts.filter((/** @type {any} */ a) => a.mode === "active").length;
      root.innerHTML = `<section class="seller-card hub-pause-card" data-paused="${settings.paused ? "1" : "0"}">
          <div class="hub-account-head"><div><h2>Envio de estoque aos canais</h2>
            <p>${settings.paused ? `<strong>Pausado</strong> desde ${esc(kit.dateTime(settings.pausedAt))}. Nada é enviado; os envios ficam guardados até retomar.`
              : activeCount ? `${int(activeCount)} conta(s) em modo ativo recebem o estoque do Hub. A pausa para tudo na hora.` : "Nenhuma conta em modo ativo: o Hub só observa."}</p></div>
            ${isAdmin ? (settings.paused ? '<button class="seller-btn seller-btn--primary" type="button" data-pause="0">Retomar envios</button>'
              : '<button class="seller-btn hub-btn-danger" type="button" data-pause="1">Pausar todos os envios</button>') : ""}
          </div></section>
        <section class="seller-card"><h2>Alerta de estoque baixo</h2>
          <form class="hub-toolbar" data-threshold-form><label>Avisar quando o disponível de um produto ficar entre 1 e
            <input type="number" name="threshold" min="0" step="1" value="${esc(settings.lowStockThreshold ?? 5)}" ${isAdmin ? "" : "disabled"} class="hub-input-sm"> unidade(s)</label>
            ${isAdmin ? '<button class="seller-btn" type="submit">Salvar</button>' : ""}<small data-form-error class="hub-error"></small></form>
          <p>Aparece no painel, nos alertas da Saúde e no filtro "Estoque baixo" de Saldos. Zerar o estoque no Mercado Livre já pausa o anúncio sozinho e ele volta ao repor; por isso o Hub não pausa anúncios por conta própria.</p></section>
        <section class="seller-card"><h2>Como o Hub calcula</h2>
          <p>Para cada anúncio: regra (igual, % ou fixo) → tira a reserva de segurança → zera se o estoque estiver no limite → aplica o teto. Anúncio Full nunca recebe envio. A exceção do anúncio (na tela "O que mudaria") vence a regra da conta.</p></section>
        ${accounts.map((/** @type {any} */ a) => `<section class="seller-card">
          <div class="hub-account-head"><div><span class="seller-badge">${esc(CHANNEL_LABELS[a.channel] || a.channel)}</span> <strong>${esc(a.label)}</strong><br><small>${int(a.linked)} anúncio(s) vinculado(s)</small></div>
            <div class="hub-segment" role="group" aria-label="Modo de estoque">
              <button type="button" class="seller-btn ${a.mode === "off" ? "seller-btn--primary" : ""}" data-mode="off" data-account="${esc(a.id)}" ${isAdmin ? "" : "disabled"}>Desligado</button>
              <button type="button" class="seller-btn ${a.mode === "observe" ? "seller-btn--primary" : ""}" data-mode="observe" data-account="${esc(a.id)}" ${isAdmin ? "" : "disabled"}>Observação</button>
              <button type="button" class="seller-btn ${a.mode === "active" ? "seller-btn--primary" : ""}" data-activate="${esc(a.id)}" ${isAdmin && a.mode !== "active" ? "" : "disabled"}>Ativo</button>
            </div></div>
          ${a.mode === "active" ? `<div class="hub-flash" data-tone="success">Escrevendo estoque neste canal desde ${esc(kit.dateTime(a.activatedAt))}. Envios em <a href="/hub/estoque/envios?account=${esc(a.id)}">Envios</a>.</div>` : ""}
          <div data-activate-panel="${esc(a.id)}"></div>
          ${isAdmin ? `<form class="hub-form" data-account-rule="${esc(a.id)}">${ruleFields(kit, a.rule, `a${a.id}`)}
            <div class="hub-actions hub-actions--start"><button class="seller-btn seller-btn--primary" type="submit">Salvar regra da conta</button><small data-form-error class="hub-error"></small></div></form>`
            : `<p>Regra: ${esc(describeRule(a.rule))}</p>`}
        </section>`).join("")}`;
    }

    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("change", onRuleModeChange);
      root.addEventListener("click", async (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        const pause = target.closest("[data-pause]");
        if (pause) {
          const paused = pause.getAttribute("data-pause") === "1";
          if (paused && !confirm("Pausar todos os envios de estoque desta empresa? Nada será enviado até retomar.")) return;
          await api("/stock/settings", { method: "PUT", body: JSON.stringify({ paused }) });
          await render();
          return;
        }
        const activate = target.closest("[data-activate]");
        if (activate) {
          const id = activate.getAttribute("data-activate");
          const panel = /** @type {HTMLElement} */ (root.querySelector(`[data-activate-panel="${id}"]`));
          const { summary } = await api(`/stock/plan?accountId=${id}&onlyChanges=1&limit=1`);
          panel.innerHTML = `<form class="hub-form hub-panel hub-activate" data-activate-form="${esc(id)}">
            <h3>Ativar envio de estoque nesta conta</h3>
            <p>Ao ativar, o Hub envia agora o estoque calculado: <strong>${int(summary.increase)}</strong> anúncio(s) sobem e <strong>${int(summary.decrease)}</strong> descem
              (${int(summary.zeroed)} zerados). Depois disso, cada venda em qualquer canal atualiza esta conta. Anúncio Full nunca recebe envio.</p>
            <label class="hub-check"><input type="checkbox" name="confirm" required> Confirmo que a sincronização de estoque desta conta está <strong>desligada</strong> na Tray, ANYMARKET, Hub2b, Bling ou qualquer outro sistema. Dois sistemas escrevendo estoque sobrescrevem um ao outro.</label>
            <div class="hub-actions hub-actions--start"><button class="seller-btn seller-btn--primary" type="submit">Ativar envio</button><button class="seller-btn" type="button" data-activate-cancel>Cancelar</button><small data-form-error class="hub-error"></small></div>
          </form>`;
          return;
        }
        if (target.closest("[data-activate-cancel]")) { const form = target.closest("form"); if (form?.parentElement) form.parentElement.innerHTML = ""; return; }
        const button = target.closest("[data-mode]");
        if (!button) return;
        const card = button.closest(".seller-card");
        if (card?.querySelector('[data-activate].seller-btn--primary') && !confirm("Sair do modo ativo? Os envios pendentes desta conta serão cancelados e o Hub para de escrever estoque nela.")) return;
        await api(`/stock/accounts/${button.getAttribute("data-account")}/mode`, { method: "PUT", body: JSON.stringify({ mode: button.getAttribute("data-mode") }) });
        await render();
      });
      root.addEventListener("submit", async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (form.matches("[data-threshold-form]")) {
          event.preventDefault();
          const error = /** @type {HTMLElement} */ (form.querySelector("[data-form-error]"));
          try {
            await api("/stock/settings", { method: "PUT", body: JSON.stringify({ lowStockThreshold: Number(new FormData(form).get("threshold")) }) });
            error.textContent = "Salvo."; error.className = "hub-ok";
          } catch (err) { error.textContent = /** @type {Error} */ (err).message; error.className = "hub-error"; }
          return;
        }
        if (form.matches("[data-activate-form]")) {
          event.preventDefault();
          const error = /** @type {HTMLElement} */ (form.querySelector("[data-form-error]"));
          try {
            const confirmed = /** @type {HTMLInputElement} */ (form.querySelector("[name=confirm]")).checked;
            await api(`/stock/accounts/${form.dataset.activateForm}/mode`, { method: "PUT", body: JSON.stringify({ mode: "active", confirm: confirmed }) });
            await render();
          } catch (err) { error.textContent = /** @type {Error} */ (err).message; }
          return;
        }
        if (!form.matches("[data-account-rule]")) return;
        event.preventDefault();
        const error = /** @type {HTMLElement} */ (form.querySelector("[data-form-error]"));
        try {
          await api(`/stock/accounts/${form.dataset.accountRule}/rule`, { method: "PUT", body: JSON.stringify({ rule: ruleFromForm(form) }) });
          error.textContent = "Regra salva.";
          error.className = "hub-ok";
        } catch (err) { error.textContent = /** @type {Error} */ (err).message; error.className = "hub-error"; }
      });
    }
    return async () => { bind(); await render(); };
  };

  /** Exposto para os testes de navegador e para depuração. */
  /** @type {any} */ (window).DachHubStock = { describeRule };
})();
