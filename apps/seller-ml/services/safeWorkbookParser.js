"use strict";

const ExcelJS = require("exceljs");

const DEFAULT_MAX_ROWS = Math.max(
  100,
  Number(process.env.ML_XLSX_IMPORT_MAX_ROWS || 25000),
);
const DEFAULT_MAX_COLUMNS = Math.max(
  16,
  Number(process.env.ML_XLSX_IMPORT_MAX_COLUMNS || 512),
);
const DEFAULT_MAX_SHEETS = Math.max(
  1,
  Number(process.env.ML_XLSX_IMPORT_MAX_SHEETS || 20),
);

function plain(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function cellText(cell) {
  if (!cell) return "";
  const text = cell.text;
  if (text != null && String(text).length) return String(text).trim();

  const value = cell.value;
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (value.result != null) return String(value.result).trim();
    if (value.text != null) return String(value.text).trim();
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => String(part?.text || "")).join("").trim();
    }
    return "";
  }
  return String(value).trim();
}

async function parseXlsxRows(
  buffer,
  {
    preferredSheet = "Caracteristicas",
    maxRows = DEFAULT_MAX_ROWS,
    maxColumns = DEFAULT_MAX_COLUMNS,
    maxSheets = DEFAULT_MAX_SHEETS,
  } = {},
) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error("Arquivo Excel vazio ou invalido.");
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer, {
      ignoreNodes: ["dataValidations", "conditionalFormatting", "extLst"],
    });
  } catch (error) {
    const wrapped = new Error("Nao foi possivel ler o arquivo XLSX enviado.");
    wrapped.code = "INVALID_XLSX";
    wrapped.cause = error;
    throw wrapped;
  }

  if (!workbook.worksheets.length) {
    throw new Error("Arquivo Excel sem planilhas.");
  }
  if (workbook.worksheets.length > maxSheets) {
    throw new Error(`Arquivo Excel excede o limite de ${maxSheets} planilhas.`);
  }

  const wanted = plain(preferredSheet);
  const worksheet =
    workbook.worksheets.find((sheet) => plain(sheet?.name) === wanted) ||
    workbook.worksheets[0];

  const rowCount = Number(worksheet.actualRowCount || worksheet.rowCount || 0);
  const columnCount = Number(
    worksheet.actualColumnCount || worksheet.columnCount || 0,
  );

  if (rowCount > maxRows + 1) {
    throw new Error(`Planilha excede o limite de ${maxRows} linhas de dados.`);
  }
  if (columnCount > maxColumns) {
    throw new Error(`Planilha excede o limite de ${maxColumns} colunas.`);
  }

  const headerRow = worksheet.getRow(1);
  const headers = [];
  for (let column = 1; column <= columnCount; column += 1) {
    headers.push(cellText(headerRow.getCell(column)));
  }

  if (!headers.some(Boolean)) {
    throw new Error("Planilha sem cabecalho.");
  }

  const rows = [];
  for (let rowNumber = 2; rowNumber <= rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const output = {};
    let hasValue = false;

    for (let column = 1; column <= headers.length; column += 1) {
      const header = headers[column - 1];
      if (!header) continue;
      const value = cellText(row.getCell(column));
      output[header] = value;
      if (value) hasValue = true;
    }

    if (hasValue) rows.push(output);
  }

  return rows;
}

module.exports = {
  cellText,
  parseXlsxRows,
};
