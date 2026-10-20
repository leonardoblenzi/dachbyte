"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { exportWorkbook } = require("../services/bulkSkuWorkbookService");
const { readEditedRows, countEditedRows, runPreview, importPath } = require("../services/bulkSkuPreviewJobService");

test("one workbook can yield more than 5,000 edited SKU rows in bounded batches", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bulk-sku-test-"));
  const filename = path.join(temp, "many.xlsx");
  try {
    const rows = Array.from({ length: 5201 }, (_, i) => ({ conta: "Loja", mlb: `MLB${100000000 + i}`, id_variacao: "", nome_variacao: "Produto único", ean_gtin_atual: "", sku_atual: `OLD-${i}`, sku_novo: `NEW-${i}` }));
    fs.writeFileSync(filename, await exportWorkbook(rows));
    let count = 0; let largestBatch = 0;
    for await (const batch of readEditedRows(filename, 100)) { count += batch.length; largestBatch = Math.max(largestBatch, batch.length); }
    assert.equal(count, 5201);
    assert.equal(await countEditedRows(filename), 5201);
    assert.ok(largestBatch <= 100);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("preview job classifies more than 5,000 rows and persists every decision", async () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const filename = importPath(id);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const rows = Array.from({ length: 5101 }, (_, i) => ({ conta: "Loja", mlb: `MLB${200000000 + i}`, id_variacao: "", nome_variacao: "Produto único", ean_gtin_atual: "", sku_atual: `OLD-${i}`, sku_novo: `NEW-${i}` }));
  fs.writeFileSync(filename, await exportWorkbook(rows));
  let inserted = 0; let finished = false;
  const db = {
    query: async (sql) => {
      if (sql.startsWith("select *")) return { rows: [{ id, account_key: "acct", account_label: "Loja", status: "preview_queued", previewed_rows: 0, ready_rows: 0 }] };
      if (sql.includes("status = 'preview'")) finished = true;
      return { rows: [] };
    },
    withClient: async (fn) => fn({ query: async (sql) => { if (sql.includes("insert into ml.bulk_sku_job_rows")) inserted += 1; return { rows: [] }; } }),
  };
  const ml = { get: async (url) => new URL(`https://example.test${url}`).searchParams.get("ids").split(",").map((itemId) => ({ code: 200, body: { id: itemId, seller_id: 9, attributes: [{ id: "SELLER_SKU", value_name: `OLD-${Number(itemId.slice(3)) - 200000000}` }] } })) };
  const result = await runPreview(id, { db, ml, loadCredentials: async () => ({ accessToken: "token", mlCreds: { meli_user_id: 9 } }) });
  assert.equal(inserted, 5101);
  assert.equal(result.ready_rows, 5101);
  assert.equal(finished, true);
  assert.equal(fs.existsSync(filename), false);
});
