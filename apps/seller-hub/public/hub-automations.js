// @ts-check
// Telas de automações, status internos e avisos (Fase 3 / P2). Registra as views; o hub-app.js entrega o kit.
(function () {
  "use strict";

  const registry = /** @type {Record<string, (kit: any) => () => Promise<void>>} */ ((/** @type {any} */ (window).DachHubViews ||= {}));

  const EVENTS = /** @type {Record<string, string>} */ ({
    order_received: "Pedido recebido", stage_changed: "Situação do pedido mudou", custom_status_changed: "Status interno mudou",
    ship_by_soon: "Prazo de envio vencendo", order_late: "Prazo de envio vencido", manual: "Execução manual (botão)",
    order_packed: "Pedido conferido (expedição)",
  });
  const STAGES = /** @type {Record<string, string>} */ ({
    new: "Novo", paid: "Pago", invoiced: "Faturado", ready_to_ship: "Pronto para envio", shipped: "Enviado", delivered: "Entregue", cancelled: "Cancelado", returned: "Devolvido",
  });
  const FIELDS = /** @type {Record<string, { label: string, kind: string }>} */ ({
    channel: { label: "Canal", kind: "list" }, accountId: { label: "Conta", kind: "list" }, stage: { label: "Situação", kind: "list" },
    customStatusId: { label: "Status interno", kind: "id" }, logisticType: { label: "Logística", kind: "list" }, fulfillment: { label: "Pedido Full", kind: "bool" },
    hasTracking: { label: "Tem rastreio", kind: "bool" }, hasInvoice: { label: "Tem nota fiscal", kind: "bool" }, pendingLink: { label: "Tem item sem vínculo", kind: "bool" },
    productsTotal: { label: "Valor dos produtos (R$)", kind: "number" }, itemsCount: { label: "Quantidade de itens", kind: "number" },
    sku: { label: "SKU do item", kind: "text" }, buyerState: { label: "UF do comprador", kind: "list" }, tag: { label: "Etiqueta", kind: "text" },
  });
  const OPS = /** @type {Record<string, Array<[string, string]>>} */ ({
    list: [["in", "é um de"], ["not_in", "não é nenhum de"]], bool: [["is", "é"]], number: [["gte", "maior ou igual a"], ["lte", "menor ou igual a"]],
    text: [["contains", "contém"], ["not_contains", "não contém"]], id: [["is", "é"], ["is_not", "não é"], ["is_empty", "está vazio"]],
  });
  const ACTIONS = /** @type {Record<string, string>} */ ({
    set_custom_status: "Mudar status interno", add_tag: "Pôr etiqueta", remove_tag: "Tirar etiqueta", notify: "Avisar a equipe", webhook: "Chamar webhook",
  });
  const COLORS = /** @type {Record<string, string>} */ ({ violet: "Roxo", blue: "Azul", green: "Verde", yellow: "Amarelo", orange: "Laranja", red: "Vermelho", gray: "Cinza" });

  /** Modelos prontos (o usuário completa o que faltar, como o status a usar). */
  const TEMPLATES = [
    { label: "Avisar 4h antes do prazo de envio", rule: { name: "Prazo de envio em 4h", event: "ship_by_soon", eventParams: { hours: 4 }, conditions: [], actions: [{ type: "notify", title: "Pedido vence em 4 horas: envie hoje" }] } },
    { label: "Avisar pedido atrasado", rule: { name: "Pedido atrasado", event: "order_late", eventParams: {}, conditions: [], actions: [{ type: "notify", title: "Pedido com prazo de envio vencido" }, { type: "add_tag", tag: "Atrasado" }] } },
    { label: "Venda sem vínculo → avisar", rule: { name: "Venda sem vínculo", event: "order_received", eventParams: {}, conditions: [{ field: "pendingLink", op: "is", value: true }], actions: [{ type: "notify", title: "Venda sem vínculo: vincule o anúncio para baixar o estoque" }] } },
    { label: "Pedido acima de R$ 1.000 → etiqueta", rule: { name: "Alto valor", event: "order_received", eventParams: {}, conditions: [{ field: "productsTotal", op: "gte", value: 1000 }], actions: [{ type: "add_tag", tag: "Alto valor" }] } },
    { label: "Pago → status interno", rule: { name: "Pago vai para separação", event: "stage_changed", eventParams: { stage: "paid" }, conditions: [{ field: "fulfillment", op: "is", value: false }], actions: [{ type: "set_custom_status", statusId: "" }] } },
    { label: "Enviado → webhook", rule: { name: "Avisar sistema externo no envio", event: "stage_changed", eventParams: { stage: "shipped" }, conditions: [], actions: [{ type: "webhook", url: "https://" }] } },
  ];

  /** Selo do status interno com a cor escolhida. @param {any} kit @param {string | null} name @param {string | null} color */
  function statusBadge(kit, name, color) {
    return name ? `<span class="hub-status" data-color="${kit.esc(color || "violet")}">${kit.esc(name)}</span>` : "";
  }
  /** @param {any} kit @param {string[]} tags */
  function tagsHtml(kit, tags) {
    return (tags || []).map((t) => `<span class="hub-tag">${kit.esc(t)}</span>`).join(" ");
  }
  /** Exposto para as telas de pedidos (hub-sync.js). */
  /** @type {any} */ (window).DachHubAuto = { statusBadge, tagsHtml };

  /** Texto curto da regra (lista). @param {any} kit @param {any} rule @param {any[]} statuses @param {any[]} accounts */
  function describe(kit, rule, statuses, accounts) {
    const statusName = (/** @type {any} */ id) => statuses.find((s) => Number(s.id) === Number(id))?.name || "?";
    const valueText = (/** @type {any} */ c) => {
      const def = FIELDS[c.field];
      if (!def) return "";
      if (def.kind === "bool") return c.value ? "sim" : "não";
      if (def.kind === "id") return c.op === "is_empty" ? "" : statusName(c.value);
      if (c.field === "stage") return (c.value || []).map((/** @type {string} */ v) => STAGES[v] || v).join(", ");
      if (c.field === "channel") return (c.value || []).map((/** @type {string} */ v) => kit.CHANNEL_LABELS[v] || v).join(", ");
      if (c.field === "accountId") return (c.value || []).map((/** @type {string} */ v) => accounts.find((a) => String(a.id) === String(v))?.label || v).join(", ");
      return Array.isArray(c.value) ? c.value.join(", ") : String(c.value);
    };
    const when = `${EVENTS[rule.event] || rule.event}${rule.event === "ship_by_soon" ? ` (${rule.eventParams?.hours}h antes)` : ""}${rule.event === "stage_changed" && rule.eventParams?.stage ? ` para ${STAGES[rule.eventParams.stage]}` : ""}`;
    const ifs = (rule.conditions || []).map((/** @type {any} */ c) => `${FIELDS[c.field]?.label || c.field} ${(OPS[FIELDS[c.field]?.kind] || []).find(([k]) => k === c.op)?.[1] || c.op} ${valueText(c)}`.trim());
    const thens = (rule.actions || []).map((/** @type {any} */ a) => a.type === "set_custom_status" ? `status interno: ${statusName(a.statusId)}`
      : a.type === "add_tag" ? `pôr etiqueta "${a.tag}"` : a.type === "remove_tag" ? `tirar etiqueta "${a.tag}"` : a.type === "notify" ? `avisar: "${a.title}"` : `webhook ${a.url}`);
    return { when, ifs, thens };
  }

  /* ───────────── Automações ───────────── */
  registry.automations = (kit) => {
    const { api, esc, int, root, isAdmin, dateTime, CHANNEL_LABELS } = kit;
    /** @type {{ statuses: any[], rules: any[], accounts: any[], draft: any | null, editingId: number | null, runsFor: number | null, runs: any[], secret: string | null, message: string, tone: string }} */
    const state = { statuses: [], rules: [], accounts: [], draft: null, editingId: null, runsFor: null, runs: [], secret: null, message: "", tone: "success" };
    let bound = false;

    async function load() {
      const [{ statuses }, { rules }, { accounts }] = await Promise.all([api("/automations/statuses"), api("/automations/rules"), api("/stock/rules")]);
      Object.assign(state, { statuses, rules, accounts });
    }

    /** Campo de valor da condição conforme o tipo. @param {any} c @param {number} i */
    function valueInput(c, i) {
      const def = FIELDS[c.field] || FIELDS.channel;
      const name = `c${i}-value`;
      const listBoxes = (/** @type {Array<[string, string]>} */ options) => `<div class="hub-checks">${options.map(([v, l]) => `<label class="hub-check"><input type="checkbox" name="${name}" value="${esc(v)}" ${(c.value || []).map(String).includes(String(v)) ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div>`;
      if (c.field === "stage") return listBoxes(Object.entries(STAGES));
      if (c.field === "channel") return listBoxes(Object.entries(CHANNEL_LABELS));
      if (c.field === "accountId") return listBoxes(state.accounts.map((a) => [String(a.id), `${CHANNEL_LABELS[a.channel] || a.channel} · ${a.label}`]));
      if (def.kind === "list") return `<input name="${name}" value="${esc((c.value || []).join(", "))}" placeholder="${c.field === "buyerState" ? "SP, RJ, MG" : "fulfillment, xd_drop_off, self_service"}">`;
      if (def.kind === "bool") return `<select name="${name}"><option value="true" ${c.value !== false ? "selected" : ""}>Sim</option><option value="false" ${c.value === false ? "selected" : ""}>Não</option></select>`;
      if (def.kind === "number") return `<input type="number" min="0" step="0.01" name="${name}" value="${esc(c.value ?? "")}">`;
      if (def.kind === "id") return c.op === "is_empty" ? "" : `<select name="${name}"><option value="">Escolha…</option>${state.statuses.map((s) => `<option value="${esc(s.id)}" ${Number(c.value) === Number(s.id) ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>`;
      return `<input name="${name}" value="${esc(c.value ?? "")}">`;
    }

    /** @param {any} a @param {number} i */
    function actionInput(a, i) {
      const name = `a${i}-param`;
      if (a.type === "set_custom_status") return `<select name="${name}"><option value="">Escolha o status…</option>${state.statuses.map((s) => `<option value="${esc(s.id)}" ${Number(a.statusId) === Number(s.id) ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>`;
      if (a.type === "add_tag" || a.type === "remove_tag") return `<input name="${name}" value="${esc(a.tag || "")}" placeholder="Nome da etiqueta" maxlength="40">`;
      if (a.type === "notify") return `<input name="${name}" value="${esc(a.title || "")}" placeholder="Texto do aviso" maxlength="140">`;
      return `<input name="${name}" type="url" value="${esc(a.url || "")}" placeholder="https://seu-sistema.com/webhook">`;
    }

    /** Lê o formulário de volta para o rascunho (antes de redesenhar). */
    function syncDraft() {
      const form = /** @type {HTMLFormElement | null} */ (root.querySelector("[data-rule-form]"));
      if (!form || !state.draft) return;
      const d = new FormData(form);
      const draft = state.draft;
      draft.name = String(d.get("name") || "");
      draft.event = String(d.get("event") || "order_received");
      draft.eventParams = draft.event === "ship_by_soon" ? { hours: Number(d.get("hours") || 4) } : draft.event === "stage_changed" && d.get("stage") ? { stage: String(d.get("stage")) } : {};
      draft.conditions = draft.conditions.map((/** @type {any} */ c, /** @type {number} */ i) => {
        const field = String(d.get(`c${i}-field`) || c.field);
        const kind = FIELDS[field]?.kind || "list";
        const op = String(d.get(`c${i}-op`) || c.op);
        const validOp = (OPS[kind] || []).some(([k]) => k === op) ? op : OPS[kind][0][0];
        let value;
        if (field !== c.field) value = kind === "list" ? [] : kind === "bool" ? true : "";
        else if (["stage", "channel", "accountId"].includes(field)) value = d.getAll(`c${i}-value`).map(String);
        else if (kind === "list") value = String(d.get(`c${i}-value`) || "").split(",").map((s) => s.trim()).filter(Boolean);
        else if (kind === "bool") value = d.get(`c${i}-value`) !== "false";
        else value = d.get(`c${i}-value`) ?? "";
        return { field, op: validOp, value };
      });
      draft.actions = draft.actions.map((/** @type {any} */ a, /** @type {number} */ i) => {
        const type = String(d.get(`a${i}-type`) || a.type);
        const param = d.get(`a${i}-param`);
        if (type !== a.type) return { type };
        if (type === "set_custom_status") return { type, statusId: param ? Number(param) : "" };
        if (type === "add_tag" || type === "remove_tag") return { type, tag: String(param || "") };
        if (type === "notify") return { type, title: String(param || "") };
        return { type, url: String(param || "") };
      });
    }

    function builder() {
      const d = state.draft;
      if (!d) return "";
      return `<section class="seller-card hub-panel"><h2>${state.editingId ? "Editar automação" : "Nova automação"}</h2>
        <form class="hub-form" data-rule-form>
          <label><span>Nome</span><input name="name" value="${esc(d.name || "")}" maxlength="120" required></label>
          <div class="hub-rule-block"><strong>Quando</strong>
            <div class="hub-toolbar"><select name="event" data-rerender>${Object.entries(EVENTS).map(([k, l]) => `<option value="${k}" ${d.event === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
              ${d.event === "ship_by_soon" ? `<label class="hub-check">faltando <input class="hub-input-sm" type="number" min="1" max="72" name="hours" value="${esc(d.eventParams?.hours || 4)}"> horas</label>` : ""}
              ${d.event === "stage_changed" ? `<select name="stage"><option value="">para qualquer situação</option>${Object.entries(STAGES).map(([k, l]) => `<option value="${k}" ${d.eventParams?.stage === k ? "selected" : ""}>para ${esc(l)}</option>`).join("")}</select>` : ""}</div></div>
          <div class="hub-rule-block"><strong>Se (todas as condições)</strong>
            ${d.conditions.length ? "" : '<small class="hub-muted">Sem condições: vale para todo pedido.</small>'}
            ${d.conditions.map((/** @type {any} */ c, /** @type {number} */ i) => `<div class="hub-rule-row">
              <select name="c${i}-field" data-rerender>${Object.entries(FIELDS).map(([k, f]) => `<option value="${k}" ${c.field === k ? "selected" : ""}>${esc(f.label)}</option>`).join("")}</select>
              <select name="c${i}-op" data-rerender>${(OPS[FIELDS[c.field]?.kind || "list"] || []).map(([k, l]) => `<option value="${k}" ${c.op === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
              ${valueInput(c, i)}<button class="seller-btn" type="button" data-remove-cond="${i}" aria-label="Remover condição">✕</button></div>`).join("")}
            <button class="seller-btn" type="button" data-add-cond>+ Condição</button></div>
          <div class="hub-rule-block"><strong>Então (na ordem)</strong>
            ${d.actions.map((/** @type {any} */ a, /** @type {number} */ i) => `<div class="hub-rule-row">
              <select name="a${i}-type" data-rerender>${Object.entries(ACTIONS).map(([k, l]) => `<option value="${k}" ${a.type === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
              ${actionInput(a, i)}<button class="seller-btn" type="button" data-remove-action="${i}" aria-label="Remover ação">✕</button></div>`).join("")}
            <button class="seller-btn" type="button" data-add-action>+ Ação</button>
            ${d.actions.some((/** @type {any} */ a) => a.type === "webhook") ? '<small class="hub-muted">O webhook recebe o pedido em JSON (POST), assinado no cabeçalho X-DachHub-Signature = sha256=HMAC(segredo, corpo). O segredo está no fim desta página.</small>' : ""}
            ${d.actions.some((/** @type {any} */ a) => a.type === "set_custom_status") && !state.statuses.length ? '<small class="hub-error">Crie um status interno acima antes.</small>' : ""}</div>
          <div class="hub-actions hub-actions--start"><button class="seller-btn seller-btn--primary" type="submit">Salvar automação</button><button class="seller-btn" type="button" data-cancel-rule>Cancelar</button>
            <small data-form-error class="hub-error"></small></div>
        </form></section>`;
    }

    async function render() {
      const runsRule = state.rules.find((r) => Number(r.id) === state.runsFor);
      root.innerHTML = `
        ${state.message ? `<div class="hub-flash" data-tone="${state.tone}">${esc(state.message)}</div>` : ""}
        <section class="seller-card"><h2>Status internos</h2>
          <p>O fluxo da sua operação (ex.: Separando, Embalado, Problema). Ficam separados da situação que vem do canal e podem ser trocados à mão ou por automação.</p>
          <div class="hub-status-list">${state.statuses.map((s) => `<span class="hub-status-item">${statusBadge(kit, s.name, s.color)} <small>${int(s.orders)} pedido(s)</small>
            ${isAdmin ? `<button class="seller-btn hub-btn-xs" type="button" data-edit-status="${esc(s.id)}">Editar</button><button class="seller-btn hub-btn-xs" type="button" data-delete-status="${esc(s.id)}">Excluir</button>` : ""}</span>`).join("") || '<small class="hub-muted">Nenhum status criado.</small>'}</div>
          ${isAdmin ? `<form class="hub-toolbar" data-status-form><input name="name" placeholder="Novo status (ex.: Separando)" maxlength="40" required>
            <select name="color">${Object.entries(COLORS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select><button class="seller-btn" type="submit">Criar status</button></form>` : ""}
        </section>
        ${builder()}
        <section class="seller-card">
          <div class="hub-account-head"><div><h2>Automações</h2><p>Quando algo acontece com um pedido e as condições batem, o Hub executa as ações. Cada automação roda uma vez por ocorrência e fica registrada na linha do tempo do pedido.</p></div>
            ${isAdmin && !state.draft ? '<button class="seller-btn seller-btn--primary" type="button" data-new-rule>Nova automação</button>' : ""}</div>
          ${isAdmin && !state.draft ? `<div class="hub-templates"><small>Modelos prontos:</small> ${TEMPLATES.map((t, i) => `<button class="seller-btn hub-btn-xs" type="button" data-template="${i}">${esc(t.label)}</button>`).join("")}</div>` : ""}
          ${state.rules.length ? `<div class="hub-rule-list">${state.rules.map((r) => {
            const { when, ifs, thens } = describe(kit, r, state.statuses, state.accounts);
            return `<article class="hub-rule-card ${r.active ? "" : "is-off"}">
              <div class="hub-account-head"><div><strong>${esc(r.name)}</strong> ${r.active ? '<span class="seller-badge" data-tone="success">Ativa</span>' : '<span class="seller-badge">Pausada</span>'}
                <br><small class="hub-muted">${int(r.runs7d)} execução(ões) em 7 dias${r.failures7d ? ` · <span class="hub-error">${int(r.failures7d)} com falha</span>` : ""}${r.lastRunAt ? ` · última ${esc(dateTime(r.lastRunAt))}` : ""}</small></div>
                <div class="hub-actions">${isAdmin ? `<button class="seller-btn hub-btn-xs" type="button" data-toggle-rule="${esc(r.id)}" data-active="${r.active ? "0" : "1"}">${r.active ? "Pausar" : "Ativar"}</button>
                  <button class="seller-btn hub-btn-xs" type="button" data-edit-rule="${esc(r.id)}">Editar</button><button class="seller-btn hub-btn-xs" type="button" data-delete-rule="${esc(r.id)}">Excluir</button>` : ""}
                  <button class="seller-btn hub-btn-xs" type="button" data-runs="${esc(r.id)}">Histórico</button></div></div>
              <div class="hub-rule-text"><span><b>Quando</b> ${esc(when)}</span>${ifs.length ? `<span><b>Se</b> ${ifs.map(esc).join(" <i>e</i> ")}</span>` : ""}<span><b>Então</b> ${thens.map(esc).join(", ")}</span></div>
            </article>`;
          }).join("")}</div>` : '<div class="seller-empty"><strong>Nenhuma automação ainda</strong><span>Comece por um modelo pronto.</span></div>'}
        </section>
        ${runsRule ? `<section class="seller-card"><h2>Histórico: ${esc(runsRule.name)}</h2>
          ${state.runs.length ? `<div class="seller-table-wrap"><table class="seller-table"><thead><tr><th>Quando</th><th>Pedido</th><th>Resultado</th></tr></thead><tbody>
          ${state.runs.map((x) => `<tr><td>${esc(dateTime(x.createdAt))}</td><td><a href="/hub/pedidos/detalhe?id=${esc(x.orderDbId)}">${esc(x.orderId)}</a></td>
            <td>${x.status === "failed" ? `<span class="seller-badge" data-tone="danger">Falhou</span> ${esc(x.error || "")}` : (x.results || []).map((/** @type {any} */ r) => `${esc(ACTIONS[r.type] || r.type)}: ${esc(r.detail)}`).join("<br>")}</td></tr>`).join("")}
          </tbody></table></div>` : "<p>Ainda não rodou.</p>"}</section>` : ""}
        ${isAdmin ? `<section class="seller-card"><h2>Segredo dos webhooks</h2>
          <p>Use para conferir que a chamada veio do DACH Hub: <code>sha256=HMAC_SHA256(segredo, corpo)</code> no cabeçalho <code>X-DachHub-Signature</code>.</p>
          <div class="hub-toolbar">${state.secret ? `<code class="hub-secret">${esc(state.secret)}</code>` : ""}<button class="seller-btn" type="button" data-show-secret>${state.secret ? "Ocultar" : "Mostrar segredo"}</button>
            <button class="seller-btn" type="button" data-rotate-secret>Gerar novo segredo</button></div></section>` : ""}`;
    }

    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("change", async (event) => {
        const el = /** @type {HTMLElement} */ (event.target);
        if (el.matches("[data-rerender]")) { syncDraft(); await render(); }
      });
      root.addEventListener("submit", async (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (form.matches("[data-status-form]")) {
          event.preventDefault();
          const d = new FormData(form);
          try { await api("/automations/statuses", { method: "POST", body: JSON.stringify({ name: d.get("name"), color: d.get("color") }) }); state.message = ""; }
          catch (error) { Object.assign(state, { message: /** @type {Error} */ (error).message, tone: "danger" }); }
          await load(); await render();
          return;
        }
        if (form.matches("[data-rule-form]")) {
          event.preventDefault();
          syncDraft();
          const error = /** @type {HTMLElement} */ (form.querySelector("[data-form-error]"));
          try {
            await api(state.editingId ? `/automations/rules/${state.editingId}` : "/automations/rules", { method: state.editingId ? "PUT" : "POST", body: JSON.stringify(state.draft) });
            Object.assign(state, { draft: null, editingId: null, message: "Automação salva.", tone: "success" });
            await load(); await render();
          } catch (err) { error.textContent = /** @type {Error} */ (err).message; }
        }
      });
      root.addEventListener("click", async (event) => {
        const t = /** @type {HTMLElement} */ (event.target);
        const attr = (/** @type {string} */ name) => t.closest(`[${name}]`)?.getAttribute(name);
        if (t.closest("[data-new-rule]")) { Object.assign(state, { draft: { name: "", event: "order_received", eventParams: {}, conditions: [], actions: [{ type: "notify", title: "" }] }, editingId: null, message: "" }); await render(); return; }
        if (attr("data-template") != null) { Object.assign(state, { draft: JSON.parse(JSON.stringify(TEMPLATES[Number(attr("data-template"))].rule)), editingId: null, message: "" }); await render(); return; }
        if (t.closest("[data-cancel-rule]")) { Object.assign(state, { draft: null, editingId: null }); await render(); return; }
        if (t.closest("[data-add-cond]")) { syncDraft(); state.draft.conditions.push({ field: "channel", op: "in", value: [] }); await render(); return; }
        if (t.closest("[data-add-action]")) { syncDraft(); state.draft.actions.push({ type: "add_tag", tag: "" }); await render(); return; }
        if (attr("data-remove-cond") != null) { syncDraft(); state.draft.conditions.splice(Number(attr("data-remove-cond")), 1); await render(); return; }
        if (attr("data-remove-action") != null) { syncDraft(); state.draft.actions.splice(Number(attr("data-remove-action")), 1); await render(); return; }
        if (attr("data-edit-rule")) {
          const rule = state.rules.find((r) => String(r.id) === attr("data-edit-rule"));
          Object.assign(state, { draft: JSON.parse(JSON.stringify({ name: rule.name, active: rule.active, event: rule.event, eventParams: rule.eventParams || {}, conditions: rule.conditions || [], actions: rule.actions || [] })), editingId: Number(rule.id), message: "" });
          await render(); window.scrollTo({ top: 0, behavior: "smooth" }); return;
        }
        if (attr("data-toggle-rule")) { await api(`/automations/rules/${attr("data-toggle-rule")}/active`, { method: "PUT", body: JSON.stringify({ active: attr("data-active") === "1" }) }); await load(); await render(); return; }
        if (attr("data-delete-rule")) {
          if (!confirm("Excluir esta automação? O histórico dela também é apagado.")) return;
          await api(`/automations/rules/${attr("data-delete-rule")}`, { method: "DELETE" }); await load(); await render(); return;
        }
        if (attr("data-runs")) { state.runsFor = Number(attr("data-runs")); state.runs = (await api(`/automations/rules/${state.runsFor}/runs`)).runs; await render(); return; }
        if (attr("data-edit-status")) {
          const s = state.statuses.find((x) => String(x.id) === attr("data-edit-status"));
          const name = prompt("Novo nome do status", s.name);
          if (!name) return;
          try { await api(`/automations/statuses/${s.id}`, { method: "PUT", body: JSON.stringify({ name, color: s.color }) }); state.message = ""; } catch (error) { Object.assign(state, { message: /** @type {Error} */ (error).message, tone: "danger" }); }
          await load(); await render(); return;
        }
        if (attr("data-delete-status")) {
          if (!confirm("Excluir este status? Os pedidos com ele ficam sem status interno.")) return;
          try { await api(`/automations/statuses/${attr("data-delete-status")}`, { method: "DELETE" }); state.message = ""; } catch (error) { Object.assign(state, { message: /** @type {Error} */ (error).message, tone: "danger" }); }
          await load(); await render(); return;
        }
        if (t.closest("[data-show-secret]")) { state.secret = state.secret ? null : (await api("/automations/webhook-secret")).secret; await render(); return; }
        if (t.closest("[data-rotate-secret]")) {
          if (!confirm("Gerar um novo segredo? O sistema que recebe os webhooks precisa ser atualizado.")) return;
          state.secret = (await api("/automations/webhook-secret/rotate", { method: "POST" })).secret; await render();
        }
      });
    }
    return async () => { bind(); await load(); await render(); };
  };

  /* ───────────── Avisos ───────────── */
  registry.notifications = (kit) => {
    const { api, esc, root, empty, dateTime } = kit;
    let bound = false;
    async function render() {
      const { notifications, unread } = await api("/notifications?limit=100");
      if (!notifications.length) { root.innerHTML = empty("Nenhum aviso", "Os avisos chegam pelas automações com a ação \"Avisar a equipe\".", '<a class="seller-btn seller-btn--primary" href="/hub/automacoes">Automações</a>'); return; }
      root.innerHTML = `<section class="seller-card">
        <div class="hub-toolbar"><strong>${unread ? `${unread} não lido(s)` : "Tudo lido"}</strong><span class="hub-toolbar__spacer"></span>${unread ? '<button class="seller-btn" type="button" data-read-all>Marcar todos como lidos</button>' : ""}</div>
        <ul class="hub-notifications">${notifications.map((/** @type {any} */ n) => `<li class="${n.readAt ? "" : "is-unread"}">
          <div><strong>${esc(n.title)}</strong><br><small>${esc(n.body || "")}</small></div>
          <div class="hub-actions"><small>${esc(dateTime(n.createdAt))}</small>${n.orderDbId ? `<a class="seller-btn hub-btn-xs" href="/hub/pedidos/detalhe?id=${esc(n.orderDbId)}" data-read="${esc(n.id)}">Abrir pedido</a>` : ""}
            ${n.readAt ? "" : `<button class="seller-btn hub-btn-xs" type="button" data-read="${esc(n.id)}">Lido</button>`}</div></li>`).join("")}</ul></section>`;
    }
    function bind() {
      if (bound) return;
      bound = true;
      root.addEventListener("click", async (event) => {
        const t = /** @type {HTMLElement} */ (event.target);
        if (t.closest("[data-read-all]")) { await api("/notifications/read", { method: "POST", body: "{}" }); await render(); return; }
        const read = t.closest("[data-read]");
        if (!read) return;
        const href = read.tagName === "A" ? read.getAttribute("href") : null;
        if (href) event.preventDefault();
        await api("/notifications/read", { method: "POST", body: JSON.stringify({ id: Number(read.getAttribute("data-read")) }) }).catch(() => {});
        if (href) location.href = href; else await render();
      });
    }
    return async () => { bind(); await render(); };
  };
})();
