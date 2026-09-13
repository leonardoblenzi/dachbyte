"use strict";

const DEFAULT_BRAND_DISPLAY_NAME = "Sem marca";
const SHOPEE_NO_BRAND_NAME = "No Brand";

function normalizeToken(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function isNoBrandValue(value) {
  return ["", "sem marca", "no brand"].includes(normalizeToken(value));
}

function resolveBrandDisplayName(value) {
  const brandName = String(value || "").trim();
  return brandName || DEFAULT_BRAND_DISPLAY_NAME;
}

function buildShopeeBrand({ brandId, brandName }) {
  const parsedBrandId = Number.parseInt(String(brandId || ""), 10);
  const normalizedName = String(brandName || "").trim();

  if (Number.isInteger(parsedBrandId) && parsedBrandId > 0) {
    return {
      brand_id: parsedBrandId,
      ...(normalizedName ? { original_brand_name: normalizedName } : {}),
    };
  }

  return {
    brand_id: 0,
    original_brand_name: isNoBrandValue(normalizedName)
      ? SHOPEE_NO_BRAND_NAME
      : normalizedName,
  };
}

module.exports = {
  DEFAULT_BRAND_DISPLAY_NAME,
  SHOPEE_NO_BRAND_NAME,
  buildShopeeBrand,
  isNoBrandValue,
  resolveBrandDisplayName,
};
