// @ts-check
"use strict";

/**
 * Motor das automações (funções puras): validar a regra e avaliar as condições contra um pedido.
 *
 * Regra = { event, eventParams, conditions[], actions[] }.
 * Todas as condições precisam bater (E). Ações rodam na ordem.
 */

const EVENTS = Object.freeze({
  order_received: "Pedido recebido",
  stage_changed: "Situação do pedido mudou",
  custom_status_changed: "Status interno mudou",
  ship_by_soon: "Prazo de envio vencendo",
  order_late: "Prazo de envio vencido",
  manual: "Execução manual",
  order_packed: "Pedido conferido (expedição)",
});

const STAGES = ["new", "paid", "invoiced", "ready_to_ship", "shipped", "delivered", "cancelled", "returned"];

/**
 * Campos que a condição pode testar e os operadores aceitos.
 * kind: list (valor é lista; in/not_in), bool (is), number (gte/lte), text (contains), id (is/is_not).
 */
const FIELDS = Object.freeze({
  channel: { label: "Canal", kind: "list" },
  accountId: { label: "Conta", kind: "list" },
  stage: { label: "Situação", kind: "list" },
  customStatusId: { label: "Status interno", kind: "id" },
  logisticType: { label: "Logística", kind: "list" },
  fulfillment: { label: "Pedido Full", kind: "bool" },
  hasTracking: { label: "Tem rastreio", kind: "bool" },
  hasInvoice: { label: "Tem nota fiscal", kind: "bool" },
  pendingLink: { label: "Tem item sem vínculo", kind: "bool" },
  productsTotal: { label: "Valor dos produtos (R$)", kind: "number" },
  itemsCount: { label: "Quantidade de itens", kind: "number" },
  sku: { label: "SKU do item", kind: "text" },
  buyerState: { label: "UF do comprador", kind: "list" },
  tag: { label: "Etiqueta", kind: "text" },
});
const OPERATORS = Object.freeze({
  list: ["in", "not_in"], bool: ["is"], number: ["gte", "lte"], text: ["contains", "not_contains"], id: ["is", "is_not", "is_empty"],
});

const ACTIONS = Object.freeze({
  set_custom_status: "Mudar status interno",
  add_tag: "Pôr etiqueta",
  remove_tag: "Tirar etiqueta",
  notify: "Avisar a equipe",
  webhook: "Chamar webhook",
});

const MAX_CONDITIONS = 15;
const MAX_ACTIONS = 8;

/** @param {string} message */
const invalid = (message) => Object.assign(new Error(message), { status: 400, code: "invalid_rule" });
/** @param {unknown} v */
const text = (v) => String(v ?? "").trim();

/**
 * Endereço de webhook aceito: https, sem usuário/senha e sem endereço interno (localhost, rede privada).
 * Não resolve DNS: um domínio que aponte para rede interna ainda passaria (o worker roda sem acesso a ela).
 * @param {string} raw
 */
function webhookUrlProblem(raw) {
  let url;
  try { url = new URL(raw); } catch (_error) { return "Endereço do webhook inválido."; }
  if (url.protocol !== "https:") return "O webhook precisa ser https.";
  if (url.username || url.password) return "Não coloque usuário e senha no endereço do webhook.";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local") || !host.includes(".") && !host.includes(":")) return "Endereço interno não é aceito.";
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "::1" || /^f[cd]/.test(host) || /^fe80/.test(host)) return "Endereço interno não é aceito.";
  return null;
}

/**
 * Confere e limpa a regra vinda da tela.
 * @param {any} input
 * @returns {{ name: string, active: boolean, event: string, eventParams: Record<string, any>, conditions: any[], actions: any[] }}
 */
