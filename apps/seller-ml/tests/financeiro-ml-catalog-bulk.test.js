"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const { successfulBodies, assertCompleteDetails } = require("../services/financeiroMlCatalogBulk");

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

test("falha antes de reconstruir o catalogo quando detalhes bulk retornam parcialmente", () => {
  assert.throws(() => assertCompleteDetails(["MLB1", "MLB2"], [{ id: "MLB1" }]), /1 de 2 detalhes/i);
  assert.throws(() => assertCompleteDetails(["MLB1"], []), /1 de 1 detalhes/i);
  assert.throws(() => assertCompleteDetails(["MLB1"], [{ id: "MLB2" }]), /detalhes/i);
  assert.doesNotThrow(() => assertCompleteDetails([], []));
  assert.doesNotThrow(() => assertCompleteDetails(["mlb1", "MLB2"], [{ id: "MLB1" }, { id: "mlb2" }]));
  assert.doesNotThrow(() => assertCompleteDetails(["MLB1", "MLB2"], ["mlb1", "mlb2"]));
});

test("job com resposta bulk parcial falha sem substituir a base anterior", async () => {
  const filename = require.resolve("../services/financeiroMlSkuCatalogSyncService");
  const source = fs.readFileSync(filename, "utf8");
  const queries = [];
  let catalogConnectionOpened = false;
  const db = {
    query: async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("returning id")) return { rows: [{ id: 77 }] };
      return { rows: [] };
    },
    pool: { connect: async () => { catalogConnectionOpened = true; throw new Error("catalog write started"); } },
  };
  const fetch = async (url) => {
    const pathname = new URL(url).pathname;
    const payload = pathname === "/users/me"
      ? { id: 123 }
      : pathname.endsWith("/items/search")
        ? { results: ["MLB1", "MLB2"] }
        : pathname === "/orders/search"
          ? { results: [], paging: { total: 0 } }
          : pathname === "/items/bulk"
            ? [{ body: { id: "MLB1", seller_custom_field: "SKU-1" } }, { code: 404, body: { id: "MLB2" } }]
            : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  const mocked = {
    bull: class {},
    "node-fetch": fetch,
    "../db/db": db,
    "../lib/redisClient": { makeBullClient() {} },
    "./tokenService": { renovarTokenSeNecessario: async () => "test-token" },
    "./financeiroMlCatalogSyncBillingService": { telemetry: () => ({}) },
  };
  const originalLoad = Module._load;
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  Module._load = function loadForTest(request, parent, isMain) {
    if (parent?.filename === filename && Object.hasOwn(mocked, request)) return mocked[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    compiled._compile(`${source}\nmodule.exports.testProcessSyncJob = processSyncJob;`, filename);
  } finally {
    Module._load = originalLoad;
  }
  const job = {
    data: { accountKey: "test-account", mlCreds: {}, trigger: "internal" },
    progress: async () => {},
    update: async () => {},
  };
  await assert.rejects(compiled.exports.testProcessSyncJob(job), /1 de 2 detalhes/);
  assert.equal(catalogConnectionOpened, false);
  assert.equal(queries.some(({ sql }) => sql.includes("update ml.mercadolivre_sku_catalog\n")), false);
  assert.equal(queries.some(({ sql, params }) => sql.includes("update ml.mercadolivre_sku_sync_runs") && params.includes("failed")), true);
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
