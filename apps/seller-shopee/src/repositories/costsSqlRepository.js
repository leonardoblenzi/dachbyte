"use strict";

const { query, queryOne } = require("../config/postgres");

function mapProductSummaryRow(row) {
  return {
    id: Number(row.id),
    itemId: row.item_id == null ? null : BigInt(row.item_id),
    title: row.title || null,
    itemSku: row.item_sku || null,
    costCents: row.cost_cents == null ? 0 : Number(row.cost_cents),
    imageUrl: row.image_url || null,
  };
}

function normalizeItemIds(itemIds = []) {
  const normalized = Array.from(
    new Set(
      (Array.isArray(itemIds) ? itemIds : [])
        .map((value) => String(value || "").replace(/[^0-9]/g, "").trim())
        .filter(Boolean),
    ),
  );
  return normalized;
}

async function countProductsForCosts({ shopId, search = "", withoutCost = false }) {
  const hasSearch = Boolean(String(search || "").trim());
  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "Product" p
      WHERE p."shopId" = $1
        AND (
          $2::text = ''
          OR COALESCE(p.title, '') ILIKE '%' || $2 || '%'
          OR COALESCE(p."itemSku", '') ILIKE '%' || $2 || '%'
        )
        AND (
          $3::boolean = FALSE
          OR COALESCE(p."costCents", 0) <= 0
        )
    `,
    [shopId, hasSearch ? String(search).trim() : "", Boolean(withoutCost)],
  );

  return Number(row?.total || 0);
}

async function listProductsForCosts({
  shopId,
  search = "",
  withoutCost = false,
  page = 1,
  pageSize = 50,
}) {
  const offset = Math.max(page - 1, 0) * pageSize;
  const result = await query(
    `
      SELECT
        p.id,
        p."itemId" AS item_id,
        p.title,
        p."itemSku" AS item_sku,
        p."costCents" AS cost_cents,
        (
          SELECT pi.url
          FROM "ProductImage" pi
          WHERE pi."productId" = p.id
          ORDER BY pi.id ASC
          LIMIT 1
        ) AS image_url
      FROM "Product" p
      WHERE p."shopId" = $1
        AND (
          $2::text = ''
          OR COALESCE(p.title, '') ILIKE '%' || $2 || '%'
          OR COALESCE(p."itemSku", '') ILIKE '%' || $2 || '%'
        )
        AND (
          $3::boolean = FALSE
          OR COALESCE(p."costCents", 0) <= 0
        )
      ORDER BY COALESCE(p.title, '') ASC, p.id ASC
      LIMIT $4 OFFSET $5
    `,
    [
      shopId,
      String(search || "").trim(),
      Boolean(withoutCost),
      pageSize,
      offset,
    ],
  );

  return result.rows.map(mapProductSummaryRow);
}

async function getShopTaxRate(shopId) {
  const row = await queryOne(
    `
      SELECT "taxRate" AS tax_rate
      FROM "Shop"
      WHERE id = $1
      LIMIT 1
    `,
    [shopId],
  );

  return Number(row?.tax_rate || 0);
}

async function updateProductCostById({ productId, shopId, costCents }) {
  const row = await queryOne(
    `
      UPDATE "Product"
      SET "costCents" = $3, "updatedAt" = NOW()
      WHERE id = $1
        AND "shopId" = $2
      RETURNING id
    `,
    [productId, shopId, costCents],
  );

  return Boolean(row);
}

async function updateShopTaxRate({ shopId, taxRate }) {
  const row = await queryOne(
    `
      UPDATE "Shop"
      SET "taxRate" = $2, "updatedAt" = NOW()
      WHERE id = $1
      RETURNING id
    `,
    [shopId, taxRate],
  );

  return Boolean(row);
}

async function updateProductCostByItemId({ shopId, itemId, costCents }) {
  const row = await queryOne(
    `
      UPDATE "Product"
      SET "costCents" = $3, "updatedAt" = NOW()
      WHERE "shopId" = $1
        AND "itemId" = $2
      RETURNING id
    `,
    [shopId, itemId.toString(), costCents],
  );

  return Boolean(row);
}

async function exportProductsCosts(shopId) {
  const result = await query(
    `
      SELECT
        "itemId" AS item_id,
        title,
        "costCents" AS cost_cents,
        "itemSku" AS item_sku
      FROM "Product"
      WHERE "shopId" = $1
      ORDER BY COALESCE(title, '') ASC, id ASC
    `,
    [shopId],
  );

  return result.rows.map((row) => ({
    itemId: row.item_id == null ? null : BigInt(row.item_id),
    title: row.title || "",
    costCents: row.cost_cents == null ? 0 : Number(row.cost_cents),
    itemSku: row.item_sku || "",
  }));
}

async function listProductsForIntelligentPricing({ shopId, itemIds = [] }) {
  const normalizedItemIds = normalizeItemIds(itemIds);
  if (!normalizedItemIds.length) return [];

  const result = await query(
    `
      SELECT
        p.id,
        p."itemId" AS item_id,
        p.status,
        p.title,
        p."itemSku" AS item_sku,
        p."costCents" AS cost_cents,
        p."priceMin" AS price_min,
        p."priceMax" AS price_max,
        (
          SELECT pi.url
          FROM "ProductImage" pi
          WHERE pi."productId" = p.id
          ORDER BY pi.id ASC
          LIMIT 1
        ) AS image_url
      FROM "Product" p
      WHERE p."shopId" = $1
        AND p."itemId" = ANY($2::bigint[])
      ORDER BY p."updatedAt" DESC NULLS LAST, p.id DESC
    `,
    [Number(shopId), normalizedItemIds],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    itemId: row.item_id == null ? null : BigInt(row.item_id),
    status: row.status || null,
    title: row.title || null,
    itemSku: row.item_sku || null,
    costCents: row.cost_cents == null ? 0 : Number(row.cost_cents),
    priceMin: row.price_min == null ? null : Number(row.price_min),
    priceMax: row.price_max == null ? null : Number(row.price_max),
    imageUrl: row.image_url || null,
  }));
}

module.exports = {
  countProductsForCosts,
  exportProductsCosts,
  getShopTaxRate,
  listProductsForCosts,
  listProductsForIntelligentPricing,
  updateProductCostById,
  updateProductCostByItemId,
  updateShopTaxRate,
};
