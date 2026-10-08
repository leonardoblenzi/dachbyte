"use strict";
const ExcelJS = require("exceljs");

const COLUMNS = [
  ["SKU", "sku"], ["Produto", "title"], ["Preço atual", "price"],
  ["Custo produto", "unit_cost"]
];
const EDITABLE = ["unit_cost"];
function invalid(message, status = 422, errors = []) {
  const error = new Error(message); error.status = status; error.details = errors; return error;
}

function parseAmount(value, { percentage = false } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") return undefined;
  let parsed;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "string") {
    const raw = value.trim();
    if (/^\d{1,3}(?:\.\d{3})*,\d{1,4}$/.test(raw)) parsed = Number(raw.replace(/\./g, "").replace(",", "."));
    else if (/^\d+(?:[.,]\d{1,4})?$/.test(raw)) parsed = Number(raw.replace(",", "."));
  }
  if (!Number.isFinite(parsed) || parsed < 0 || (percentage && parsed > 100)) throw invalid("Valor numérico inválido.");
  return parsed;
}

async function buildCostWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Custos por SKU");
  sheet.columns = COLUMNS.map(([header, key]) => ({ header, key, width: key === "title" ? 48 : 20 }));
  for (const row of rows) sheet.addRow(row);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: "D1" };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function parseCostWorkbook({ filename, buffer }) {
  if (!String(filename || "").toLowerCase().endsWith(".xlsx")) throw invalid("Baixe o modelo XLSX e envie uma planilha .xlsx.", 400);
  if (!Buffer.isBuffer(buffer) || buffer.length < 10 || buffer.length > 25 * 1024 * 1024) throw invalid("Arquivo XLSX inválido ou maior que 25 MB.", 400);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); } catch (_error) { throw invalid("Arquivo XLSX inválido. Baixe o modelo novamente.", 400); }
  const sheet = workbook.getWorksheet("Custos por SKU") || workbook.worksheets[0];
  if (!sheet) throw invalid("Planilha de custos ausente.", 400);
  const headers = COLUMNS.map(([header]) => header);
  const actualHeaders = sheet.getRow(1).values.slice(1).map((value) => String(value || "").trim());
  if (actualHeaders.includes("Imposto legado %") || actualHeaders.includes("Alíquota global (informativa)")) {
    throw invalid("Modelo de custos desatualizado. Baixe uma nova planilha XLSX.", 400);
  }
  if (actualHeaders.length !== headers.length || headers.some((header, index) => actualHeaders[index] !== header)) {
    throw invalid("Cabeçalhos diferentes do modelo. Baixe uma nova planilha XLSX.", 400);
  }
  if (sheet.rowCount > 50001) throw invalid("A planilha excede 50.000 SKUs.", 413);
  const rows = [], errors = [], seen = new Set();
  for (let number = 2; number <= sheet.rowCount; number++) {
    const cells = sheet.getRow(number);
    const sku = String(cells.getCell(1).value ?? "").trim();
    if (!sku && cells.values.every((value) => value == null || value === "")) continue;
    if (!sku || sku.length > 128) { errors.push({ line: number, reason: "SKU ausente ou longo demais." }); continue; }
    if (seen.has(sku)) { errors.push({ line: number, sku, reason: "SKU duplicado." }); continue; }
    seen.add(sku);
    const next = { sku };
    for (const key of EDITABLE) {
      const index = COLUMNS.findIndex(([, column]) => column === key) + 1;
      try {
        const value = parseAmount(cells.getCell(index).value);
        if (value !== undefined) next[key] = value;
      } catch (_error) { errors.push({ line: number, sku, reason: `${COLUMNS[index - 1][0]} inválido.` }); }
    }
    if (Object.keys(next).length > 1) rows.push(next);
  }
  if (errors.length) throw invalid(`Planilha contém ${errors.length} erro(s). Nenhum custo foi alterado.`, 422, errors);
  return rows;
}

module.exports = { buildCostWorkbook, parseCostWorkbook, _test: { parseAmount, COLUMNS } };
