"use strict";

const { query, queryOne, withClient } = require("../config/postgres");

function buildGiftCampaignByIdQuery({ shopId, campaignId }) {
  return {
    text: `SELECT gc.*, s."shopId" AS "shopeeShopId" FROM "GiftCampaign" gc
           INNER JOIN "Shop" s ON s.id = gc."shopId"
           WHERE gc.id = $1::uuid AND gc."shopId" = $2 LIMIT 1`,
    values: [String(campaignId), Number(shopId)],
  };
}
function normaliseItems(items) {
  return Array.isArray(items) ? items : [];
}

function itemValues(item) {
  return [
    String(item.pricingKey || item.key || ""),
    item.productId == null ? null : Number(item.productId),
    item.itemId == null ? null : String(item.itemId),
    item.modelId == null || item.modelId === "" ? null : String(item.modelId),
    item.title || null,
    item.sku || null,
    item.costCents == null ? null : Math.trunc(Number(item.costCents)),
    item.priceCents == null ? null : Number(item.priceCents),
  ];
}

async function insertItems(client, { campaignId, shopId, mainItems = [], giftItems = [] }) {
  for (const item of normaliseItems(mainItems)) {
    await client.query(
      `INSERT INTO "GiftCampaignMainItem" ("campaignId", "shopId", "pricingKey", "productId", "itemId", "modelId", title, sku, "costCents", "priceCents")
       VALUES ($1::uuid, $2, $3, $4, $5::bigint, $6::bigint, $7, $8, $9, $10)`,
      [String(campaignId), Number(shopId), ...itemValues(item)],
    );
  }

  for (const item of normaliseItems(giftItems)) {
    await client.query(
      `INSERT INTO "GiftCampaignGiftItem" ("campaignId", "shopId", "pricingKey", "productId", "itemId", "modelId", title, sku, "costCents", "priceCents", quantity)
       VALUES ($1::uuid, $2, $3, $4, $5::bigint, $6::bigint, $7, $8, $9, $10, $11)`,
      [String(campaignId), Number(shopId), ...itemValues(item), Math.max(1, Number(item.quantity) || 1)],
    );
  }
}

