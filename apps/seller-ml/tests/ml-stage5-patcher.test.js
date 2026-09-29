"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  patchApp,
  patchCaracteristicas,
  patchPromocoes,
} = require("../scripts/apply-stage5-patches");

test("patch do app reduz parser global e oculta erro interno em producao", () => {
  const source = `x\n  app.use(express.json({ limit: "10mb" }));\n  app.use(express.urlencoded({ extended: true }));\ny\n    res.status(500).json({\n      success: false,\n      error: "Erro interno do servidor",\n      message: error.message,\n      timestamp: new Date().toISOString(),\n      path: req.originalUrl,\n    });\nz`;
  const result = patchApp(source).content;
  assert.match(result, /ML_JSON_BODY_LIMIT/);
  assert.match(result, /"1mb"/);
  assert.match(result, /routeHasOwnLargeBodyParser/);
  assert.doesNotMatch(result, /message: error\.message/);
});

test("patch de caracteristicas remove XLSX.read e usa parser seguro", () => {
  const source = `const fetch = require("node-fetch");\nconst XLSX = require("xlsx");\nconst ExcelJS = require("exceljs");\nconst TokenService = require("./tokenService");\n\nclass X {\n  static parseWorkbookRows(buffer) {\n    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });\n    const sheetName =\n      workbook.SheetNames.find((name) => normalizePlain(name) === "caracteristicas") ||\n      workbook.SheetNames[0];\n    if (!sheetName) throw new Error("Arquivo Excel sem planilhas.");\n    const sheet = workbook.Sheets[sheetName];\n    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });\n    return rows;\n  }\n  static async validateWorkbookImport() {\n    const rawRows = this.parseWorkbookRows(options.buffer);\n  }\n}`;
  const result = patchCaracteristicas(source).content;
  assert.doesNotMatch(result, /require\("xlsx"\)/);
  assert.doesNotMatch(result, /XLSX\.read/);
  assert.match(result, /parseXlsxRows/);
  assert.match(result, /await this\.parseWorkbookRows/);
});

test("patch de promocoes adiciona limites ao multipart", () => {
  const result = patchPromocoes(
    `const upload = multer({ storage: multer.memoryStorage() });`,
  ).content;
  assert.match(result, /fileSize: 10 \* 1024 \* 1024/);
  assert.match(result, /fieldNestingDepth: 1/);
  assert.match(result, /fieldArrayIndexLimit: 100/);
});
