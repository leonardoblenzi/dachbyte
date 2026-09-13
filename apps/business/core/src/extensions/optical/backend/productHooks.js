"use strict";

const {
  deleteEntityExtensionDataWithClient,
  listEntityExtensionData,
  upsertEntityExtensionDataWithClient,
} = require("../../../platform/extensions/coreContracts");

function normalizePayload(payload = {}, product = {}) {
  const opticalType = String(payload.opticalType || "").trim() || null;
  const opticalSpecs = payload.opticalSpecs && typeof payload.opticalSpecs === "object" && !Array.isArray(payload.opticalSpecs)
    ? payload.opticalSpecs
    : {};
  const category = String(product.category || "");
  const productType = String(product.type || "").toLowerCase();
  const explicitCatalogType = String(payload.catalogType || "").trim() || null;
  const catalogType = explicitCatalogType || (opticalType === "frame"
    ? "Armacao"
    : opticalType === "lens" && productType === "service"
      ? "Lente encomendada"
      : opticalType === "lens"
        ? "Lente em estoque"
        : /acess/i.test(category)
          ? "Acessorio"
          : null);
  return { opticalType, opticalSpecs, ...(catalogType ? { catalogType } : {}) };
}

function hasPayload(payload = {}) {
  const normalized = normalizePayload(payload);
  return Boolean(normalized.opticalType || normalized.catalogType || Object.values(normalized.opticalSpecs).some((value) => String(value ?? "").trim()));
}

async function afterPersisted({ client, companyId, product, extensionPayloads }) {
  const payload = extensionPayloads?.["vertical.optical"];
  if (!payload) return null;
  const normalized = normalizePayload(payload, product);
  if (!hasPayload(normalized)) {
    await deleteEntityExtensionDataWithClient(client, companyId, "product", product.id, "vertical.optical");
    return null;
  }
  await upsertEntityExtensionDataWithClient(client, companyId, "product", product.id, "vertical.optical", normalized);
  return { data: normalized };
}

async function decorateRows({ client, companyId, rows }) {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) return null;
  const dataByEntity = await listEntityExtensionData(companyId, "product", items.map((row) => row.id), client);
  for (const row of items) {
    const data = dataByEntity.get(String(row.id))?.["vertical.optical"];
    if (!data) continue;
    row.extensions = { ...(row.extensions || {}), "vertical.optical": data };
    row.catalogType = data.catalogType || null;
  }
  return null;
}

async function dependencies({ client, companyId, entityId }) {
  const result = await client.query(`
    select count(*)::int as total
    from volt_core.optical_orders
    where company_id=$1 and (frame_product_id=$2 or lens_product_id=$2)
  `, [companyId, entityId]);
  return { count: Number(result.rows[0]?.total || 0) };
}

async function beforeDeleted({ client, companyId, entityId }) {
  await deleteEntityExtensionDataWithClient(client, companyId, "product", entityId, "vertical.optical");
  return null;
}

module.exports = { afterPersisted, beforeDeleted, decorateRows, dependencies, hasPayload, normalizePayload };
