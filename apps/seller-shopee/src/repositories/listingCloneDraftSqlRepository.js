"use strict";

const { query, queryOne } = require("../config/postgres");

function toBigIntStringOrNull(value) {
  if (value == null || value === "") return null;
  try {
    return BigInt(value).toString();
  } catch (_error) {
    return null;
  }
}

function mapDraftRow(row) {
  if (!row) return null;

  return {
    id: Number(row.id),
    shopId: Number(row.shopId),
    userId: row.userId == null ? null : Number(row.userId),
    status: row.status || "DRAFT",
    sourcePlatform: row.sourcePlatform || null,
    sourceUrl: row.sourceUrl || null,
    sourceItemId: toBigIntStringOrNull(row.sourceItemId),
    title: row.title || null,
    draftData: row.draftData && typeof row.draftData === "object" ? row.draftData : {},
    publishedItemId: toBigIntStringOrNull(row.publishedItemId),
    publishedAt: row.publishedAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildDraftSummary(draftRow) {
  const draftData = draftRow?.draftData && typeof draftRow.draftData === "object"
    ? draftRow.draftData
    : {};
  const images = Array.isArray(draftData.images) ? draftData.images : [];
  const attributes = Array.isArray(draftData.attributes) ? draftData.attributes : [];
  const mandatoryAttributes = attributes.filter((attribute) => attribute?.isMandatory);
  const filledMandatoryAttributes = mandatoryAttributes.filter(
    (attribute) => Array.isArray(attribute?.values) && attribute.values.filter(Boolean).length,
  );

  return {
    id: draftRow.id,
    status: draftRow.status,
    title:
      String(draftData.itemName || "").trim() ||
      draftRow.title ||
      "Rascunho sem titulo",
    sourcePlatform: draftRow.sourcePlatform,
    sourceUrl: draftRow.sourceUrl,
    sourceItemId: draftRow.sourceItemId,
    publishedItemId: draftRow.publishedItemId,
    publishedAt: draftRow.publishedAt,
    createdAt: draftRow.createdAt,
    updatedAt: draftRow.updatedAt,
    summary: {
      imageCount: images.length,
      hasBrand: Boolean(String(draftData.brandName || "").trim()),
      categoryId: String(draftData.categoryId || "").trim() || null,
      mandatoryAttributeCount: mandatoryAttributes.length,
      filledMandatoryAttributeCount: filledMandatoryAttributes.length,
      sourceCategoryName:
        String(draftData.categoryName || draftData.sourceCategoryName || "").trim() || null,
    },
  };
}

async function listListingCloneDrafts(shopId) {
  const result = await query(
    `
      SELECT
        id,
        "shopId",
        "userId",
        status,
        "sourcePlatform",
        "sourceUrl",
        "sourceItemId",
        title,
        "draftData",
        "publishedItemId",
        "publishedAt",
        "createdAt",
        "updatedAt"
      FROM "ListingCloneDraft"
      WHERE "shopId"::text = $1::text
        AND status = 'DRAFT'
      ORDER BY "updatedAt" DESC, id DESC
    `,
    [Number(shopId)],
  );

  return result.rows.map((row) => buildDraftSummary(mapDraftRow(row)));
}

async function findListingCloneDraftById(shopId, draftId) {
  const row = await queryOne(
    `
      SELECT
        id,
        "shopId",
        "userId",
        status,
        "sourcePlatform",
        "sourceUrl",
        "sourceItemId",
        title,
        "draftData",
        "publishedItemId",
        "publishedAt",
        "createdAt",
        "updatedAt"
      FROM "ListingCloneDraft"
      WHERE "shopId"::text = $1::text
        AND id::text = $2::text
      LIMIT 1
    `,
    [Number(shopId), Number(draftId)],
  );

  return mapDraftRow(row);
}

async function saveListingCloneDraft({ draftId = null, shopId, userId = null, draft }) {
  const payload = draft && typeof draft === "object" ? draft : {};
  const sourcePlatform = String(payload.sourcePlatform || "").trim() || null;
  const sourceUrl = String(payload.sourceUrl || "").trim() || null;
  const sourceItemId = toBigIntStringOrNull(payload.sourceItemId);
  const title = String(payload.itemName || "").trim() || null;

  let row;

  if (draftId != null) {
    row = await queryOne(
      `
        UPDATE "ListingCloneDraft"
        SET
          "userId" = COALESCE($3::int, "userId"),
          status = 'DRAFT',
          "sourcePlatform" = $4,
          "sourceUrl" = $5,
          "sourceItemId" = $6::bigint,
          title = $7,
          "draftData" = $8::jsonb,
          "updatedAt" = NOW()
        WHERE "shopId"::text = $1::text
          AND id::text = $2::text
        RETURNING
          id,
          "shopId",
          "userId",
          status,
          "sourcePlatform",
          "sourceUrl",
          "sourceItemId",
          title,
          "draftData",
          "publishedItemId",
          "publishedAt",
          "createdAt",
          "updatedAt"
      `,
      [
        Number(shopId),
        Number(draftId),
        userId == null ? null : Number(userId),
        sourcePlatform,
        sourceUrl,
        sourceItemId,
        title,
        JSON.stringify(payload),
      ],
    );
  } else {
    row = await queryOne(
      `
        INSERT INTO "ListingCloneDraft" (
          "shopId",
          "userId",
          status,
          "sourcePlatform",
          "sourceUrl",
          "sourceItemId",
          title,
          "draftData"
        )
        VALUES ($1, $2, 'DRAFT', $3, $4, $5::bigint, $6, $7::jsonb)
        RETURNING
          id,
          "shopId",
          "userId",
          status,
          "sourcePlatform",
          "sourceUrl",
          "sourceItemId",
          title,
          "draftData",
          "publishedItemId",
          "publishedAt",
          "createdAt",
          "updatedAt"
      `,
      [
        Number(shopId),
        userId == null ? null : Number(userId),
        sourcePlatform,
        sourceUrl,
        sourceItemId,
        title,
        JSON.stringify(payload),
      ],
    );
  }

  return mapDraftRow(row);
}

async function deleteListingCloneDraft(shopId, draftId) {
  const row = await queryOne(
    `
      DELETE FROM "ListingCloneDraft"
      WHERE "shopId"::text = $1::text
        AND id::text = $2::text
      RETURNING id
    `,
    [Number(shopId), Number(draftId)],
  );

  return Boolean(row);
}

async function markListingCloneDraftPublished({ shopId, draftId, publishedItemId }) {
  if (draftId == null) return null;

  const row = await queryOne(
    `
      UPDATE "ListingCloneDraft"
      SET
        status = 'PUBLISHED',
        "publishedItemId" = $3::bigint,
        "publishedAt" = NOW(),
        "updatedAt" = NOW()
      WHERE "shopId"::text = $1::text
        AND id::text = $2::text
      RETURNING
        id,
        "shopId",
        "userId",
        status,
        "sourcePlatform",
        "sourceUrl",
        "sourceItemId",
        title,
        "draftData",
        "publishedItemId",
        "publishedAt",
        "createdAt",
        "updatedAt"
    `,
    [Number(shopId), Number(draftId), toBigIntStringOrNull(publishedItemId)],
  );

  return mapDraftRow(row);
}

module.exports = {
  buildDraftSummary,
  deleteListingCloneDraft,
  findListingCloneDraftById,
  listListingCloneDrafts,
  markListingCloneDraftPublished,
  saveListingCloneDraft,
};
