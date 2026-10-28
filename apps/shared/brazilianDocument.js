"use strict";

function taxDocument(value) { return String(value || "").trim().toUpperCase().replace(/[.\-/\s]/g, ""); }

function checkDigit(base, weights) {
  const sum = weights.reduce((total, weight, index) => total + Number(base[index]) * weight, 0);
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

function validCpf(value) {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  const first = checkDigit(value, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = checkDigit(value, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === Number(value[9]) && second === Number(value[10]);
}

function validCnpj(value) {
  const number = taxDocument(value);
  if (!/^[A-Z0-9]{12}\d{2}$/.test(number) || /^(\d)\1{13}$/.test(number)) return false;
  const calculate = (weights) => {
    const sum = weights.reduce((total, weight, index) => total + (number.charCodeAt(index) - 48) * weight, 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  const first = calculate([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = calculate([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === Number(number[12]) && second === Number(number[13]);
}

function normalizeBrazilianDocument(value) {
  const number = taxDocument(value);
  if (validCpf(number)) return { type: "CPF", number };
  if (validCnpj(number)) return { type: "CNPJ", number };
  throw new Error("document_invalid");
}

function normalizeCompanyCnpj(value) {
  const document = normalizeBrazilianDocument(value);
  if (document.type !== "CNPJ") throw new Error("cnpj_required");
  return document;
}

module.exports = { normalizeBrazilianDocument, normalizeCompanyCnpj, validCpf, validCnpj };
