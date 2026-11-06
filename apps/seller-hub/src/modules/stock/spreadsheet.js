// @ts-check
"use strict";

/**
 * Planilha de estoque: duas colunas, SKU e quantidade. Aceita CSV (; , ou tab, com ou sem
 * cabeçalho, decimal com vírgula) e Excel (.xlsx, primeira aba).
 * @typedef {{ line: number, sku: string, quantity: number }} SheetRow
 * @typedef {{ line: number, message: string }} SheetError
 */

const MAX_ROWS = 50_000;
const SKU_HEADERS = ["sku", "codigo", "código", "sku dach", "referencia", "referência"];
const QTY_HEADERS = ["quantidade", "qtd", "qtde", "estoque", "saldo", "quantity", "stock", "disponivel", "disponível"];

/** @param {unknown} v */
const clean = (v) => String(v == null ? "" : v).replace(/^﻿/, "").trim();

/** "1.234,5" / "1234.5" / "12" → número. @param {unknown} raw */
function parseQuantity(raw) {
  if (typeof raw === "number") return raw;
  let text = clean(raw).replace(/\s/g, "");
  if (!text) return NaN;
  if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, ""); // "1.200" = mil e duzentos
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
}

/** @param {string} text */
function detectSeparator(text) {
  const first = text.split(/\r?\n/).find((line) => line.trim()) || "";
  if (first.includes("\t")) return "\t";
  if (first.includes(";")) return ";";
  return ",";
}

/** Divide uma linha CSV respeitando aspas. @param {string} line @param {string} sep */
function splitLine(line, sep) {
  /** @type {string[]} */
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Converte a grade (linhas × colunas) em linhas SKU/quantidade.
 * Com cabeçalho reconhecido, usa as colunas pelo nome; sem cabeçalho, coluna 1 = SKU e 2 = quantidade.
 * @param {unknown[][]} grid @returns {{ rows: SheetRow[], errors: SheetError[] }}
 */
function rowsFromGrid(grid) {
  /** @type {SheetRow[]} */
  const rows = [];
  /** @type {SheetError[]} */
  const errors = [];
  let skuCol = 0, qtyCol = 1, start = 0;
  const firstFilled = grid.findIndex((r) => r.some((c) => clean(c)));
  if (firstFilled >= 0) {
    const header = grid[firstFilled].map((c) => clean(c).toLowerCase());
    const s = header.findIndex((h) => SKU_HEADERS.includes(h));
    const q = header.findIndex((h) => QTY_HEADERS.includes(h));
    if (s >= 0 && q >= 0) { skuCol = s; qtyCol = q; start = firstFilled + 1; }
    else if (Number.isNaN(parseQuantity(grid[firstFilled][1]))) start = firstFilled + 1; // cabeçalho com outros nomes
    else start = firstFilled;
  }
  for (let i = start; i < grid.length; i += 1) {
    const line = i + 1;
    const sku = clean(grid[i][skuCol]);
    const rawQty = grid[i][qtyCol];
    if (!sku && !clean(rawQty)) continue;
    if (!sku) { errors.push({ line, message: "SKU vazio." }); continue; }
    const quantity = parseQuantity(rawQty);
    if (!Number.isFinite(quantity)) { errors.push({ line, message: `Quantidade inválida para ${sku}.` }); continue; }
    if (!Number.isInteger(quantity)) { errors.push({ line, message: `Use número inteiro para ${sku}.` }); continue; }
    rows.push({ line, sku, quantity });
    if (rows.length > MAX_ROWS) { errors.push({ line, message: `A planilha passa de ${MAX_ROWS} linhas.` }); break; }
  }
  return { rows, errors };
}

/** @param {string} text */
function parseCsv(text) {
  const sep = detectSeparator(text);
  return rowsFromGrid(text.replace(/^﻿/, "").split(/\r?\n/).map((line) => splitLine(line, sep)));
}

/** @param {Buffer} buffer */
async function parseXlsx(buffer) {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(/** @type {any} */ (buffer));
  const sheet = workbook.worksheets[0];
  if (!sheet) return { rows: [], errors: [{ line: 0, message: "Planilha sem abas." }] };
  /** @type {unknown[][]} */
  const grid = [];
  sheet.eachRow({ includeEmpty: true }, (row, number) => {
    const values = /** @type {unknown[]} */ (Array.isArray(row.values) ? row.values.slice(1) : []);
    grid[number - 1] = values.map((v) => (v && typeof v === "object" && "result" in /** @type {any} */ (v) ? /** @type {any} */ (v).result : v && typeof v === "object" && "text" in /** @type {any} */ (v) ? /** @type {any} */ (v).text : v));
  });
  for (let i = 0; i < grid.length; i += 1) grid[i] = grid[i] || [];
  return rowsFromGrid(grid);
}

/**
 * Lê o arquivo enviado pela tela (base64) conforme a extensão.
 * @param {{ fileName: string, contentBase64: string }} file
 */
async function parseSpreadsheet({ fileName, contentBase64 }) {
  const buffer = Buffer.from(String(contentBase64 || ""), "base64");
  if (!buffer.length) return { rows: [], errors: [{ line: 0, message: "Arquivo vazio." }] };
  if (/\.xlsx$/i.test(String(fileName || ""))) {
    try { return await parseXlsx(buffer); } catch (_error) { return { rows: [], errors: [{ line: 0, message: "Não foi possível ler o Excel. Salve como .xlsx ou .csv." }] }; }
  }
  if (/\.xls$/i.test(String(fileName || ""))) return { rows: [], errors: [{ line: 0, message: "Formato .xls antigo não é aceito. Salve como .xlsx ou .csv." }] };
  return parseCsv(buffer.toString("utf8"));
}

/**
 * CSV para Excel em português (separador ;, BOM para acentos).
 * @param {string[]} header @param {Array<Array<string | number | null>>} rows
 */
function toCsv(header, rows) {
  /** @param {string | number | null} v */
  const cell = (v) => {
    const text = v == null ? "" : typeof v === "number" ? String(v).replace(".", ",") : String(v);
    return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `﻿${[header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n")}\r\n`;
}

module.exports = { parseSpreadsheet, parseCsv, rowsFromGrid, parseQuantity, toCsv, MAX_ROWS };
