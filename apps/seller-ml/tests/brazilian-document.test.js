"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeBrazilianDocument, normalizeCompanyCnpj } = require("../../shared/brazilianDocument");

test("validates CPF and CNPJ check digits and normalizes punctuation", () => {
  assert.deepEqual(normalizeBrazilianDocument("529.982.247-25"), { type: "CPF", number: "52998224725" });
  assert.deepEqual(normalizeBrazilianDocument("11.222.333/0001-81"), { type: "CNPJ", number: "11222333000181" });
  for (const value of ["", "111.111.111-11", "529.982.247-26", "11.222.333/0001-82", "123", "00.000.000/E08G-13"])
    assert.throws(() => normalizeBrazilianDocument(value), /document_invalid/);
});

test("new company requires a CNPJ and never treats a CPF as its business document", () => {
  assert.deepEqual(normalizeCompanyCnpj("11.222.333/0001-81"), { type: "CNPJ", number: "11222333000181" });
  assert.deepEqual(normalizeCompanyCnpj("00.000.000/E08G-12"), { type: "CNPJ", number: "00000000E08G12" });
  assert.throws(() => normalizeCompanyCnpj("52998224725"), /cnpj_required/);
});
