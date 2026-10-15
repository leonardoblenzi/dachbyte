"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { successfulBodies, assertDetailsAvailable } = require("../services/financeiroMlCatalogBulk");

test("aceita detalhe bulk com body.id mesmo sem code", () => {
  const item = { id: "MLB123", attributes: [{ id: "SELLER_SKU", value_name: "SKU-1" }] };
  assert.deepEqual(successfulBodies([{ body: item }]), [item]);
});

test("aceita code e status_code 200 e rejeita erros explicitos", () => {
  const first = { id: "MLB1" };
  const second = { id: "MLB2" };
  assert.deepEqual(successfulBodies([
    { code: 200, body: first },
    { status_code: 200, body: second },
    { code: 404, body: { id: "MLB3" } },
    { code: 500, body: { id: "MLB4" } },
    { body: { title: "sem id" } },
  ]), [first, second]);
});

test("falha quando IDs foram descobertos mas nenhum detalhe valido retornou", () => {
  assert.throws(() => assertDetailsAvailable(26, 0), /nenhum detalhe valido/i);
  assert.doesNotThrow(() => assertDetailsAvailable(0, 0));
  assert.doesNotThrow(() => assertDetailsAvailable(26, 1));
});

test("aba informa quantos SKUs e anuncios sem SKU vieram da ultima sincronizacao", async () => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      textContent: "", innerHTML: "", dataset: {}, value: "", disabled: false,
      addEventListener() {}, focus() {},
    });
    return elements.get(id);
  };
  const document = {
    getElementById: element,
    querySelectorAll: () => [],
  };
  const payload = {
    success: true,
    summary: { total_skus: 1, filled_skus: 0, missing_skus: 1, coverage_pct: 0 },
    risk_overview: {}, items: [], page: 1, pageSize: 25, total: 1, totalPages: 1,
    meta: { source: "catalog", latest_sync: { status: "completed", total_skus: 1, no_sku_items: 2, total_items: 3 } },
  };
  const fetch = async (url) => ({
    ok: true,
    json: async () => String(url).includes("/costs?") ? payload : { success: true, config: { aliquota: 0 } },
  });
  class EmptyFormData { *[Symbol.iterator]() {} }
  const window = { MLLoadingOverlay: { show() {}, hide() {} } };
  const source = fs.readFileSync(path.join(__dirname, "../public/js/financeiro-ml-custos.js"), "utf8");
  vm.runInNewContext(source, {
    window, document, fetch, mlUrl: (value) => value,
    FormData: EmptyFormData, URLSearchParams, Intl,
  });
  await window.FinanceiroMlCosts.init();

  assert.match(element("fml-kpi-note").textContent, /1 SKU/i);
  assert.match(element("fml-kpi-note").textContent, /2 anúncios? sem SKU/i);
});
