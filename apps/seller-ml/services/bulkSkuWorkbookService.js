"use strict";

const ExcelJS = require("exceljs");

const HEADERS = ["conta", "mlb", "id_variacao", "nome_variacao", "ean_gtin_atual", "sku_atual", "sku_novo"];
const MAX_ROWS = 5000;

function cellText(cell) {
  const value = cell?.value;
  if (value == null) return "";
  if (typeof value === "object") {
    if ("text" in value) return String(value.text);
    throw Object.assign(new Error("A planilha deve conter texto, sem formulas ou links."), { statusCode: 400 });
  }
  return String(value);
}

async function exportWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Alteracao de SKUs");
  sheet.columns = HEADERS.map((key) => ({ header: key, key, width: key === "nome_variacao" ? 28 : 22, style: { numFmt: "@" } }));
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(HEADERS.map((key) => String(row[key] ?? "")));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function parseWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw Object.assign(new Error("Planilha vazia."), { statusCode: 400 });
  const headers = HEADERS.map((_, index) => cellText(sheet.getRow(1).getCell(index + 1)).trim());
  if (headers.some((value, index) => value !== HEADERS[index])) {
    throw Object.assign(new Error("Cabecalhos da planilha nao correspondem ao modelo exportado."), { statusCode: 400 });
  }
  const rows = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const values = HEADERS.map((_, index) => cellText(sheet.getRow(rowNumber).getCell(index + 1)).trim());
    if (values.every((value) => !value)) continue;
    rows.push(Object.fromEntries(HEADERS.map((key, index) => [key, values[index]])));
    if (rows.length > MAX_ROWS) throw Object.assign(new Error("Limite de 5.000 linhas por planilha."), { statusCode: 400 });
  }
  return rows;
}

function csvCell(value) {
  const raw = String(value ?? "");
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

function reportCsv(rows) {
  const headers = ["mlb", "id_variacao", "sku_atual", "sku_novo", "resultado", "mensagem"];
  return `\uFEFF${headers.join(";")}\r\n${rows.map((row) => headers.map((key) => csvCell(row[key])).join(";")).join("\r\n")}`;
}

module.exports = { HEADERS, MAX_ROWS, exportWorkbook, parseWorkbook, reportCsv };
