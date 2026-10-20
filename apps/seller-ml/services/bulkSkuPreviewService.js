"use strict";

function targetKey(mlb, variationId) {
  return `${String(mlb || "").trim().toUpperCase()}:${String(variationId || "").trim()}`;
}

function variationName(attributeCombinations) {
  return (Array.isArray(attributeCombinations) ? attributeCombinations : [])
    .map((attribute) => String(attribute?.value_name || attribute?.value_id || "").trim())
    .filter(Boolean).join(" / ") || "Produto único";
}

function gtinValues(attributes) {
  const ids = new Set(["GTIN", "EAN", "UPC", "JAN", "ISBN", "GTIN14"]);
  return (Array.isArray(attributes) ? attributes : [])
    .filter((attribute) => ids.has(String(attribute?.id || "").toUpperCase()))
    .flatMap((attribute) => String(attribute?.value_name || attribute?.value_id || "").split(","))
    .map((value) => value.trim()).filter(Boolean);
}

function sellerSku(attributes, legacy = "") {
  const attribute = (Array.isArray(attributes) ? attributes : []).find((row) => String(row?.id || "").toUpperCase() === "SELLER_SKU");
  return String(attribute?.value_name || attribute?.value_id || legacy || "").trim();
}

function classifyRows(importedRows, liveByKey, activeAccount, options = {}) {
  const seen = options.seen || new Set();
  return importedRows.map((row, index) => {
    const key = targetKey(row.mlb, row.id_variacao);
    const live = liveByKey.get(key);
    const output = { ...row, row_number: row.row_number || index + 2, key, state: "ready", message: "", warning: "" };
    if (!/^MLB\d{6,}$/.test(String(row.mlb || "").toUpperCase()) || !String(row.sku_novo || "").trim() || String(row.sku_novo).length > 255) {
      output.state = "invalid"; output.message = "MLB ou SKU novo invalido.";
    } else if (seen.has(key)) {
      output.state = "invalid"; output.message = "Alvo duplicado na planilha.";
    } else if (String(row.conta || "").trim() !== String(activeAccount || "").trim()) {
      output.state = "divergent"; output.message = "A linha pertence a outra conta.";
    } else if (!live) {
      output.state = "missing"; output.message = "Anuncio ou variacao nao encontrado.";
    } else if (String(live.sku || "") !== String(row.sku_atual || "")) {
      output.state = "divergent"; output.message = "O SKU atual mudou no ML.";
    } else if (String(row.sku_novo).trim() === String(live.sku || "")) {
      output.state = "unchanged"; output.message = "SKU novo igual ao atual.";
    }
    if (live && String(row.ean_gtin_atual || "") !== String(live.ean || "")) output.warning = "EAN/GTIN mudou no ML";
    seen.add(key);
    return output;
  });
}

module.exports = { targetKey, variationName, gtinValues, sellerSku, classifyRows };
