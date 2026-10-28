"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCompany } = require("./runtime/services/platformService");

test("Business Core rejects a new company without a valid CNPJ before calling Hub", async () => {
  for (const document of ["", "52998224725", "11222333000180"]) {
    await assert.rejects(() => createCompany({ name: "Empresa Teste", document }), {
      code: "COMPANY_CNPJ_REQUIRED",
      statusCode: 400,
    });
  }
});

test("Business Core accepts a Receita alphanumeric CNPJ before Hub provisioning", async () => {
  await assert.rejects(() => createCompany({ name: "Banco do Brasil", document: "00.000.000/E08G-12" }),
    (error) => error.code !== "COMPANY_CNPJ_REQUIRED");
});
