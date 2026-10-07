"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function bootMargin() {
  const requests = [];
  const elements = new Map();
  const documentEvents = new Map();
  const windowEvents = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: "", hidden: false, dataset: {}, classList: { toggle() {} }, addEventListener(name, callback) { this[name] = callback; }, setAttribute() {} });
    return elements.get(id);
  };
  const tabs = ["summary", "period", "equilibrium", "costs"].map((name) => ({ dataset: { marginTab: name }, classList: { toggle() {} }, setAttribute() {}, addEventListener(_name, callback) { this.click = callback; } }));
  const panels = ["summary", "period", "equilibrium", "costs"].map((name) => ({ dataset: { marginPanel: name, ...(name === "costs" ? {} : { awaitingFilter: "true" }) }, hidden: name !== "summary" }));
  const document = {
    getElementById: (id) => element(id),
    querySelector: (selector) => selector.startsWith('[data-margin-panel=')
      ? panels.find((panel) => selector.includes(`"${panel.dataset.marginPanel}"`))
      : element("margin-filter-card"),
    querySelectorAll: (selector) => selector === "[data-margin-tab]" ? tabs : selector === "[data-margin-panel]" ? panels : [],
    addEventListener: (name, callback) => documentEvents.set(name, callback),
  };
  const shell = {
    route: () => "/margem",
    getSelectedAccountId: () => 1,
    isReady: () => true,
    fetchJson: async (url) => { requests.push(url); return { summary: {}, rows: [], total: 0 }; },
    showAlert() {},
  };
  const context = { document, window: { MagaluSellerShell: shell, addEventListener: (name, callback) => windowEvents.set(name, callback) }, location: { href: "https://example.test/magalu/margem", search: "" }, history: { pushState() {} }, URL, URLSearchParams, Intl, Date, Map, Number, String, Math, Promise, setTimeout, clearTimeout };
  const source = fs.readFileSync(path.join(__dirname, "../public/js/magalu-financial.js"), "utf8");
  vm.runInNewContext(source, context);
  documentEvents.get("DOMContentLoaded")();
  return { requests, tabs, panels, elements, windowEvents };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Margem abre em Resumo sem fazer consultas até Filtrar", async () => {
  const page = bootMargin();
  await settle();
  assert.equal(page.panels.find((panel) => panel.dataset.marginPanel === "summary").hidden, false);
  assert.equal(page.panels.find((panel) => panel.dataset.marginPanel === "summary").dataset.awaitingFilter, "true");
  assert.deepEqual(page.requests, []);
  page.tabs.find((tab) => tab.dataset.marginTab === "period").click();
  await settle();
  assert.deepEqual(page.requests, []);
});

test("Filtrar inicia margem e equilíbrio; trocar de aba não repete as consultas", async () => {
  const page = bootMargin();
  page.elements.get("mg-margin-filter").click();
  await settle();
  assert.equal(page.requests.filter((url) => url.includes("/margins?")).length, 1);
  assert.equal(page.requests.filter((url) => url.includes("/equilibrium?")).length, 1);
  assert.equal(page.panels.find((panel) => panel.dataset.marginPanel === "summary").dataset.awaitingFilter, "false");
  assert.equal(page.panels.find((panel) => panel.dataset.marginPanel === "equilibrium").dataset.awaitingFilter, "false");
  page.tabs.find((tab) => tab.dataset.marginTab === "equilibrium").click();
  await settle();
  assert.equal(page.requests.filter((url) => url.includes("/equilibrium?")).length, 1);
});

test("trocar de conta volta ao estado sem resultados até novo filtro", async () => {
  const page = bootMargin();
  page.elements.get("mg-margin-filter").click();
  await settle();
  page.windowEvents.get("magalu:accountchange")();
  await settle();
  assert.equal(page.panels.find((panel) => panel.dataset.marginPanel === "summary").dataset.awaitingFilter, "true");
  assert.equal(page.panels.find((panel) => panel.dataset.marginPanel === "equilibrium").dataset.awaitingFilter, "true");
  assert.equal(page.requests.length, 2);
});

test("Resumo usa a ordem de blocos da referência sem inventar comissão ou marketing", () => {
  const html = fs.readFileSync(path.join(__dirname, "../views/app.html"), "utf8");
  const summary = html.match(/data-margin-panel="summary"[\s\S]*?(?=data-margin-panel="period")/)?.[0];
  assert.ok(summary);
  assert.match(summary, /Conciliação com Magalu[\s\S]*Resultado da margem[\s\S]*Detalhamento de custos[\s\S]*Insights automáticos/);
  assert.doesNotMatch(summary, /id="mg-margin-(commission|marketing|shipping)"/);
});
