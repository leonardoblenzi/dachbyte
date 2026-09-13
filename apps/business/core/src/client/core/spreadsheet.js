import { apiUrl } from "./api";

const PRODUCT_IMPORT_COLUMNS = [
  { key: "nome", label: "nome", required: true },
  { key: "sku", label: "sku" },
  { key: "ean", label: "ean" },
  { key: "tipo", label: "tipo", required: true },
  { key: "categoria", label: "categoria", required: true },
  { key: "marca", label: "marca" },
  { key: "estoque", label: "estoque" },
  { key: "estoque_minimo", label: "estoque_minimo" },
  { key: "custo", label: "custo" },
  { key: "preco", label: "preco", required: true },
  { key: "status", label: "status" },
];

const CUSTOMER_IMPORT_COLUMNS = [
  { key: "nome", label: "nome", required: true },
  { key: "documento", label: "documento" },
  { key: "telefone", label: "telefone", required: true },
  { key: "email", label: "email" },
  { key: "segmento", label: "segmento" },
  { key: "observacoes", label: "observacoes" },
  { key: "status", label: "status" },
  { key: "limite_credito", label: "limite_credito" },
];

const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D4ED8" } };
const optionalFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF6FF" } };
const requiredFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7ED" } };
const requiredFont = { bold: true, color: { argb: "FFFFFFFF" } };
const optionalFont = { bold: true, color: { argb: "FF1D4ED8" } };

async function createWorkbook() {
  const { default: ExcelJS } = await import("exceljs");
  return new ExcelJS.Workbook();
}

