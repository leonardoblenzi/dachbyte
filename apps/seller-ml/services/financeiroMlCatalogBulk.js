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

function assertDetailsAvailable(discoveredCount, detailsCount) {
  if (Number(discoveredCount) > 0 && Number(detailsCount) === 0) {
    throw new Error("O Mercado Livre nao retornou nenhum detalhe valido dos anuncios encontrados.");
  }
}

module.exports = { successfulBodies, assertDetailsAvailable };
