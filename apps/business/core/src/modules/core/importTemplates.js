const ExcelJS = require("exceljs");

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

function createWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Volt Core";
  workbook.created = new Date();
  return workbook;
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

async function buildProductImportTemplateBuffer(categories = []) {
  const workbook = createWorkbook();
  addInstructions(workbook, "products");
  const categoryList = categories.length ? categories : ["Produtos", "Servicos"];
  addImportSheet(workbook, PRODUCT_IMPORT_COLUMNS.map((column) => ({ ...column, width: column.key === "nome" ? 30 : 18 })), [
    { column: "D", formula: "Opcoes!$B$2:$B$3" },
    { column: "E", formula: `Opcoes!$A$2:$A$${categoryList.length + 1}` },
    { column: "K", formula: "Opcoes!$D$2:$D$3" },
  ]);
  addOptions(workbook, {
    categories: categoryList,
    types: ["Produto", "Servico"],
    statuses: ["Ativo", "Inativo"],
  });
  return workbook.xlsx.writeBuffer();
}

async function buildCustomerImportTemplateBuffer() {
  const workbook = createWorkbook();
  addInstructions(workbook, "customers");
  addImportSheet(workbook, CUSTOMER_IMPORT_COLUMNS.map((column) => ({ ...column, width: column.key === "nome" || column.key === "email" ? 30 : 18 })), [
    { column: "E", formula: "Opcoes!$E$2:$E$5" },
    { column: "G", formula: "Opcoes!$D$2:$D$3" },
  ]);
  addOptions(workbook, {
    statuses: ["Ativo", "Inativo"],
    segments: ["Consumidor", "Empresa", "Revenda", "Outro"],
  });
  return workbook.xlsx.writeBuffer();
}

module.exports = {
  buildCustomerImportTemplateBuffer,
  buildProductImportTemplateBuffer,
};
