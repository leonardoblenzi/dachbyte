"use strict";

const ml = require("./mercadoLivreApi");
const capabilitiesService = require("./anuncioCapabilitiesService");
const { httpError, normalizeItemId, normalizeText } = require("./helpers");

function compactAttribute(attr = {}) {
  if (!attr?.id && !attr?.name) return null;
  return {
    id: attr.id || null,
    name: attr.name || null,
    value_id: attr.value_id || null,
    value_name: attr.value_name ?? null,
    value_type: attr.value_type || null,
  };
}

function compactSaleTerm(term = {}) {
  if (!term?.id) return null;
  return {
    id: term.id,
    name: term.name || null,
    value_id: term.value_id || null,
    value_name: term.value_name ?? null,
  };
}

function compactPicture(pic = {}) {
  const url = pic.secure_url || pic.url || pic.source || null;
  if (!url && !pic.id) return null;
  return {
    id: pic.id || null,
    url,
    secure_url: pic.secure_url || url,
  };
}

async function getDescription(itemId, ctx) {
  try {
    const data = await ml.get(`/items/${encodeURIComponent(itemId)}/description`, { accessToken: ctx.accessToken });
    return String(data?.plain_text || data?.text || "").trim();
  } catch (error) {
    if ([403, 404].includes(Number(error?.status))) return "";
    throw error;
  }
}

function editableFromItem(item, description, sourceType, publicationModel) {
  const isExternal = sourceType === "external_item";
  const sourcePictures = (Array.isArray(item?.pictures) ? item.pictures : []).map(compactPicture).filter(Boolean);
  const pictures = isExternal ? [] : sourcePictures.map((pic) => ({ source: pic.secure_url || pic.url }));

  const attributes = (Array.isArray(item?.attributes) ? item.attributes : [])
    .map(compactAttribute)
    .filter(Boolean)
    .filter((attr) => !["GTIN", "SELLER_SKU"].includes(String(attr.id || "").toUpperCase()));
  const originalSku = (Array.isArray(item?.attributes) ? item.attributes : []).find((a) => String(a?.id || "").toUpperCase() === "SELLER_SKU");
  const originalGtin = (Array.isArray(item?.attributes) ? item.attributes : []).find((a) => String(a?.id || "").toUpperCase() === "GTIN");

  return {
    title: publicationModel === "legacy" ? String(item?.title || "") : "",
    family_name: publicationModel === "user_products" ? String(item?.family_name || item?.title || "") : "",
    category_id: item?.category_id || "",
    price: Number(item?.price || 0) || "",
    currency_id: item?.currency_id || "BRL",
    available_quantity: isExternal ? 1 : Math.max(0, Number(item?.available_quantity || 0)),
    buying_mode: item?.buying_mode || "buy_it_now",
    listing_type_id: item?.listing_type_id || "gold_special",
    condition: item?.condition || "new",
    sku: "",
    gtin: "",
    original_sku: originalSku?.value_name || null,
    original_gtin: originalGtin?.value_name || null,
    attributes,
    sale_terms: (Array.isArray(item?.sale_terms) ? item.sale_terms : []).map(compactSaleTerm).filter(Boolean),
    pictures,
    description: isExternal ? "" : description,
    shipping: {
      free_shipping: Boolean(item?.shipping?.free_shipping),
      local_pick_up: Boolean(item?.shipping?.local_pick_up),
      mode: item?.shipping?.mode || undefined,
    },
    channels: Array.isArray(item?.channels) && item.channels.length ? item.channels : ["marketplace"],
  };
}

async function resolveItem(input, ctx) {
  const itemId = normalizeItemId(input);
  if (!itemId) throw httpError("Informe um MLB válido ou um link do Mercado Livre que contenha o MLB.", 400);

  const [item, capabilities] = await Promise.all([
    ml.get(`/items/${encodeURIComponent(itemId)}`, { accessToken: ctx.accessToken }),
    capabilitiesService.getCapabilities(ctx),
  ]);
  const own = Number(item?.seller_id) === Number(ctx.sellerId);
  const sourceType = own ? "own_item" : "external_item";
  const description = await getDescription(itemId, ctx);
  const publicationModel = capabilities.publication_model;
  let userProduct = null;
  if (item?.user_product_id) {
    try {
      userProduct = await ml.get(`/user-products/${encodeURIComponent(item.user_product_id)}`, { accessToken: ctx.accessToken });
    } catch (error) {
      if (![403, 404].includes(Number(error?.status))) throw error;
    }
  }

  const snapshot = {
    id: item.id,
    title: item.title || null,
    family_name: item.family_name || null,
    family_id: item.family_id != null ? String(item.family_id) : (userProduct?.family_id != null ? String(userProduct.family_id) : null),
    user_product_id: item.user_product_id || null,
    seller_id: item.seller_id || null,
    category_id: item.category_id || null,
    permalink: item.permalink || null,
    thumbnail: item.thumbnail || null,
    price: item.price ?? null,
  };

  return {
    kind: "item",
    source_type: sourceType,
    own,
    item_id: itemId,
    source_snapshot: snapshot,
    reference_data: sourceType === "external_item" ? {
      pictures: (Array.isArray(item?.pictures) ? item.pictures : []).map(compactPicture).filter(Boolean),
      description,
      attributes: (Array.isArray(item?.attributes) ? item.attributes : []).map(compactAttribute).filter(Boolean),
      price: item?.price ?? null,
      title: item?.title || null,
    } : {},
    draft_data: editableFromItem(item, description, sourceType, publicationModel),
    publication_model: publicationModel,
    capabilities,
  };
}

