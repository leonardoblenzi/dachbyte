// @ts-check
"use strict";

/**
 * Chave de SKU para casar anúncios entre canais.
 * Mesma regra do SKU Tracker (skuleader.sku_links): sem acento, minúsculo,
 * só letras e números separados por hífen.
 * @param {unknown} value
 * @returns {string | null}
 */
function skuKey(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  const key = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || null;
}

/**
 * EAN/GTIN válido (8 a 14 dígitos), ou null.
 * @param {unknown} value
 * @returns {string | null}
 */
function eanKey(value) {
  const digits = String(value == null ? "" : value).replace(/\D+/g, "");
  if (digits.length < 8 || digits.length > 14) return null;
  if (/^0+$/.test(digits)) return null;
  return digits;
}

const STOPWORDS = new Set(["de", "da", "do", "das", "dos", "e", "com", "para", "em", "a", "o", "kit", "cm", "un"]);

/**
 * Palavras relevantes de um título, para sugerir vínculo por semelhança.
 * @param {unknown} title
 * @returns {Set<string>}
 */
function titleTokens(title) {
  const words = String(title == null ? "" : title)
    .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word));
  return new Set(words);
}

/**
 * Semelhança de Jaccard entre dois títulos (0 a 1).
 * @param {unknown} a @param {unknown} b
 */
function titleSimilarity(a, b) {
  const ta = titleTokens(a), tb = titleTokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const word of ta) if (tb.has(word)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

module.exports = { skuKey, eanKey, titleTokens, titleSimilarity };
