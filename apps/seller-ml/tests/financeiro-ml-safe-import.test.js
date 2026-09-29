"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

test("importacao de custos usa o parser XLSX seguro compartilhado", async () => {
  const originalLoad = Module._load;
  const originalDatabaseUrl = process.env.ML_DATABASE_URL;
  const parserCalls = [];

  process.env.ML_DATABASE_URL = "postgres://user:password@127.0.0.1:5432/ml";
  Module._load = function load(request, parent, isMain) {
    if (request === "./safeWorkbookParser") {
      return {
        parseXlsxRows: async (buffer, options) => {
          parserCalls.push({ buffer, options });
          return [{ SKU: "ABC", CUSTO: "12.50" }];
        },
      };
    }
    if (request === "xlsx") {
      return {
        read() {
          throw new Error("SheetJS nao deve ler upload financeiro");
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve("../services/financeiroMlService")];
    const FinanceiroMlService = require("../services/financeiroMlService");
    const rows = await FinanceiroMlService._test.parseImportRows({
      filename: "custos.xlsx",
      content_base64: Buffer.from("xlsx-content").toString("base64"),
    });

    assert.deepEqual(rows, [{ SKU: "ABC", CUSTO: "12.50" }]);
    assert.equal(parserCalls.length, 1);
    assert.deepEqual(parserCalls[0].options, { preferredSheet: "Custos" });
  } finally {
    Module._load = originalLoad;
    if (originalDatabaseUrl === undefined) delete process.env.ML_DATABASE_URL;
    else process.env.ML_DATABASE_URL = originalDatabaseUrl;
    delete require.cache[require.resolve("../services/financeiroMlService")];
  }
});
