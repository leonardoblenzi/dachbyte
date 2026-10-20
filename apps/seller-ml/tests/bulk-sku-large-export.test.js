"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { scanSellerItems, normalizeStatus, runExport, exportPath, getExport } = require("../services/bulkSkuExportService");

test("status filter accepts all, active and paused only", () => {
  assert.equal(normalizeStatus("all"), "all");
  assert.equal(normalizeStatus("active"), "active");
  assert.equal(normalizeStatus("paused"), "paused");
  assert.throws(() => normalizeStatus("closed,active"), /Filtro de status/);
});

test("export job writes more than 5,000 SKU rows to one workbook", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  let page = 0;
  let finalRows = 0;
  const ml = { get: async (url) => {
    if (url.includes("/items/search")) {
      page += 1;
      return { results: Array.from({ length: 100 }, (_, i) => `MLB${100000000 + (page - 1) * 100 + i}`), scroll_id: page < 52 ? `cursor-${page}` : "" };
    }
    const ids = new URL(`https://example.test${url}`).searchParams.get("ids").split(",");
    return ids.map((itemId) => ({ code: 200, body: { id: itemId, seller_id: 9, attributes: [{ id: "SELLER_SKU", value_name: itemId }] } }));
  } };
  const db = { query: async (sql, params) => {
    if (sql.startsWith("select *")) return { rows: [{ id, account_key: "acct", seller_id: "9", account_label: "Loja", filter_status: "active" }] };
    if (sql.includes("status = 'finished'")) finalRows = params[2];
    return { rows: [] };
  } };
  try {
    const result = await runExport(id, { db, ml, loadCredentials: async () => ({ accessToken: "token", mlCreds: { meli_user_id: 9 } }) });
    assert.equal(result.exported_rows, 5200);
    assert.equal(finalRows, 5200);
    assert.ok(fs.statSync(exportPath(id)).size > 100000);
  } finally { try { fs.unlinkSync(exportPath(id)); } catch (_) {} }
});

test("export lookup is scoped to active account and user", async () => {
  const parameters = [];
  const db = { query: async (_sql, params) => { parameters.push(params); return { rows: [] }; } };
  const result = await getExport("job", { accountKey: "acct-1", sellerId: 9, accessToken: "token", requestedBy: "user-2" }, db);
  assert.equal(result, null);
  assert.deepEqual(parameters[0], ["job", "acct-1", "user-2"]);
});

test("scanner continues past 5,000 items and sends status to ML", async () => {
  let calls = 0;
  const observed = [];
  const ml = { get: async (_path, { query }) => {
    calls += 1; observed.push(query);
    return { results: Array.from({ length: 100 }, (_, i) => `MLB${100000000 + (calls - 1) * 100 + i}`), scroll_id: calls < 52 ? `cursor-${calls}` : "" };
  } };
  let count = 0;
  await scanSellerItems({ sellerId: 9, accessToken: "token" }, "active", ml, async (ids) => { count += ids.length; });
  assert.equal(count, 5200);
  assert.equal(observed[0].status, "active");
  assert.equal(observed[51].scroll_id, "cursor-51");
});
