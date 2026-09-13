"use strict";

const { query, queryOne, withClient } = require("../config/postgres");

function mapGroupRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    shopId: Number(row.shop_id),
    name: row.name,
    description: row.description || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listAdsCampaignGroups(shopId) {
  const groupsResult = await query(
    `
      SELECT
        id,
        "shopId" AS shop_id,
        name,
        description,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
      FROM "AdsCampaignGroup"
      WHERE "shopId" = $1
      ORDER BY "updatedAt" DESC, id DESC
    `,
    [shopId],
  );

  const campaignsResult = await query(
    `
      SELECT
        agc."groupId" AS group_id,
        agc."campaignId" AS campaign_id
      FROM "AdsCampaignGroupCampaign" agc
      INNER JOIN "AdsCampaignGroup" agg ON agg.id = agc."groupId"
      WHERE agg."shopId" = $1
      ORDER BY agc."campaignId" ASC
    `,
    [shopId],
  );

  const campaignsByGroupId = new Map();
  for (const row of campaignsResult.rows) {
    const key = Number(row.group_id);
    if (!campaignsByGroupId.has(key)) {
      campaignsByGroupId.set(key, []);
    }
    campaignsByGroupId.get(key).push(String(row.campaign_id));
  }

  return groupsResult.rows.map((row) => ({
    ...mapGroupRow(row),
    campaignIds: campaignsByGroupId.get(Number(row.id)) || [],
  }));
}

async function findAdsCampaignGroup(shopId, groupId) {
  const row = await queryOne(
    `
      SELECT
        id,
        "shopId" AS shop_id,
        name,
        description,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
      FROM "AdsCampaignGroup"
      WHERE id = $1
        AND "shopId" = $2
      LIMIT 1
    `,
    [groupId, shopId],
  );

  return mapGroupRow(row);
}

async function listGroupCampaignIds(groupId) {
  const result = await query(
    `
      SELECT "campaignId" AS campaign_id
      FROM "AdsCampaignGroupCampaign"
      WHERE "groupId" = $1
      ORDER BY "campaignId" ASC
    `,
    [groupId],
  );

  return result.rows.map((row) => String(row.campaign_id));
}

async function createAdsCampaignGroup({ shopId, name, description, campaignIds }) {
  return withClient(async (client) => {
    await client.query("BEGIN");

    try {
      const groupResult = await client.query(
        `
          INSERT INTO "AdsCampaignGroup" (
            "shopId",
            name,
            description,
            "createdAt",
            "updatedAt"
          )
          VALUES ($1, $2, $3, NOW(), NOW())
          RETURNING
            id,
            "shopId" AS shop_id,
            name,
            description,
            "createdAt" AS created_at,
            "updatedAt" AS updated_at
        `,
        [shopId, name, description],
      );

      const group = mapGroupRow(groupResult.rows[0]);

      for (const campaignId of campaignIds) {
        await client.query(
          `
            INSERT INTO "AdsCampaignGroupCampaign" (
              "groupId",
              "campaignId",
              "createdAt"
            )
            VALUES ($1, $2, NOW())
          `,
          [group.id, String(campaignId)],
        );
      }

      await client.query("COMMIT");

      return {
        ...group,
        campaignIds: campaignIds.map(String),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function updateAdsCampaignGroup({
  groupId,
  name,
  description,
  campaignIds,
}) {
  return withClient(async (client) => {
    await client.query("BEGIN");

    try {
      const assignments = [];
      const params = [groupId];
      let index = 2;

      if (name != null) {
        assignments.push(`name = $${index++}`);
        params.push(name);
      }

      if (description != null) {
        assignments.push(`description = $${index++}`);
        params.push(description);
      }

      assignments.push(`"updatedAt" = NOW()`);

      const updatedResult = await client.query(
        `
          UPDATE "AdsCampaignGroup"
          SET ${assignments.join(", ")}
          WHERE id = $1
          RETURNING
            id,
            "shopId" AS shop_id,
            name,
            description,
            "createdAt" AS created_at,
            "updatedAt" AS updated_at
        `,
        params,
      );

      const group = mapGroupRow(updatedResult.rows[0]);

      if (campaignIds != null) {
        await client.query(
          `
            DELETE FROM "AdsCampaignGroupCampaign"
            WHERE "groupId" = $1
          `,
          [groupId],
        );

        for (const campaignId of campaignIds) {
          await client.query(
            `
              INSERT INTO "AdsCampaignGroupCampaign" (
                "groupId",
                "campaignId",
                "createdAt"
              )
              VALUES ($1, $2, NOW())
            `,
            [groupId, String(campaignId)],
          );
        }
      }

      await client.query("COMMIT");

      return {
        ...group,
        campaignIds:
          campaignIds != null ? campaignIds.map(String) : await listGroupCampaignIds(groupId),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function deleteAdsCampaignGroup(groupId) {
  const row = await queryOne(
    `
      DELETE FROM "AdsCampaignGroup"
      WHERE id = $1
      RETURNING id
    `,
    [groupId],
  );

  return Boolean(row);
}

module.exports = {
  createAdsCampaignGroup,
  deleteAdsCampaignGroup,
  findAdsCampaignGroup,
  listAdsCampaignGroups,
  updateAdsCampaignGroup,
};
