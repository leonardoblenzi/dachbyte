"use strict";

const fs = require("fs");
const path = require("path");

function replaceOnce(source, before, after, label) {
  // O repositório pode estar em CRLF no Windows. Preserve o estilo do arquivo
  // ao comparar e ao inserir, para que as âncoras auditadas em LF não falhem.
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const withSourceNewlines = (value) =>
    newline === "\r\n" ? value.replace(/\n/g, "\r\n") : value;
  before = withSourceNewlines(before);
  after = withSourceNewlines(after);

  if (source.includes(after)) return { content: source, changed: false, already: true };
  const first = source.indexOf(before);
  if (first < 0) {
    throw new Error(`Etapa 5: ancora nao encontrada para ${label}. Arquivo pode ter divergido da versao auditada.`);
  }
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Etapa 5: ancora duplicada para ${label}; alteracao abortada por seguranca.`);
  }
  return {
    content: source.slice(0, first) + after + source.slice(first + before.length),
    changed: true,
    already: false,
  };
}

function patchApp(source) {
  const oldBody = `  app.use(express.json({ limit: "10mb" }));\n  app.use(express.urlencoded({ extended: true }));`;
  const newBody = `  // Etapa 5: limite global menor. Rotas que declaram payloads grandes\n  // deixam o parser global passar e aplicam o limite especifico no proprio router.\n  const DEFAULT_JSON_BODY_LIMIT =\n    String(process.env.ML_JSON_BODY_LIMIT || "1mb").trim() || "1mb";\n  const DEFAULT_URLENCODED_BODY_LIMIT =\n    String(process.env.ML_URLENCODED_BODY_LIMIT || "128kb").trim() || "128kb";\n\n  const defaultJsonParser = express.json({ limit: DEFAULT_JSON_BODY_LIMIT });\n  const defaultUrlencodedParser = express.urlencoded({\n    extended: true,\n    limit: DEFAULT_URLENCODED_BODY_LIMIT,\n    parameterLimit: 1000,\n  });\n\n  function routeHasOwnLargeBodyParser(req) {\n    const p = String(req.path || req.url || "").split("?")[0];\n    return (\n      p === "/api/admin/backup/import.json" ||\n      p === "/api/caracteristicas/preview" ||\n      p === "/api/caracteristicas/aplicar" ||\n      p === "/api/caracteristicas/aplicar-excel" ||\n      p === "/api/extension" ||\n      p.startsWith("/api/extension/")\n    );\n  }\n\n  app.use((req, res, next) =>\n    routeHasOwnLargeBodyParser(req) ? next() : defaultJsonParser(req, res, next),\n  );\n  app.use((req, res, next) =>\n    routeHasOwnLargeBodyParser(req)\n      ? next()\n      : defaultUrlencodedParser(req, res, next),\n  );`;

  let result = replaceOnce(source, oldBody, newBody, "app.js/body-parser");

  const oldError = `    res.status(500).json({\n      success: false,\n      error: "Erro interno do servidor",\n      message: error.message,\n      timestamp: new Date().toISOString(),\n      path: req.originalUrl,\n    });`;
  const newError = `    res.status(500).json({\n      success: false,\n      error: "Erro interno do servidor",\n      ...(String(process.env.NODE_ENV || "").toLowerCase() !== "production"\n        ? { message: error?.message || String(error) }\n        : {}),\n      timestamp: new Date().toISOString(),\n      path: req.originalUrl,\n    });`;

  const result2 = replaceOnce(result.content, oldError, newError, "app.js/error-handler");
  return {
    content: result2.content,
    changed: result.changed || result2.changed,
    already: result.already && result2.already,
  };
}

function patchCaracteristicas(source) {
  const oldImport = `const fetch = require("node-fetch");\nconst XLSX = require("xlsx");\nconst ExcelJS = require("exceljs");\nconst TokenService = require("./tokenService");`;
  const newImport = `const fetch = require("node-fetch");\nconst ExcelJS = require("exceljs");\nconst TokenService = require("./tokenService");\nconst { parseXlsxRows } = require("./safeWorkbookParser");`;

  let result = replaceOnce(
    source,
    oldImport,
    newImport,
    "caracteristicasService/import-xlsx",
  );

  const oldParser = `  static parseWorkbookRows(buffer) {\n    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });\n    const sheetName =\n      workbook.SheetNames.find((name) => normalizePlain(name) === "caracteristicas") ||\n      workbook.SheetNames[0];\n    if (!sheetName) throw new Error("Arquivo Excel sem planilhas.");\n    const sheet = workbook.Sheets[sheetName];\n    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });\n    return rows;\n  }`;
  const newParser = `  static async parseWorkbookRows(buffer) {\n    return parseXlsxRows(buffer, {\n      preferredSheet: "Caracteristicas",\n    });\n  }`;

  result = replaceOnce(
    result.content,
    oldParser,
    newParser,
    "caracteristicasService/parser-exceljs",
  );

  const oldCall = `    const rawRows = this.parseWorkbookRows(options.buffer);`;
  const newCall = `    const rawRows = await this.parseWorkbookRows(options.buffer);`;
  const result3 = replaceOnce(
    result.content,
    oldCall,
    newCall,
    "caracteristicasService/await-parser",
  );

  return {
    content: result3.content,
    changed: result.changed || result3.changed,
    already: result.already && result3.already,
  };
}

function patchPromocoes(source) {
  const oldUpload = `const upload = multer({ storage: multer.memoryStorage() });`;
  const newUpload = `const upload = multer({\n  storage: multer.memoryStorage(),\n  limits: {\n    fileSize: 10 * 1024 * 1024,\n    files: 1,\n    fields: 8,\n    parts: 10,\n    fieldNameSize: 100,\n    fieldSize: 512 * 1024,\n    fieldNestingDepth: 1,\n    fieldArrayIndexLimit: 100,\n  },\n});`;
  return replaceOnce(source, oldUpload, newUpload, "promocoesRoutes/multer-limits");
}

function resolveRepoRoot() {
  return path.resolve(__dirname, "..", "..", "..");
}

function main() {
  const root = resolveRepoRoot();
  const targets = [
    {
      rel: "apps/seller-ml/app.js",
      patch: patchApp,
    },
    {
      rel: "apps/seller-ml/services/caracteristicasService.js",
      patch: patchCaracteristicas,
    },
    {
      rel: "apps/seller-ml/routes/promocoesRoutes.js",
      patch: patchPromocoes,
    },
  ];

  const planned = targets.map((target) => {
    const file = path.join(root, target.rel);
    if (!fs.existsSync(file)) {
      throw new Error(`Etapa 5: arquivo nao encontrado: ${target.rel}`);
    }
    const source = fs.readFileSync(file, "utf8");
    return { ...target, file, ...target.patch(source) };
  });

  for (const item of planned) {
    if (!item.changed) {
      console.log(`[Etapa 5] ja aplicado: ${item.rel}`);
      continue;
    }
    fs.writeFileSync(item.file, item.content, "utf8");
    console.log(`[Etapa 5] atualizado: ${item.rel}`);
  }

  console.log("[Etapa 5] patches de codigo aplicados com sucesso.");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || error);
    process.exit(1);
  }
}

module.exports = {
  main,
  patchApp,
  patchCaracteristicas,
  patchPromocoes,
  replaceOnce,
};
