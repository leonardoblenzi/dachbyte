"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "js", "financeiro-ml-margem.js"), "utf8");

function bootMargin(hash = "") {
  const listeners = new Map();
  const requests = [];
  const openedSkus = [];
  const fields = new Map();
  const nodes = new Map();
  const makeNode = (id) => ({
    id,
    dataset: { awaitingFilter: "true" },
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    addEventListener(type, listener) { listeners.set(`${id}:${type}`, listener); },
    innerHTML: "",
    textContent: "",
  });
  for (const id of [
    "fml-margin-status", "fml-margin-filters", "fml-margin-body", "fml-equilibrium-body",
    "fml-summary-panel", "fml-period-panel", "fml-equilibrium-panel", "fml-costs-panel",
  ]) nodes.set(id, makeNode(id));

  const form = nodes.get("fml-margin-filters");
  form.elements = {
    namedItem(name) {
      if (!fields.has(name)) fields.set(name, { value: "" });
      return fields.get(name);
    },
  };

  class FormDataStub {
    *[Symbol.iterator]() {
      for (const [name, field] of fields) yield [name, field.value];
    }
  }

  const document = {
    getElementById: (id) => nodes.get(id) || null,
    createElement: (id) => makeNode(id),
    addEventListener(type, listener) { listeners.set(`document:${type}`, listener); },
    body: { appendChild() {}, classList: { add() {} } },
  };
  const window = {
    location: { pathname: "/ml/financeiro/margem-venda-mercado-livre", search: "", hash },
    history: { replaceState() {} },
    addEventListener() {},
    FinanceiroMlCosts: { async openForSku(sku) { openedSkus.push(sku); } },
  };
  const fetch = async (url) => {
    requests.push(String(url));
    return {
      ok: true,
      async json() {
        if (String(url).includes("marketing-summary")) return { success: true };
        return {
          success: true,
          summary: {},
          insights: [],
          period_rows: [{ order_id: "101", order_items: [{ sku: "SKU A/B", title: "A", quantity: 1, has_cost: false }] }],
          equilibrium_rows: [],
          meta: {},
        };
      },
    };
  };
  vm.runInNewContext(source, {
    document, window, fetch, FormData: FormDataStub, URLSearchParams,
    mlUrl: (url) => `/ml${url}`,
  });
  listeners.get("document:DOMContentLoaded")();
  return { listeners, requests, openedSkus, fields, nodes };
}

async function flushRequests() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("boot fills suggested dates but waits for the first filter request", async () => {
  const page = bootMargin();
  assert.match(page.fields.get("date_from").value, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(page.fields.get("date_to").value, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(page.requests.length, 0);
  assert.equal(page.nodes.get("fml-summary-panel").dataset.awaitingFilter, "true");

  page.listeners.get("fml-margin-filters:submit")({ preventDefault() {} });
  await flushRequests();
  assert.equal(page.requests.filter((url) => url.includes("/api/financeiro-ml/margin?")).length, 1);
  assert.equal(page.nodes.get("fml-summary-panel").dataset.awaitingFilter, undefined);
  assert.equal(page.nodes.get("fml-period-panel").dataset.awaitingFilter, undefined);
  assert.equal(page.nodes.get("fml-equilibrium-panel").dataset.awaitingFilter, undefined);
});

test("deep link opens the SKU without a margin request", async () => {
  const page = bootMargin("#costs/sku/SKU%20A%2FB");
  await flushRequests();
  assert.deepEqual(page.openedSkus, ["SKU A/B"]);
  assert.equal(page.requests.length, 0);
});

test("only an unmodified primary cost-link click switches the current page", async () => {
  const page = bootMargin();
  page.listeners.get("fml-margin-filters:submit")({ preventDefault() {} });
  await flushRequests();
  const action = { dataset: { periodCostOrder: "101" } };
  const click = page.listeners.get("fml-margin-body:click");
  let prevented = 0;
  const event = (extra = {}) => ({
    button: 0,
    target: { closest: (selector) => selector === "[data-period-cost-order]" ? action : null },
    preventDefault() { prevented += 1; },
    ...extra,
  });

  await click(event({ ctrlKey: true }));
  await click(event({ button: 1 }));
  assert.equal(prevented, 0);
  assert.deepEqual(page.openedSkus, []);

  await click(event());
  assert.equal(prevented, 1);
  assert.deepEqual(page.openedSkus, ["SKU A/B"]);
});
