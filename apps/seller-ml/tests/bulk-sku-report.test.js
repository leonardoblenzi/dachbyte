"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const ExcelJS = require("exceljs");
const { reportJob } = require("../services/bulkSkuService");

test("SKU result report streams XLSX rows with their final outcome", async () => {
  const queries = [];
  const db = { query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes("select * from ml.bulk_sku_jobs")) return { rows: [{ id: "job-1", status: "finished" }], rowCount: 1 };
    if (sql.includes("group by state")) return { rows: [{ state: "applied", count: 1 }] };
    if (sql.includes("row_number >")) return { rows: params[1] === 0 ? [
      { row_number: 2, mlb: "MLB123456", variation_id: "000987", old_sku: "OLD", new_sku: "NEW", state: "applied", message: "SKU confirmado no ML." },
      { row_number: 3, mlb: "MLB123457", variation_id: "", old_sku: "OLD", new_sku: "#N/A", state: "error", message: "SKU novo contém erro #N/A." },
    ] : [] };
    return { rows: [], rowCount: 0 };
  } };
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));
  await reportJob("job-1", { accountKey: "acct", sellerId: 9, accessToken: "token", requestedBy: "person" }, output, db);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks));
  const sheet = workbook.worksheets[0];
  assert.deepEqual(sheet.getRow(1).values.slice(1), ["linha", "mlb", "id_variacao", "sku_atual", "sku_novo", "resultado", "mensagem"]);
  assert.equal(sheet.getRow(2).getCell(3).text, "000987");
  assert.equal(sheet.getRow(2).getCell(5).text, "NEW");
  assert.equal(sheet.getRow(2).getCell(6).text, "Sucesso");
  assert.equal(sheet.getRow(3).getCell(5).text, "#N/A");
  assert.equal(sheet.getRow(3).getCell(6).text, "Falha");
  assert.match(sheet.getRow(3).getCell(7).text, /#N\/A/);
  assert.ok(queries.some(({ sql, params }) => sql.includes("row_number >") && params[1] === 3));
});
