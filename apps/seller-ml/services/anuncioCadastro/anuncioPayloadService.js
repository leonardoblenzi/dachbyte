"use strict";

const { httpError, normalizeText } = require("./helpers");

function numberOrNull(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function conditionAttribute(condition) {
  const normalized = normalizeText(condition || "new", 60).toLowerCase();
  const known = {
    new: { value_id: "2230284", value_name: "Novo" },
    used: { value_id: "2230581", value_name: "Usado" },
    refurbished: { value_id: "2230582", value_name: "Recondicionado" },
    not_specified: { value_name: "Não especificado" },
  };
  const value = known[normalized] || { value_name: normalizeText(condition, 120) };
  return { id: "ITEM_CONDITION", ...value };
}

function compactAttributes(rows = [], { sku, gtin, condition } = {}) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = normalizeText(row?.id, 100).toUpperCase();
    const name = normalizeText(row?.name, 160);
    if (!id && !name) continue;
    const valueId = row?.value_id != null ? String(row.value_id).trim() : "";
    const valueName = row?.value_name != null ? String(row.value_name).trim() : "";
    if (!valueId && !valueName) continue;
    const key = id || `NAME:${name.toLowerCase()}`;
    map.set(key, {
      ...(id ? { id } : { name }),
      ...(valueId ? { value_id: valueId } : {}),
      ...(valueName ? { value_name: valueName } : {}),
    });
  }

  const safeSku = normalizeText(sku, 120);
  const safeGtin = normalizeText(gtin, 120);
  if (safeSku) map.set("SELLER_SKU", { id: "SELLER_SKU", value_name: safeSku });
  else map.delete("SELLER_SKU");
  if (safeGtin) map.set("GTIN", { id: "GTIN", value_name: safeGtin });
  else map.delete("GTIN");

  // Novas implementações devem enviar a condição como atributo ITEM_CONDITION.
  // O valor do seletor do rascunho prevalece sobre eventual atributo herdado.
  map.set("ITEM_CONDITION", conditionAttribute(condition));
  return [...map.values()];
}

function compactSaleTerms(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const id = normalizeText(row?.id, 100).toUpperCase();
    if (!id) return null;
    const valueId = row?.value_id != null ? String(row.value_id).trim() : "";
    const valueName = row?.value_name != null ? String(row.value_name).trim() : "";
    if (!valueId && !valueName) return null;
    return {
      id,
      ...(valueId ? { value_id: valueId } : {}),
      ...(valueName ? { value_name: valueName } : {}),
    };
  }).filter(Boolean);
}

function compactPictures(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (typeof row === "string") {
      const source = normalizeText(row, 2000);
      return source ? { source } : null;
    }
    const id = normalizeText(row?.id, 200);
    const source = normalizeText(row?.source || row?.secure_url || row?.url, 2000);
    if (row?.uploaded && id) return { id };
    if (source) return { source };
    if (id) return { id };
    return null;
  }).filter(Boolean);
}

function compactShipping(shipping = {}) {
  const out = {};
  if (shipping && Object.prototype.hasOwnProperty.call(shipping, "free_shipping")) out.free_shipping = Boolean(shipping.free_shipping);
  if (shipping && Object.prototype.hasOwnProperty.call(shipping, "local_pick_up")) out.local_pick_up = Boolean(shipping.local_pick_up);
  const mode = normalizeText(shipping?.mode, 40);
  if (mode) out.mode = mode;
  return out;
}