async function createGiftCampaign(input) {
  const campaign = input || {};
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await client.query(
        `INSERT INTO "GiftCampaign" (
          id, "shopId", name, status, "minSpendCents", "targetMarginRate", "startAt", "endAt", "useMaxDuration",
          "conflictPolicy", "logisticsResolution", "logisticsPlan", preview, "remoteAddOnDealId", "idempotencyKey",
          "createdByUserId", "updatedByUserId"
        ) VALUES (
          $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::bigint, $15, $16, $17
        ) RETURNING *`,
        [
          String(campaign.id), Number(campaign.shopId), String(campaign.name || "Campanha de brinde"), campaign.status || "draft",
          Math.max(0, Math.round(Number(campaign.minSpendCents) || 0)), campaign.targetMarginRate ?? null,
          campaign.startAt || null, campaign.endAt || null, Boolean(campaign.useMaxDuration),
          campaign.conflictPolicy || null, campaign.logisticsResolution || null,
          JSON.stringify(campaign.logisticsPlan || {}), JSON.stringify(campaign.preview || {}),
          campaign.remoteAddOnDealId == null ? null : String(campaign.remoteAddOnDealId), String(campaign.idempotencyKey || ""),
          campaign.createdByUserId == null ? null : Number(campaign.createdByUserId),
          campaign.updatedByUserId == null ? null : Number(campaign.updatedByUserId),
        ],
      );
      await insertItems(client, { ...campaign, campaignId: campaign.id });
      await client.query("COMMIT");
      return result.rows[0] || null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function replaceCampaignItems(input) {
  const campaign = input || {};
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const scoped = await client.query(
        `SELECT id FROM "GiftCampaign" WHERE id = $1::uuid AND "shopId" = $2 LIMIT 1`,
        [String(campaign.campaignId), Number(campaign.shopId)],
      );
      if (!scoped.rowCount) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(`DELETE FROM "GiftCampaignMainItem" WHERE "campaignId" = $1::uuid AND "shopId" = $2`, [String(campaign.campaignId), Number(campaign.shopId)]);
      await client.query(`DELETE FROM "GiftCampaignGiftItem" WHERE "campaignId" = $1::uuid AND "shopId" = $2`, [String(campaign.campaignId), Number(campaign.shopId)]);
      await insertItems(client, { ...campaign, campaignId: campaign.campaignId });
      await client.query(`UPDATE "GiftCampaign" SET "updatedAt" = NOW(), "updatedByUserId" = $3 WHERE id = $1::uuid AND "shopId" = $2`, [String(campaign.campaignId), Number(campaign.shopId), campaign.updatedByUserId == null ? null : Number(campaign.updatedByUserId)]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function getGiftCampaign({ shopId, campaignId }) {
  const campaignQuery = buildGiftCampaignByIdQuery({ shopId, campaignId });
  const campaign = await queryOne(campaignQuery.text, campaignQuery.values);
  if (!campaign) return null;
  const [mainItems, giftItems, actions] = await Promise.all([
    query(`SELECT * FROM "GiftCampaignMainItem" WHERE "campaignId" = $1::uuid AND "shopId" = $2 ORDER BY id ASC`, [String(campaignId), Number(shopId)]),
    query(`SELECT * FROM "GiftCampaignGiftItem" WHERE "campaignId" = $1::uuid AND "shopId" = $2 ORDER BY id ASC`, [String(campaignId), Number(shopId)]),
    query(`SELECT * FROM "GiftCampaignAction" WHERE "campaignId" = $1::uuid AND "shopId" = $2 ORDER BY "createdAt" ASC, id ASC`, [String(campaignId), Number(shopId)]),
  ]);
  return { ...campaign, mainItems: mainItems.rows, giftItems: giftItems.rows, actions: actions.rows };
}

async function listGiftCampaigns({ shopId }) {
  const result = await query(`SELECT gc.* FROM "GiftCampaign" gc WHERE gc."shopId" = $1 ORDER BY gc."createdAt" DESC, gc.id DESC`, [Number(shopId)]);
  return result.rows;
}

async function appendGiftCampaignAction(input) {
  const action = input || {};
  return queryOne(
    `INSERT INTO "GiftCampaignAction" ("campaignId", "shopId", action, "actorUserId", payload)
     SELECT $1::uuid, gc."shopId", $3, $4, $5::jsonb FROM "GiftCampaign" gc
     WHERE gc.id = $1::uuid AND gc."shopId" = $2
     RETURNING *`,
    [String(action.campaignId), Number(action.shopId), String(action.action || ""), action.actorUserId == null ? null : Number(action.actorUserId), JSON.stringify(action.payload || {})],
  );
}

async function setGiftCampaignState(input) {
  const campaign = input || {};
  return queryOne(
    `UPDATE "GiftCampaign"
     SET status = $3, "remoteAddOnDealId" = COALESCE($4::bigint, "remoteAddOnDealId"),
         "updatedByUserId" = $5, "updatedAt" = NOW()
     WHERE id = $1::uuid AND "shopId" = $2
     RETURNING *`,
    [String(campaign.campaignId), Number(campaign.shopId), String(campaign.status || campaign.state || "draft"), campaign.remoteAddOnDealId == null ? null : String(campaign.remoteAddOnDealId), campaign.updatedByUserId == null ? null : Number(campaign.updatedByUserId)],
  );
}

async function updateGiftCampaign(input) {
  const campaign = input || {};
  return queryOne(
    `UPDATE "GiftCampaign"
       SET name = COALESCE($3, name),
           "minSpendCents" = COALESCE($4, "minSpendCents"),
           "targetMarginRate" = COALESCE($5, "targetMarginRate"),
           "startAt" = COALESCE($6, "startAt"),
           "endAt" = COALESCE($7, "endAt"),
           "useMaxDuration" = COALESCE($8, "useMaxDuration"),
           "conflictPolicy" = COALESCE($9, "conflictPolicy"),
           "logisticsResolution" = COALESCE($10, "logisticsResolution"),
           "logisticsPlan" = COALESCE($11::jsonb, "logisticsPlan"),
           preview = COALESCE($12::jsonb, preview),
           "idempotencyKey" = COALESCE($13, "idempotencyKey"),
           "updatedByUserId" = $14, "updatedAt" = NOW()
     WHERE id = $1::uuid AND "shopId" = $2
     RETURNING *`,
    [
      String(campaign.campaignId), Number(campaign.shopId), campaign.name == null ? null : String(campaign.name),
      campaign.minSpendCents == null ? null : Math.max(0, Math.round(Number(campaign.minSpendCents) || 0)),
      campaign.targetMarginRate ?? null, campaign.startAt ?? null, campaign.endAt ?? null,
      campaign.useMaxDuration == null ? null : Boolean(campaign.useMaxDuration),
      campaign.conflictPolicy ?? null, campaign.logisticsResolution ?? null,
      campaign.logisticsPlan == null ? null : JSON.stringify(campaign.logisticsPlan),
      campaign.preview == null ? null : JSON.stringify(campaign.preview), campaign.idempotencyKey ?? null,
      campaign.updatedByUserId == null ? null : Number(campaign.updatedByUserId),
    ],
  );
}
async function getGiftCampaignByIdUnsafe({ campaignId }) {
  const campaign = await queryOne(`SELECT * FROM "GiftCampaign" WHERE id = $1::uuid LIMIT 1`, [String(campaignId)]);
  if (!campaign) return null;
  return getGiftCampaign({ shopId: campaign.shopId, campaignId });
}
async function getActiveGiftCampaignByPricingKeys({ shopId, keys }) {
  const wanted = Array.from(new Set(normaliseItems(keys).map(String))).filter(Boolean);
  if (!wanted.length) return null;
  return queryOne(
    `SELECT gc.* FROM "GiftCampaign" gc
     INNER JOIN "GiftCampaignMainItem" gcmi ON gcmi."campaignId" = gc.id AND gcmi."shopId" = gc."shopId"
     WHERE gc."shopId" = $1 AND gc.status = 'published'
       AND NOW() BETWEEN gc."startAt" AND gc."endAt"
       AND gcmi."pricingKey" = ANY($2::text[])
     ORDER BY gc."startAt" ASC, gc."createdAt" ASC
     LIMIT 1`,
    [Number(shopId), wanted],
  );
}

module.exports = {
  createGiftCampaign,
  replaceCampaignItems,
  getGiftCampaign,
  listGiftCampaigns,
  appendGiftCampaignAction,
  setGiftCampaignState,
  updateGiftCampaign,
  getActiveGiftCampaignByPricingKeys,
  getGiftCampaignByIdUnsafe,
  _test: { buildGiftCampaignByIdQuery },
};