function extractFamilyProducts(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.user_products_ids)) return payload.user_products_ids;
  for (const key of ["user_products", "products", "results", "items"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

async function resolveFamily(familyIdRaw, ctx) {
  const familyId = normalizeText(familyIdRaw, 120).replace(/^FAMILY[:\s-]*/i, "");
  if (!familyId) throw httpError("Informe o ID da família.", 400);
  const capabilities = await capabilitiesService.getCapabilities(ctx);
  if (!capabilities.user_product_seller) {
    throw httpError("A conta selecionada ainda não está no modelo User Products; famílias não estão disponíveis para novos cadastros.", 409);
  }

  const family = await ml.get(
    `/sites/${encodeURIComponent(ctx.siteId)}/user-products-families/${encodeURIComponent(familyId)}`,
    { accessToken: ctx.accessToken },
  );

  const familyOwnerId = Number(family?.user_id);
  if (!Number.isFinite(familyOwnerId) || familyOwnerId <= 0) {
    throw httpError(
      "O Mercado Livre não informou o proprietário desta família. Por segurança, ela não pode ser importada como própria.",
      422,
      { family_id: familyId },
      "FAMILY_OWNER_UNCONFIRMED",
    );
  }
  if (familyOwnerId !== Number(ctx.sellerId)) {
    throw httpError(
      "Esta família pertence a outro vendedor e não pode ser tratada como família da conta selecionada.",
      403,
      { family_id: familyId, family_user_id: familyOwnerId, current_seller_id: ctx.sellerId },
      "FAMILY_NOT_OWNED",
    );
  }

  const products = extractFamilyProducts(family).map((row) => {
    if (typeof row === "string") return { user_product_id: row, name: null, attributes: [], pictures: [] };
    return {
      user_product_id: row?.id || row?.user_product_id || null,
      name: row?.name || row?.title || row?.family_name || null,
      attributes: Array.isArray(row?.attributes) ? row.attributes.map(compactAttribute).filter(Boolean) : [],
      pictures: Array.isArray(row?.pictures) ? row.pictures.map(compactPicture).filter(Boolean) : [],
    };
  }).filter((row) => row.user_product_id);

  return {
    kind: "family",
    source_type: "own_family",
    family_id: String(family?.family_id ?? family?.id ?? familyId),
    family_name: family?.family_name || family?.name || null,
    products,
    raw_summary: {
      id: family?.family_id ?? family?.id ?? familyId,
      family_name: family?.family_name || family?.name || null,
      site_id: family?.site_id || ctx.siteId,
      user_id: family?.user_id || null,
      domain_id: family?.domain_id || null,
      category_id: family?.category_id || null,
    },
    capabilities,
  };
}

async function resolveSource({ input, type = "item" } = {}, ctx) {
  if (type === "family") return resolveFamily(input, ctx);
  return resolveItem(input, ctx);
}

async function searchOwnItems({ q = "", offset = 0, limit = 20 } = {}, ctx) {
  if (!ctx.sellerId) throw httpError("Conta Mercado Livre sem seller_id.", 409);
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const params = new URLSearchParams({ limit: String(safeLimit), offset: String(safeOffset) });
  const text = normalizeText(q, 120);
  if (text) params.set("q", text);

  const search = await ml.get(
    `/users/${encodeURIComponent(ctx.sellerId)}/items/search?${params.toString()}`,
    { accessToken: ctx.accessToken },
  );
  const ids = Array.isArray(search?.results) ? search.results.slice(0, safeLimit) : [];
  let items = [];
  if (ids.length) {
    const details = await ml.get(`/items?ids=${encodeURIComponent(ids.join(","))}`, { accessToken: ctx.accessToken });
    items = (Array.isArray(details) ? details : []).map((entry) => entry?.body || entry).filter(Boolean).map((item) => ({
      id: item.id,
      title: item.title,
      family_name: item.family_name || null,
      family_id: item.family_id != null ? String(item.family_id) : null,
      user_product_id: item.user_product_id || null,
      category_id: item.category_id || null,
      price: item.price ?? null,
      currency_id: item.currency_id || "BRL",
      status: item.status || null,
      thumbnail: item.thumbnail || null,
      permalink: item.permalink || null,
      sku: (item.attributes || []).find((a) => String(a?.id || "").toUpperCase() === "SELLER_SKU")?.value_name || null,
    }));
  }
  return { items, paging: search?.paging || { offset: safeOffset, limit: safeLimit, total: items.length } };
}

module.exports = { resolveSource, resolveItem, resolveFamily, searchOwnItems };