function normalizeText(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function normalizeHeader(value) {
  return normalizeText(value).replace(/\s+/g, "_");
}

function moneyNumber(value) {
  if (typeof value === "number") return value;
  const text = String(value || "").replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  return Number(text || 0);
}

function downloadBuffer(filename, buffer) {
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  downloadBlob(filename, blob);
}

function downloadBlob(filename, blob) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

async function downloadTemplateFromApi(entity, filename, categories = []) {
  const search = new URLSearchParams();
  categories.forEach((category) => search.append("category", category));
  const suffix = search.toString() ? `?${search.toString()}` : "";
  const response = await fetch(apiUrl(`/core/import-templates/${entity}.xlsx${suffix}`), {
    credentials: "include",
  });
  if (!response.ok) throw new Error(`Falha HTTP ${response.status}`);
  downloadBlob(filename, await response.blob());
}

function addInstructions(workbook, entity) {
  const sheet = workbook.addWorksheet("Instrucoes", { views: [{ state: "frozen", ySplit: 1 }] });
  const noun = entity === "products" ? "produtos" : "clientes";
  sheet.columns = [{ width: 110 }];
  [
    `Importacao de ${noun} - Volt Core`,
    "Como usar",
    "1. Preencha somente a aba Importacao.",
    "2. Campos obrigatorios estao destacados no cabecalho azul e nas celulas em laranja claro.",
    "3. Use as listas suspensas para categoria, tipo, classificacao e status.",
    "4. Salve o arquivo e envie pelo menu Mais opcoes > Importar.",
    "5. Se houver erro, baixe a planilha com erros, corrija e envie novamente.",
  ].forEach((text, index) => {
    const row = sheet.addRow([text]);
    if (index === 0) {
      row.font = { bold: true, size: 16, color: { argb: "FF0F172A" } };
      row.height = 26;
    }
    if (index === 1) row.font = { bold: true, color: { argb: "FF1D4ED8" } };
  });
}

function addOptions(workbook, options) {
  const sheet = workbook.addWorksheet("Opcoes");
  sheet.columns = [
    { header: "categorias", key: "categorias", width: 26 },
    { header: "tipos", key: "tipos", width: 18 },
    { header: "classificacoes", key: "classificacoes", width: 24 },
    { header: "status", key: "status", width: 16 },
    { header: "segmentos", key: "segmentos", width: 22 },
  ];
  sheet.getRow(1).eachCell((cell) => {
    cell.fill = optionalFill;
    cell.font = optionalFont;
  });
  const columns = [options.categories || [], options.types || [], options.classifications || [], options.statuses || [], options.segments || []];
  const max = Math.max(...columns.map((items) => items.length), 1);
  for (let index = 0; index < max; index += 1) {
    sheet.addRow(columns.map((items) => items[index] || ""));
  }
}

function addImportSheet(workbook, columns, validations = []) {
  const sheet = workbook.addWorksheet("Importacao", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns.map((column) => ({ header: column.label, key: column.key, width: column.width || 18 }));
  sheet.getRow(1).eachCell((cell, index) => {
    const column = columns[index - 1];
    cell.fill = column.required ? headerFill : optionalFill;
    cell.font = column.required ? requiredFont : optionalFont;
  });
  for (let rowIndex = 2; rowIndex <= 101; rowIndex += 1) {
    columns.forEach((column, columnIndex) => {
      const cell = sheet.getCell(rowIndex, columnIndex + 1);
      if (column.required) {
        cell.value = column.key === "nome" ? "Preencha" : "Selecione";
        cell.fill = requiredFill;
      }
    });
  }
  validations.forEach(({ column, formula }) => {
    for (let rowIndex = 2; rowIndex <= 501; rowIndex += 1) {
      sheet.getCell(`${column}${rowIndex}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [formula],
        showErrorMessage: true,
        errorTitle: "Valor invalido",
        error: "Selecione uma opcao valida da lista.",
      };
    }
  });
}

async function writeWorkbook(workbook, filename) {
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBuffer(filename, buffer);
}

async function downloadProductTemplateXlsx(categories = [], extensionSchema = {}) {
  const extensionColumns = Array.isArray(extensionSchema?.columns) ? extensionSchema.columns : [];
  if (!extensionColumns.length) {
    try {
      await downloadTemplateFromApi("products", "modelo-produtos-volt-core.xlsx", categories);
      return;
    } catch (error) {
      console.warn("Falha ao baixar modelo pelo servidor, usando geracao local.", error);
    }
  }
  const workbook = await createWorkbook();
  workbook.creator = "Volt Core";
  addInstructions(workbook, "products");
  const categoryList = categories.length ? categories : ["Produtos", "Servicos"];
  const columns = [...PRODUCT_IMPORT_COLUMNS, ...extensionColumns].map((column) => ({ ...column, width: column.key === "nome" ? 30 : 18 }));
  const columnLetter = (key) => {
    const index = columns.findIndex((column) => column.key === key);
    if (index < 0 || index >= 26) return null;
    return String.fromCharCode(65 + index);
  };
  const validations = [
    { key: "tipo", formula: "Opcoes!$B$2:$B$3" },
    { key: "categoria", formula: `Opcoes!$A$2:$A$${categoryList.length + 1}` },
    { key: "status", formula: "Opcoes!$D$2:$D$3" },
  ];
  if (extensionColumns.length && (extensionSchema.classifications || []).length) {
    validations.push({ key: extensionColumns[0].key, formula: `Opcoes!$C$2:$C$${extensionSchema.classifications.length + 1}` });
  }
  addImportSheet(workbook, columns, validations.map((validation) => ({ column: columnLetter(validation.key), formula: validation.formula })).filter((item) => item.column));
  addOptions(workbook, {
    categories: categoryList,
    types: ["Produto", "Servico"],
    classifications: extensionSchema.classifications || [],
    statuses: ["Ativo", "Inativo"],
  });
  await writeWorkbook(workbook, "modelo-produtos-volt-core.xlsx");
}

async function downloadCustomerTemplateXlsx() {
  try {
    await downloadTemplateFromApi("customers", "modelo-clientes-volt-core.xlsx");
    return;
  } catch (error) {
    console.warn("Falha ao baixar modelo pelo servidor, usando geracao local.", error);
  }
  const workbook = await createWorkbook();
  workbook.creator = "Volt Core";
  addInstructions(workbook, "customers");
  addImportSheet(workbook, CUSTOMER_IMPORT_COLUMNS.map((column) => ({ ...column, width: column.key === "nome" || column.key === "email" ? 30 : 18 })), [
    { column: "E", formula: "Opcoes!$E$2:$E$5" },
    { column: "G", formula: "Opcoes!$D$2:$D$3" },
  ]);
  addOptions(workbook, {
    statuses: ["Ativo", "Inativo"],
    segments: ["Otica", "Varejo", "Servico", "Distribuidora"],
  });
  await writeWorkbook(workbook, "modelo-clientes-volt-core.xlsx");
}

async function downloadRowsXlsx(filename, rows, columns, sheetName = "Exportacao") {
  const workbook = await createWorkbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = columns.map((column) => ({ header: column.label, key: column.key, width: 22 }));
  sheet.getRow(1).eachCell((cell) => {
    cell.fill = optionalFill;
    cell.font = optionalFont;
  });
  rows.forEach((row) => sheet.addRow(columns.reduce((record, column) => ({ ...record, [column.key]: row[column.key] || "" }), {})));
  await writeWorkbook(workbook, filename);
}

async function readImportSheetRows(file) {
  const workbook = await createWorkbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.getWorksheet("Importacao");
  if (!sheet) throw new Error("Aba Importacao nao encontrada.");
  const headers = [];
  sheet.getRow(1).eachCell((cell, index) => {
    headers[index] = normalizeHeader(cell.value);
  });
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record = {};
    headers.forEach((header, index) => {
      if (!header) return;
      const value = row.getCell(index).value;
      record[header] = typeof value === "object" && value?.text ? value.text : value ?? "";
    });
    if (!isPlaceholderRow(record)) rows.push(record);
  });
  return rows;
}

function isPlaceholderRow(row) {
  return Object.values(row).every((value) => {
    const text = normalizeText(value);
    return !text || text === "selecione" || text === "preencha";
  });
}

function rowsToCsv(rows, columns) {
  const quote = (value) => {
    const text = String(value ?? "");
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.map((column) => quote(column.label)).join(","), ...rows.map((row) => columns.map((column) => quote(row[column.key])).join(","))].join("\n");
}

async function downloadErrorRowsXlsx(filename, rows, columns) {
  const workbook = await createWorkbook();
  const sheet = workbook.addWorksheet("Erros");
  const errorColumns = [...columns, { key: "erro_identificado", label: "erro_identificado" }];
  sheet.columns = errorColumns.map((column) => ({ header: column.label, key: column.key, width: column.key === "erro_identificado" ? 46 : 20 }));
  sheet.getRow(1).eachCell((cell, index) => {
    cell.fill = index === errorColumns.length ? requiredFill : optionalFill;
    cell.font = optionalFont;
  });
  rows.forEach((row) => sheet.addRow(errorColumns.reduce((record, column) => ({ ...record, [column.key]: row[column.key] || "" }), {})));
  await writeWorkbook(workbook, filename);
}

function productImportColumns(extensionSchema = {}) {
  return [...PRODUCT_IMPORT_COLUMNS, ...(extensionSchema?.columns || [])];
}

function customerImportColumns() {
  return CUSTOMER_IMPORT_COLUMNS;
}

function parseMoneyForImport(value) {
  return moneyNumber(value);
}

export {
  customerImportColumns,
  downloadCustomerTemplateXlsx,
  downloadErrorRowsXlsx,
  downloadProductTemplateXlsx,
  downloadRowsXlsx,
  parseMoneyForImport,
  productImportColumns,
  readImportSheetRows,
  rowsToCsv,
};
