"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

function cell(value) {
  return {
    value,
    get text() {
      return value == null ? "" : String(value);
    },
  };
}

function fakeSheet(name, matrix) {
  return {
    name,
    actualRowCount: matrix.length,
    rowCount: matrix.length,
    actualColumnCount: Math.max(...matrix.map((row) => row.length)),
    columnCount: Math.max(...matrix.map((row) => row.length)),
    getRow(rowNumber) {
      const values = matrix[rowNumber - 1] || [];
      return {
        getCell(columnNumber) {
          return cell(values[columnNumber - 1]);
        },
      };
    },
  };
}

test("parser seguro escolhe aba Caracteristicas e converte linhas", async () => {
  const originalLoad = Module._load;
  class FakeWorkbook {
    constructor() {
      this.worksheets = [];
      this.xlsx = {
        load: async () => {
          this.worksheets = [
            fakeSheet("Instrucoes", [["A"], ["ignorar"]]),
            fakeSheet("Caracteristicas", [
              ["MLB", "SKU", "Cor [COLOR]"],
              ["MLB123456", "ABC", "Preto"],
              ["MLB654321", "DEF", "Branco"],
            ]),
          ];
        },
      };
    }
  }

  Module._load = function patched(request, parent, isMain) {
    if (request === "exceljs") return { Workbook: FakeWorkbook };
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve("../services/safeWorkbookParser")];
    const { parseXlsxRows } = require("../services/safeWorkbookParser");
    const rows = await parseXlsxRows(Buffer.from("fake"));
    assert.deepEqual(rows, [
      { MLB: "MLB123456", SKU: "ABC", "Cor [COLOR]": "Preto" },
      { MLB: "MLB654321", SKU: "DEF", "Cor [COLOR]": "Branco" },
    ]);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve("../services/safeWorkbookParser")];
  }
});

test("parser seguro rejeita excesso de linhas", async () => {
  const originalLoad = Module._load;
  class FakeWorkbook {
    constructor() {
      this.worksheets = [];
      this.xlsx = {
        load: async () => {
          this.worksheets = [fakeSheet("Caracteristicas", [["MLB"], ["1"], ["2"]])];
        },
      };
    }
  }
  Module._load = function patched(request, parent, isMain) {
    if (request === "exceljs") return { Workbook: FakeWorkbook };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../services/safeWorkbookParser")];
    const { parseXlsxRows } = require("../services/safeWorkbookParser");
    await assert.rejects(
      () => parseXlsxRows(Buffer.from("fake"), { maxRows: 1 }),
      /limite de 1 linhas/,
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve("../services/safeWorkbookParser")];
  }
});
