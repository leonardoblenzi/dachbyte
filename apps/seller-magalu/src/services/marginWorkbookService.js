"use strict";
const ExcelJS = require("exceljs");

const MONEY = "#,##0.00";
// [cabeçalho, campo, tipo, exige resultado completo]
const COLUMNS = [
  ["Pedido", "code", "text"], ["Data", "purchased_at", "date"], ["SKU", "first_sku", "text"], ["Produto", "first_product", "text"],
  ["Envio", "shipping_name", "text"], ["GMV", "gmv", "money"], ["Preço produto", "sale", "money"], ["CMV", "product_cost", "money"],
  ["Comissões", "commission", "money"], ["Frete líquido", "shipping_net", "money"], ["Base imposto", "tax_base", "money"],
  ["Impostos", "taxes", "money"], ["Tarifas", "fees", "money"], ["Promoções", "promotion_net", "money"], ["Descontos", "discount_net", "money"],
  ["Subsídios", "subsidy", "money"], ["Repasse líquido", "net_receivable", "money"],
  ["Resultado", "known_result", "money", true], ["Margem (%)", "known_margin_pct", "percent", true],
  ["Equilíbrio/un.", "break_even_per_unit", "money", true], ["Status", "status", "text"],
  ["Resultado completo", "result_complete", "bool"], ["Itens/custos pendentes", "missing_cost_items", "int"],
];

function cellValue(row, [, key, type, needsComplete]) {
  const value = row[key];
  if (value == null || value === "") return null;
  if (needsComplete && row.result_complete !== true) return null; // margem desconhecida fica vazia, nunca zero
  if (type === "text") return String(value);
  if (type === "bool") return value === true || value === "true" ? "Sim" : "Não";
  if (type === "date") { const date = value instanceof Date ? value : new Date(value); return Number.isNaN(date.getTime()) ? null : date; }
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return type === "percent" ? number / 100 : number;
}

async function buildMarginWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Margem Magalu");
  sheet.columns = COLUMNS.map(([header, key, type]) => ({
    header, key,
    width: key === "first_product" ? 40 : type === "text" ? 18 : 14,
    style: type === "money" ? { numFmt: MONEY } : type === "percent" ? { numFmt: "0.00%" } : type === "date" ? { numFmt: "dd/mm/yyyy" } : type === "text" ? { numFmt: "@" } : {},
  }));
  for (const row of rows) sheet.addRow(Object.fromEntries(COLUMNS.map((column) => [column[1], cellValue(row, column)])));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { buildMarginWorkbook, _test: { COLUMNS, cellValue } };
