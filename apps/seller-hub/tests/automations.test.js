"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRule, ruleMatches, webhookUrlProblem } = require("../src/modules/automations/rules");

const order = {
  id: 1, channel: "mercadolivre", accountId: 3, stage: "paid", customStatusId: null, logisticType: "xd_drop_off", fulfillment: false,
  hasTracking: false, hasInvoice: false, pendingLink: true, productsTotal: 1500, itemsCount: 3, skus: ["SOFA-1", "MESA-2"], buyerState: "SP", tags: ["Alto valor"],
};

test("validação da regra: nome, gatilho, condições e ações", () => {
  const ok = normalizeRule({ name: " Prazo ", event: "ship_by_soon", eventParams: { hours: "4" }, conditions: [{ field: "stage", op: "in", value: "paid, invoiced" }],
    actions: [{ type: "notify", title: "Vence em 4h" }, { type: "add_tag", tag: "Urgente" }] });
  assert.deepEqual([ok.name, ok.eventParams.hours, ok.conditions[0].value, ok.active], ["Prazo", 4, ["paid", "invoiced"], true]);
  assert.throws(() => normalizeRule({ name: "x", event: "ship_by_soon", eventParams: { hours: 100 }, actions: [{ type: "notify", title: "a" }] }), /1 a 72/);
  assert.throws(() => normalizeRule({ name: "x", event: "order_received", actions: [] }), /ao menos uma ação/);
  assert.throws(() => normalizeRule({ name: "x", event: "order_received", conditions: [{ field: "stage", op: "gte", value: 1 }], actions: [{ type: "notify", title: "a" }] }), /Operador/);
  assert.throws(() => normalizeRule({ name: "x", event: "order_received", conditions: [{ field: "stage", op: "in", value: ["voando"] }], actions: [{ type: "notify", title: "a" }] }), /Situação inválida/);
  assert.throws(() => normalizeRule({ name: "x", event: "order_received", actions: [{ type: "set_custom_status" }] }), /status interno/);
  assert.throws(() => normalizeRule({ name: "", event: "order_received", actions: [{ type: "notify", title: "a" }] }), /nome/);
});

test("webhook: só https público, sem usuário/senha e sem endereço interno", () => {
  assert.equal(webhookUrlProblem("https://api.cliente.com.br/hook"), null);
  assert.match(webhookUrlProblem("http://api.cliente.com.br/hook"), /https/);
  for (const bad of ["https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.2/x", "https://172.20.0.1/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://intranet/x", "https://db.internal/x"]) {
    assert.match(String(webhookUrlProblem(bad)), /interno/, bad);
  }
  assert.match(webhookUrlProblem("https://user:pass@api.com/x"), /usuário e senha/);
});

test("condições: listas, verdadeiro/falso, valores, SKU, etiqueta e status interno", () => {
  const rule = (conditions, event = "order_received", eventParams = {}) => ({ event, eventParams, conditions });
  const occ = { event: "order_received" };
  assert.equal(ruleMatches(rule([]), order, occ), true);
  assert.equal(ruleMatches(rule([{ field: "channel", op: "in", value: ["mercadolivre", "magalu"] }]), order, occ), true);
  assert.equal(ruleMatches(rule([{ field: "channel", op: "not_in", value: ["mercadolivre"] }]), order, occ), false);
  assert.equal(ruleMatches(rule([{ field: "accountId", op: "in", value: ["3"] }]), order, occ), true);
  assert.equal(ruleMatches(rule([{ field: "pendingLink", op: "is", value: true }, { field: "productsTotal", op: "gte", value: 1000 }]), order, occ), true);
  assert.equal(ruleMatches(rule([{ field: "itemsCount", op: "lte", value: 2 }]), order, occ), false);
  assert.equal(ruleMatches(rule([{ field: "sku", op: "contains", value: "sofa" }]), order, occ), true);
  assert.equal(ruleMatches(rule([{ field: "tag", op: "contains", value: "alto VALOR" }]), order, occ), true);
  assert.equal(ruleMatches(rule([{ field: "customStatusId", op: "is_empty", value: null }]), order, occ), true);
  assert.equal(ruleMatches(rule([{ field: "customStatusId", op: "is", value: 9 }]), { ...order, customStatusId: 9 }, occ), true);
  assert.equal(ruleMatches(rule([], "stage_changed", { stage: "shipped" }), order, { event: "stage_changed", stage: "paid" }), false);
  assert.equal(ruleMatches(rule([], "stage_changed", { stage: "paid" }), order, { event: "stage_changed", stage: "paid" }), true);
  assert.equal(ruleMatches(rule([]), order, { event: "manual" }), false, "evento diferente não vale");
});
