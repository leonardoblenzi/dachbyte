"use strict";

function successfulBodies(payload) {
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((entry) => {
      if (!entry?.body?.id) return false;
      const code = entry.code ?? entry.status_code;
      return code == null || Number(code) === 200;
    })
    .map((entry) => entry.body);
}

function assertCompleteDetails(requestedIds, details) {
  const expected = new Set((requestedIds || []).map((id) => String(id || "").trim().toUpperCase()).filter(Boolean));
  const received = new Set((details || []).map((item) => String(typeof item === "string" ? item : item?.id || "").trim().toUpperCase()).filter(Boolean));
  const missingCount = [...expected].filter((id) => !received.has(id)).length;
  const unexpectedCount = [...received].filter((id) => !expected.has(id)).length;
  if (missingCount || unexpectedCount) {
    throw new Error(`O Mercado Livre nao retornou ${missingCount} de ${expected.size} detalhes dos anuncios encontrados; ${unexpectedCount} detalhes inesperados.`);
  }
}

module.exports = { successfulBodies, assertCompleteDetails };
