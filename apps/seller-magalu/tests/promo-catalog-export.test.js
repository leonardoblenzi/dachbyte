"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { buildCatalogPriceWorkbook } = require("../src/services/promoWorkbookService");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const ROW = {
  sku: "77731-67075", ean: "7908670857241", group_id: "63f6219a", title: "Balcão para Cozinha", status: "PUBLISHED", active: true, category_id: "MO",
  unit_cost: "219.86", tax_rate: "10", list_price: "593.91", price: "521.90", price_present: true, price_error: null, price_synced_at: new Date().toISOString(),
};

async function sheetOf(buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  return book.getWorksheet("Preços do catálogo");
}

test("planilha do recorte traz as colunas da tela de Preços do catálogo", async () => {
  const sheet = await sheetOf(await buildCatalogPriceWorkbook([ROW]));
  const header = sheet.getRow(1).values.slice(1);
  assert.deepEqual(header, ["SKU", "EAN", "Família", "Produto", "Publicação", "Atividade", "Categoria", "Custo (R$)", "Imposto (%)", "Preço cheio (R$)", "Preço atual (R$)", "Leitura do preço", "Lido em"]);
  const row = sheet.getRow(2).values.slice(1);
  assert.equal(row[0], "77731-67075");
  assert.equal(row[1], "7908670857241", "EAN como texto, sem virar número");
  assert.equal(row[7], 219.86);
  assert.equal(row[10], 521.9);
  assert.equal(row[11], "Recente");
});

test("com revisao calculada inclui preco sugerido, Pix e margens", async () => {
  const withResult = { ...ROW, preview_result: { suggested_price: 479.9, pix_price: 407.92, estimated_margin: 19.73, pix_margin: 15.41, eligible: true, issues: [] } };
  const pending = { ...ROW, sku: "x", preview_result: { suggested_price: 100, eligible: false, issues: ["Custo ausente"] } };
  const sheet = await sheetOf(await buildCatalogPriceWorkbook([withResult, pending, { ...ROW, sku: "y" }], { withPreview: true }));
  const header = sheet.getRow(1).values.slice(1);
  assert.ok(header.includes("Preço no Pix (R$)") && header.includes("Margem no Pix (%)"));
  const col = (name) => header.indexOf(name) + 1;
  assert.equal(sheet.getRow(2).getCell(col("Preço sugerido (R$)")).value, 479.9);
  assert.equal(sheet.getRow(2).getCell(col("Preço no Pix (R$)")).value, 407.92);
  assert.equal(sheet.getRow(2).getCell(col("Situação na revisão")).value, "Apto");
  assert.equal(sheet.getRow(3).getCell(col("Situação na revisão")).value, "Custo ausente");
  assert.equal(sheet.getRow(4).getCell(col("Situação na revisão")).value, "Fora da revisão");
});

test("botao Exportar XLSX fica ao lado de Atualizar precos do recorte e exporta todas as paginas", () => {
  const html = read("views/app.html");
  assert.match(html, /<div class="mg-promo-results-actions"><button class="mg-secondary-btn" id="mg-promo-export-list" type="button">Exportar XLSX<\/button><button class="mg-secondary-btn" id="mg-promo-refresh"/);
  assert.match(read("src/routes/api.routes.js"), /router\.post\("\/promo-prices\/export",promoPriceController\.exportList\)/);
  const repo = read("src/repositories/promoPriceRepository.js");
  const exportFn = repo.slice(repo.indexOf("async function exportRows"));
  assert.doesNotMatch(exportFn.slice(0, exportFn.indexOf("return rows")), /limit \$/, "sem paginacao");
  assert.match(read("public/js/magalu-promocoes-massa.js"), /fetch\("\/magalu\/api\/promo-prices\/export"/);
});
