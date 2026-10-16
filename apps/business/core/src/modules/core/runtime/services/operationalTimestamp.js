"use strict";

function resolveOperationalTimestamp(value, now = new Date().toISOString()) {
  const reference = new Date(now);
  const text = value == null ? "" : String(value).trim();
  if (text && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    throw Object.assign(new Error("Informe uma data/hora valida com fuso horario"), { statusCode: 400, code: "OPERATIONAL_DATE_INVALID" });
  }
  const resolved = text ? new Date(text) : reference;
  if (Number.isNaN(resolved.getTime())) {
    throw Object.assign(new Error("Informe uma data/hora valida"), { statusCode: 400, code: "OPERATIONAL_DATE_INVALID" });
  }
  if (resolved.getTime() > reference.getTime()) {
    throw Object.assign(new Error("A data/hora nao pode ser futura"), { statusCode: 400, code: "OPERATIONAL_DATE_IN_FUTURE" });
  }
  return resolved.toISOString();
}

module.exports = { resolveOperationalTimestamp };