function localValidation(draft, { target = "new_item" } = {}) {
  const data = draft?.draft_data || {};
  const errors = [];
  const publicationModel = draft?.publication_model === "user_products" ? "user_products" : "legacy";
  const categoryId = normalizeText(data.category_id || draft?.category_id, 80).toUpperCase();
  const price = numberOrNull(data.price);
  const qty = numberOrNull(data.available_quantity);
  const saleCondition = target === "sale_condition";

  if (!categoryId) errors.push({ field: "category_id", message: "Selecione a categoria do anúncio." });
  if (!saleCondition) {
    if (publicationModel === "user_products") {
      if (!normalizeText(data.family_name || draft?.family_name, 180)) errors.push({ field: "family_name", message: "Informe o nome da família." });
    } else if (!normalizeText(data.title || draft?.title, 180)) {
      errors.push({ field: "title", message: "Informe o título do anúncio." });
    }
  }
  if (!(price > 0)) errors.push({ field: "price", message: "Informe um preço maior que zero." });
  if (!saleCondition && (qty == null || qty < 0)) errors.push({ field: "available_quantity", message: "Informe um estoque válido." });
  if (!normalizeText(data.listing_type_id, 60)) errors.push({ field: "listing_type_id", message: "Selecione o tipo de anúncio." });
  if (!saleCondition && !compactPictures(data.pictures).length) errors.push({ field: "pictures", message: "Adicione ao menos uma imagem antes de validar/publicar." });
  return errors;
}

function assertLocalValidation(draft, target) {
  const validationErrors = localValidation(draft, { target });
  if (validationErrors.length) {
    throw httpError("O rascunho possui campos obrigatórios pendentes.", 422, { errors: validationErrors }, "DRAFT_INVALID");
  }
}

function buildItemPayload(draft) {
  const data = draft?.draft_data || {};
  const publicationModel = draft?.publication_model === "user_products" ? "user_products" : "legacy";
  assertLocalValidation(draft, "new_item");

  const payload = {
    category_id: normalizeText(data.category_id || draft.category_id, 80).toUpperCase(),
    price: Number(data.price),
    currency_id: normalizeText(data.currency_id || "BRL", 12).toUpperCase(),
    available_quantity: Math.max(0, Number(data.available_quantity || 0)),
    buying_mode: normalizeText(data.buying_mode || "buy_it_now", 60),
    listing_type_id: normalizeText(data.listing_type_id || "gold_special", 60),
    pictures: compactPictures(data.pictures),
    attributes: compactAttributes(data.attributes, { sku: data.sku, gtin: data.gtin, condition: data.condition || "new" }),
  };

  if (publicationModel === "user_products") {
    payload.family_name = normalizeText(data.family_name || draft.family_name, 180);
  } else {
    payload.title = normalizeText(data.title || draft.title, 180);
  }

  const saleTerms = compactSaleTerms(data.sale_terms);
  if (saleTerms.length) payload.sale_terms = saleTerms;

  const shipping = compactShipping(data.shipping);
  if (Object.keys(shipping).length) payload.shipping = shipping;

  const channels = Array.isArray(data.channels) ? data.channels.map((x) => normalizeText(x, 40)).filter(Boolean) : [];
  if (channels.length) payload.channels = channels;

  return payload;
}

function buildSaleConditionPayload(draft) {
  const data = draft?.draft_data || {};
  assertLocalValidation(draft, "sale_condition");
  const shipping = compactShipping(data.shipping);
  const saleTerms = compactSaleTerms(data.sale_terms);
  const channels = Array.isArray(data.channels) ? data.channels.map((x) => normalizeText(x, 40)).filter(Boolean) : [];

  return {
    price: Number(data.price),
    category_id: normalizeText(data.category_id || draft.category_id, 80).toUpperCase(),
    currency_id: normalizeText(data.currency_id || "BRL", 12).toUpperCase(),
    buying_mode: normalizeText(data.buying_mode || "buy_it_now", 60),
    listing_type_id: normalizeText(data.listing_type_id || "gold_special", 60),
    ...(Object.keys(shipping).length ? { shipping } : {}),
    ...(saleTerms.length ? { sale_terms: saleTerms } : {}),
    ...(channels.length ? { channels } : {}),
  };
}

module.exports = {
  buildItemPayload,
  buildSaleConditionPayload,
  localValidation,
  compactAttributes,
  compactPictures,
  conditionAttribute,
};
