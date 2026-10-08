"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const row = { sku: "SKU-1", title: "Sofá Azul", price: 150, unit_cost: 60, tax_rate: 6, packaging_cost: 2, operational_cost: 3, other_cost: 1, notes: "teste" };

test("planilha exportada pode ser reimportada com decimais e caracteres", async () => {
  const { buildCostWorkbook, parseCostWorkbook } = require("../src/services/costWorkbookService");
  const ExcelJS = require("exceljs");
  const buffer = await buildCostWorkbook([row]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("Custos por SKU");
  assert.deepEqual(sheet.getRow(1).values.slice(1), ["SKU", "Produto", "Preço atual", "Custo produto"]);
  const parsed = await parseCostWorkbook({ filename: "custos-magalu.xlsx", buffer });
  assert.deepEqual(parsed, [{ sku: "SKU-1", unit_cost: 60 }]);
});

test("importação rejeita arquivos inválidos e valores negativos", async () => {
  const { buildCostWorkbook, parseCostWorkbook } = require("../src/services/costWorkbookService");
  await assert.rejects(() => parseCostWorkbook({ filename: "custos.csv", buffer: Buffer.from("SKU") }), { status: 400 });
  await assert.rejects(() => parseCostWorkbook({ filename: "custos.xlsx", buffer: Buffer.from("not a zip") }), { status: 400 });
  const buffer = await buildCostWorkbook([{ ...row, unit_cost: -1 }], { globalTax: 10 });
  await assert.rejects(() => parseCostWorkbook({ filename: "custos.xlsx", buffer }), { status: 422 });
});

test("importação rejeita SKU duplicado antes de gravar", async () => {
  const { buildCostWorkbook, parseCostWorkbook } = require("../src/services/costWorkbookService");
  const buffer = await buildCostWorkbook([row, row], { globalTax: 10 });
  await assert.rejects(() => parseCostWorkbook({ filename: "custos.xlsx", buffer }), { status: 422 });
});

test("modelo antigo é recusado com orientação para baixar nova planilha", async () => {
  const ExcelJS = require("exceljs");
  const { buildCostWorkbook, parseCostWorkbook } = require("../src/services/costWorkbookService");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildCostWorkbook([row]));
  const sheet = workbook.getWorksheet("Custos por SKU");
  sheet.getCell("D1").value = "Custo unitário";
  sheet.getCell("E1").value = "Imposto legado %";
  sheet.getCell("J1").value = "Alíquota global (informativa)";
  const oldBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
  await assert.rejects(
    () => parseCostWorkbook({ filename: "custos-antigos.xlsx", buffer: oldBuffer }),
    { status: 400, message: /Modelo de custos desatualizado/ }
  );
});

test("importação recusa colunas extras fora do modelo de quatro colunas", async () => {
  const ExcelJS = require("exceljs");
  const { buildCostWorkbook, parseCostWorkbook } = require("../src/services/costWorkbookService");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildCostWorkbook([row]));
  workbook.getWorksheet("Custos por SKU").getCell("E1").value = "Taxa";
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  await assert.rejects(() => parseCostWorkbook({ filename: "extra.xlsx", buffer }), { status: 400 });
});

test("SKU fora da conta cancela toda a importação antes da escrita", async () => {
  const db = require("../src/config/postgres");
  const previous = db.withClient;
  const calls = [];
  db.withClient = async (fn) => fn({ query: async (sql, params) => {
    calls.push({ sql, params });
    if (/from magalu\.skus/.test(sql)) return { rows: [{ sku: "SKU-1" }] };
    return { rows: [] };
  } });
  try {
    const { importCosts } = require("../src/repositories/financialRepository");
    await assert.rejects(() => importCosts(1, [{ sku: "SKU-1", unit_cost: 6 }, { sku: "OUTRA-CONTA", unit_cost: 8 }], "user-1"), { status: 422 });
    assert.equal(calls.at(-1).sql, "ROLLBACK");
    assert.ok(!calls.some((call) => /insert into magalu\.sku_costs/.test(call.sql)));
  } finally { db.withClient = previous; }
});

test("importação válida grava custo e histórico XLSX e preserva componentes não informados", async () => {
  const db = require("../src/config/postgres");
  const previous = db.withClient;
  const calls = [];
  db.withClient = async (fn) => fn({ query: async (sql, params) => {
    calls.push({ sql, params });
    if (/from magalu\.skus/.test(sql)) return { rows: [{ sku: "SKU-1", unit_cost: "5", tax_rate: "6", packaging_cost: "2", operational_cost: "3", other_cost: "1", notes: "antiga" }] };
    return { rows: [] };
  } });
  try {
    const { importCosts } = require("../src/repositories/financialRepository");
    const result = await importCosts(1, [{ sku: "SKU-1", unit_cost: 8 }], "user-1");
    assert.equal(result.updated, 1);
    assert.equal(calls[0].sql, "BEGIN");
    assert.equal(calls.at(-1).sql, "COMMIT");
    const save = calls.find((call) => /insert into magalu\.sku_costs/.test(call.sql));
    assert.ok(save);
    assert.equal(save.params[3], 6);
    assert.equal(save.params[4], 2);
    assert.equal(save.params[5], 3);
    assert.equal(save.params[6], 1);
    assert.equal(save.params[7], "antiga");
    const history = calls.find((call) => /insert into magalu\.sku_cost_history/.test(call.sql));
    assert.ok(history);
    assert.equal(history.params.at(-1), "user-1");
  } finally { db.withClient = previous; }
});

test("endpoint de importação aceita XLSX binário antes do parser JSON global", () => {
  const root = path.join(__dirname, "..");
  const app = fs.readFileSync(path.join(root, "src/app.js"), "utf8");
  const routes = fs.readFileSync(path.join(root, "src/routes/financial.routes.js"), "utf8");
  const controller = fs.readFileSync(path.join(root, "src/controllers/financialController.js"), "utf8");
  assert.match(app, /express\.raw\(/);
  assert.ok(app.indexOf("express.raw(") < app.indexOf("app.use(express.json("));
  assert.match(routes, /router\.post\("\/costs\/import"/);
  assert.match(controller, /parseCostWorkbook/);
  assert.match(controller, /financialRepository\.importCosts/);
  const exportHandler = controller.match(/async function exportCosts\([^\n]+/);
  assert.ok(exportHandler);
  assert.doesNotMatch(exportHandler[0], /getAccountTax/);
});
