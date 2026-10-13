"use strict";

function resolveTaxRate({ globalRate, legacyRate } = {}) {
  const global = Number(globalRate);
  if (Number.isFinite(global) && global > 0) return global;
  const legacy = Number(legacyRate);
  return Number.isFinite(legacy) && legacy >= 0 ? legacy : 0;
}

function validateGlobalTax(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    const error = new Error("Alíquota global obrigatória."); error.status = 422; throw error;
  }
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    const error = new Error("Alíquota global deve estar entre 0 e 100%."); error.status = 422; throw error;
  }
  return rate;
}

module.exports = { resolveTaxRate, validateGlobalTax };
