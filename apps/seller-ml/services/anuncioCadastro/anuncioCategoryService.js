"use strict";

const ml = require("./mercadoLivreApi");
const { httpError, normalizeText } = require("./helpers");

async function suggestCategories(q, ctx) {
  const text = normalizeText(q, 120);
  if (text.length < 3) throw httpError("Digite ao menos 3 caracteres para sugerir a categoria.", 400);
  const data = await ml.get(`/sites/${encodeURIComponent(ctx.siteId)}/domain_discovery/search`, {
    accessToken: ctx.accessToken,
    query: { limit: 8, q: text },
  });
  return (Array.isArray(data) ? data : []).map((row) => ({
    category_id: row?.category_id || row?.category?.id || null,
    category_name: row?.category_name || row?.category?.name || null,
    domain_id: row?.domain_id || null,
    domain_name: row?.domain_name || null,
    probability: row?.probability ?? null,
  })).filter((row) => row.category_id);
}

async function getCategory(categoryId, ctx) {
  const id = normalizeText(categoryId, 80).toUpperCase();
  if (!id) throw httpError("Categoria inválida.", 400);
  return ml.get(`/categories/${encodeURIComponent(id)}`, { accessToken: ctx.accessToken });
}

async function getAttributes(categoryId, ctx) {
  const id = normalizeText(categoryId, 80).toUpperCase();
  if (!id) throw httpError("Categoria inválida.", 400);
  const [category, attributes, saleTerms] = await Promise.all([
    getCategory(id, ctx),
    ml.get(`/categories/${encodeURIComponent(id)}/attributes`, { accessToken: ctx.accessToken }),
    ml.get(`/categories/${encodeURIComponent(id)}/sale_terms`, { accessToken: ctx.accessToken }).catch((error) => {
      if ([400, 404].includes(Number(error?.status))) return [];
      throw error;
    }),
  ]);
  return {
    category: {
      id: category?.id || id,
      name: category?.name || null,
      settings: category?.settings || {},
    },
    attributes: (Array.isArray(attributes) ? attributes : []).map((attr) => ({
      id: attr.id,
      name: attr.name,
      value_type: attr.value_type || "string",
      value_max_length: attr.value_max_length ?? null,
      tags: attr.tags || {},
      values: Array.isArray(attr.values) ? attr.values.slice(0, 300).map((value) => ({ id: value.id || null, name: value.name || null })) : [],
      hierarchy: attr.hierarchy || null,
    })),
    sale_terms: (Array.isArray(saleTerms) ? saleTerms : []).map((term) => ({
      id: term.id,
      name: term.name,
      value_type: term.value_type || "string",
      value_max_length: term.value_max_length ?? null,
      tags: term.tags || {},
      values: Array.isArray(term.values) ? term.values.slice(0, 300).map((value) => ({ id: value.id || null, name: value.name || null })) : [],
      allowed_units: Array.isArray(term.allowed_units) ? term.allowed_units.map((unit) => ({ id: unit.id || null, name: unit.name || unit.id || null })).filter((unit) => unit.name) : [],
      default_unit: term.default_unit || null,
    })),
  };
}

async function listingTypes(ctx) {
  const rows = await ml.get(`/sites/${encodeURIComponent(ctx.siteId)}/listing_types`, { accessToken: ctx.accessToken });
  return (Array.isArray(rows) ? rows : []).map((row) => ({ id: row.id, name: row.name || row.id })).filter((row) => row.id);
}

module.exports = { suggestCategories, getCategory, getAttributes, listingTypes };
