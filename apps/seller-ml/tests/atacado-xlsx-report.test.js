"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const fs = require("node:fs");
const path = require("node:path");
process.env.ML_DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.REDIS_URL ||= "redis://127.0.0.1:6379";
const AtacadoJobsService = require("../services/atacadoJobsService");

test("relatório XLSX do atacado contém resumo, todos os resultados e faixas percentuais tipadas", async () => {
  const buffer = await AtacadoJobsService._test.buildAtacadoResultsWorkbook([
    {
      id: "MLB123",
      status: "applied",
      reason: "Atacado aplicado com sucesso.",
      row: { title: "Produto", seller_custom_field: "SKU-1", item_price: 100, sale_price: 90, promo_active: true, promo_percent: 10, currency_id: "BRL" },
      payload: { price_per_quantity: [{ type: "discount_percentage", percentage: 5, conditions: { min_purchase_unit: 2 } }] },
    },
    { id: "MLB456", status: "error", reason: "Quantidade incoerente" },
  ], { jobId: "job_1", status: "concluido", total: 2, applied: 1, errors: 1, accountLabel: "Conta teste" });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.equal(workbook.getWorksheet("Resumo do job").getCell("B2").value, "job_1");
  const results = workbook.getWorksheet("Resultados");
  assert.equal(results.rowCount, 3);
  assert.equal(results.getRow(2).getCell(1).value, "MLB123");
  assert.equal(results.getRow(2).getCell(6).value, 100);
  assert.equal(results.getRow(3).getCell(2).value, "error");
  assert.equal(results.getRow(3).getCell(3).value, "Quantidade incoerente");
  const tiers = workbook.getWorksheet("Faixas");
  assert.equal(tiers.rowCount, 2);
  assert.equal(tiers.getRow(2).getCell(2).value, 2);
  assert.equal(tiers.getRow(2).getCell(3).value, 0.05);
});

test("painel oferece somente XLSX para job de aplicação finalizado com resultados", () => {
  const action = AtacadoJobsService._test.atacadoResultAction({ id: "job_1", kind: "atacado", status: "concluido", resultTotal: 2 });
  assert.deepEqual(action, {
    type: "download_xlsx",
    label: "Baixar XLSX",
    url: "/api/atacado/jobs/job_1/download.xlsx",
    download: true,
  });
  assert.equal(AtacadoJobsService._test.atacadoResultAction({ id: "job_1", kind: "atacado", status: "processando", resultTotal: 2 }), null);
  assert.equal(AtacadoJobsService._test.atacadoResultAction({ id: "job_1", kind: "atacado-load-active", status: "concluido", resultTotal: 2 }), null);
  assert.equal(AtacadoJobsService._test.atacadoResultAction({ id: "job_1", kind: "atacado", status: "concluido", resultTotal: 0 }), null);
});

test("XLSX preserva faixas de jobs antigos com payload de preço absoluto", async () => {
  const buffer = await AtacadoJobsService._test.buildAtacadoResultsWorkbook([{
    id: "MLB789", status: "applied", row: { sale_price: 100 },
    payload: { prices: [{ amount: 90, conditions: { min_purchase_unit: 2 } }] },
  }], { jobId: "antigo", total: 1, processed: 1 });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const tier = workbook.getWorksheet("Faixas").getRow(2);
  assert.equal(tier.getCell(2).value, 2);
  assert.equal(tier.getCell(3).value, 0.1);
  assert.equal(tier.getCell(5).value, 90);
});

test("rota e cliente do resultado do job de atacado não anunciam CSV", () => {
  const routeSource = fs.readFileSync(path.join(__dirname, "../routes/atacadoRoutes.js"), "utf8");
  const clientSource = fs.readFileSync(path.join(__dirname, "../public/js/atacado.js"), "utf8");
  assert.match(routeSource, /\/jobs\/:job_id\/download\.xlsx/);
  assert.doesNotMatch(routeSource, /\/jobs\/:job_id\/download\.csv/);
  assert.match(clientSource, /Baixar XLSX/);
  assert.doesNotMatch(clientSource, /atacadoJobCsvUrl|download_csv_url/);
});
