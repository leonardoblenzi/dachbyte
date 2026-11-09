"use strict";

// Análise (A1) sem banco: período, comparação, curva ABC, rotas e menu.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const { resolvePeriod, summarize, rankProducts } = require("../src/modules/analytics/service");
const { createApp } = require("../src/app");
const { loadConfig } = require("../src/platform/config");
const { PAGES } = require("../src/web/pages");

test("período: padrão de 30 dias até hoje (São Paulo), anterior do mesmo tamanho e limites", () => {
  const p = resolvePeriod({}, new Date("2026-11-10T02:00:00Z")); // 23h de 09/11 em São Paulo
  assert.deepEqual(p, { from: "2026-10-11", to: "2026-11-09", days: 30, previous: { from: "2026-09-11", to: "2026-10-10" } });
  assert.deepEqual(resolvePeriod({ from: "2026-11-01", to: "2026-11-07" }, new Date()).previous, { from: "2026-10-25", to: "2026-10-31" });
  assert.throws(() => resolvePeriod({ from: "2026-11-08", to: "2026-11-01" }, new Date()), /depois da final/);
  assert.throws(() => resolvePeriod({ from: "2024-01-01", to: "2026-01-01" }, new Date()), /até 1 ano/);
  assert.throws(() => resolvePeriod({ from: "ontem" }, new Date()), /Data inválida/);
});

test("resumo: canal que só vendeu antes aparece com zero; variação sem base fica nula", () => {
  const cur = [{ accountId: 1, channel: "mercadolivre", account: "ML", orders: 4, gmv: 400, cancelledOrders: 1, cancelledValue: 50 }];
  const prev = [{ accountId: 1, channel: "mercadolivre", account: "ML", orders: 2, gmv: 200, cancelledOrders: 0, cancelledValue: 0 },
    { accountId: 2, channel: "shopee", account: "SH", orders: 1, gmv: 80, cancelledOrders: 0, cancelledValue: 0 }];
  const r = summarize(cur, prev);
  assert.equal(r.totals.ticket, 100);
  assert.equal(r.totals.change.gmv, 42.9);
  assert.equal(r.totals.cancelRate, 20);
  assert.deepEqual(r.channels.map((c) => [c.channel, c.gmv, c.change.gmv]), [["mercadolivre", 400, 100], ["shopee", 0, -100]]);
  assert.equal(summarize(cur, []).totals.change.gmv, null);
});

test("curva ABC usa o acumulado antes do item (o que cruza 80% ainda é A)", () => {
  const rows = [["a", 70], ["b", 20], ["c", 6], ["d", 4]].map(([sku, revenue], i) => ({ key: sku, itemId: i + 1, sku, name: sku, channel: "shopee", units: 1, revenue, orders: 1 }));
  assert.deepEqual(rankProducts(rows).map((p) => p.abc), ["A", "A", "B", "C"]);
});

test("rotas da análise exigem login, repassam filtros e o CSV sai com BOM para o Excel", async () => {
  const SECRET = "segredo-de-teste";
  const calls = [];
  const analytics = {
    sales: async (tenant, q) => { calls.push(["sales", tenant, q.channel]); return { period: {}, totals: {}, channels: [], accounts: [] }; },
    products: async (tenant, q) => { calls.push(["products", tenant, q.sort]); return { products: [] }; },
    productsCsv: async () => "Posição;SKU",
  };
  const config = loadConfig({ SUITE_JWT_SECRET: SECRET, HUB_ALLOWED_TENANTS: "t1" });
  const app = await createApp({ config, db: {}, analytics, catalog: {}, imports: {}, orders: {}, sync: {}, syncQueues: {}, stock: {} });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `suite_auth_token=${jwt.sign({ tenant_id: "t1", user_id: "u1", email: "a@b.com" }, SECRET)}`;
  try {
    assert.equal((await fetch(`${base}/api/analytics/sales`)).status, 401);
    assert.equal((await fetch(`${base}/api/analytics/sales?channel=shopee`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/analytics/products?sort=units`, { headers: { cookie } })).status, 200);
    const csv = await fetch(`${base}/api/analytics/products.csv`, { headers: { cookie } });
    assert.match(csv.headers.get("content-disposition"), /mais-vendidos-dach-hub-/);
    assert.deepEqual([...new Uint8Array(await csv.arrayBuffer()).slice(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.deepEqual(calls, [["sales", "t1", "shopee"], ["products", "t1", "units"]]);
  } finally { server.close(); }
});

test("telas de Análise no menu e nas páginas", () => {
  assert.equal(PAGES["/analise"].view, "salesAnalysis");
  assert.equal(PAGES["/analise/produtos"].view, "topProducts");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "hub-app.js"), "utf8");
  assert.match(app, /label: "Análise".*icon: "chart"/);
  const shell = fs.readFileSync(path.join(__dirname, "..", "..", "shared", "seller-ui", "seller-shell.js"), "utf8");
  assert.match(shell, /chart: '/);
});