function normalizeRule(input) {
  const name = text(input?.name).slice(0, 120);
  if (!name) throw invalid("Dê um nome para a automação.");
  const event = text(input?.event);
  if (!(event in EVENTS)) throw invalid("Escolha quando a automação roda.");
  /** @type {Record<string, any>} */
  const eventParams = {};
  if (event === "ship_by_soon") {
    const hours = Number(input?.eventParams?.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 72) throw invalid("Informe de 1 a 72 horas antes do prazo.");
    eventParams.hours = hours;
  }
  if (event === "stage_changed" && input?.eventParams?.stage) {
    if (!STAGES.includes(text(input.eventParams.stage))) throw invalid("Situação inválida no gatilho.");
    eventParams.stage = text(input.eventParams.stage);
  }
  const rawConditions = Array.isArray(input?.conditions) ? input.conditions : [];
  if (rawConditions.length > MAX_CONDITIONS) throw invalid(`No máximo ${MAX_CONDITIONS} condições.`);
  const conditions = rawConditions.map((/** @type {any} */ c) => {
    const field = text(c?.field);
    const def = /** @type {any} */ (FIELDS)[field];
    if (!def) throw invalid("Condição com campo desconhecido.");
    const op = text(c?.op);
    if (!(/** @type {any} */ (OPERATORS)[def.kind]).includes(op)) throw invalid(`Operador inválido para ${def.label}.`);
    let value = c?.value;
    if (def.kind === "list") {
      value = (Array.isArray(value) ? value : String(value ?? "").split(",")).map(text).filter(Boolean);
      if (!value.length) throw invalid(`Informe ao menos um valor para ${def.label}.`);
      if (field === "stage" && value.some((/** @type {string} */ v) => !STAGES.includes(v))) throw invalid("Situação inválida na condição.");
    } else if (def.kind === "bool") value = value === true || value === "true";
    else if (def.kind === "number") {
      value = Number(value);
      if (!Number.isFinite(value) || value < 0) throw invalid(`Número inválido para ${def.label}.`);
    } else if (def.kind === "text") {
      value = text(value).slice(0, 80);
      if (!value) throw invalid(`Informe o texto para ${def.label}.`);
    } else if (def.kind === "id") value = op === "is_empty" ? null : Number(value) || null;
    if (def.kind === "id" && op !== "is_empty" && !value) throw invalid(`Escolha o ${def.label}.`);
    return { field, op, value };
  });
  const rawActions = Array.isArray(input?.actions) ? input.actions : [];
  if (!rawActions.length) throw invalid("Inclua ao menos uma ação.");
  if (rawActions.length > MAX_ACTIONS) throw invalid(`No máximo ${MAX_ACTIONS} ações.`);
  const actions = rawActions.map((/** @type {any} */ a) => {
    const type = text(a?.type);
    if (!(type in ACTIONS)) throw invalid("Ação desconhecida.");
    if (type === "set_custom_status") {
      const statusId = Number(a?.statusId);
      if (!statusId) throw invalid("Escolha o status interno da ação.");
      return { type, statusId };
    }
    if (type === "add_tag" || type === "remove_tag") {
      const tag = text(a?.tag).slice(0, 40);
      if (!tag) throw invalid("Informe a etiqueta.");
      return { type, tag };
    }
    if (type === "notify") {
      const title = text(a?.title).slice(0, 140);
      if (!title) throw invalid("Informe o texto do aviso.");
      return { type, title };
    }
    const url = text(a?.url);
    const problem = webhookUrlProblem(url);
    if (problem) throw invalid(problem);
    return { type, url };
  });
  return { name, active: input?.active !== false, event, eventParams, conditions, actions };
}

/**
 * Dados do pedido que as condições enxergam.
 * @typedef {{ id: number, channel: string, accountId: number, stage: string, customStatusId: number | null, logisticType: string | null,
 *   fulfillment: boolean, hasTracking: boolean, hasInvoice: boolean, pendingLink: boolean, productsTotal: number, itemsCount: number,
 *   skus: string[], buyerState: string | null, tags: string[] }} OrderContext
 */

/** @param {OrderContext} order @param {{ field: string, op: string, value: any }} c */
function conditionMatches(order, c) {
  const lower = (/** @type {unknown} */ v) => String(v ?? "").toLowerCase();
  switch (c.field) {
    case "channel": case "stage": case "logisticType": case "buyerState": case "accountId": {
      const actual = lower(/** @type {any} */ (order)[c.field]);
      const hit = (/** @type {any[]} */ (c.value)).some((v) => lower(v) === actual);
      return c.op === "in" ? hit : !hit;
    }
    case "customStatusId":
      if (c.op === "is_empty") return order.customStatusId == null;
      return c.op === "is" ? Number(order.customStatusId) === Number(c.value) : Number(order.customStatusId) !== Number(c.value);
    case "fulfillment": case "hasTracking": case "hasInvoice": case "pendingLink":
      return Boolean(/** @type {any} */ (order)[c.field]) === Boolean(c.value);
    case "productsTotal": case "itemsCount": {
      const n = Number(/** @type {any} */ (order)[c.field]) || 0;
      return c.op === "gte" ? n >= Number(c.value) : n <= Number(c.value);
    }
    case "sku": {
      const hit = order.skus.some((s) => lower(s).includes(lower(c.value)));
      return c.op === "contains" ? hit : !hit;
    }
    case "tag": {
      const hit = order.tags.some((t) => lower(t) === lower(c.value));
      return c.op === "contains" ? hit : !hit;
    }
    default:
      return false;
  }
}

/**
 * A regra vale para este evento e este pedido?
 * @param {{ event: string, eventParams?: any, conditions: any[] }} rule @param {OrderContext} order @param {{ event: string, stage?: string }} occurrence
 */
function ruleMatches(rule, order, occurrence) {
  if (rule.event !== occurrence.event) return false;
  if (rule.event === "stage_changed" && rule.eventParams?.stage && rule.eventParams.stage !== (occurrence.stage || order.stage)) return false;
  return (rule.conditions || []).every((c) => conditionMatches(order, c));
}

module.exports = { EVENTS, FIELDS, OPERATORS, ACTIONS, STAGES, normalizeRule, ruleMatches, conditionMatches, webhookUrlProblem };
