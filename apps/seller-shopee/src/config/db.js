const { query, queryOne } = require("./postgres");

function toBigIntString(value) {
  if (value == null || value === "") return null;
  return BigInt(String(value)).toString();
}

function mapShopRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    accountId: row.account_id == null ? null : Number(row.account_id),
    shopId: row.shop_id == null ? null : row.shop_id,
  };
}

function mapCampaignRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    shopId: Number(row.shop_id),
    shopeeDiscountId: row.shopee_discount_id || null,
    name: row.name,
    status: row.status,
    startTime: row.start_time,
    endTime: row.end_time,
    syncedToShopee: Boolean(row.synced_to_shopee),
    shoppeeUpdateTime: row.shoppee_update_time || null,
    description: row.description || null,
    tags: row.tags || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDiscountItemRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    campaignId: Number(row.campaign_id),
    itemId: row.item_id,
    promotionPrice: row.promotion_price == null ? null : Number(row.promotion_price),
    modelId: row.model_id || null,
    modelPromotionPrice:
      row.model_promotion_price == null ? null : Number(row.model_promotion_price),
    promotionStock: row.promotion_stock == null ? null : Number(row.promotion_stock),
    modelPromotionStock:
      row.model_promotion_stock == null ? null : Number(row.model_promotion_stock),
    purchaseLimit: Number(row.purchase_limit || 0),
    productId: row.product_id == null ? null : Number(row.product_id),
    syncedToShopee: Boolean(row.synced_to_shopee),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    product:
      row.product_id == null &&
      row.product_title == null &&
      row.product_price_min == null &&
      row.product_price_max == null
        ? null
        : {
            id: row.product_id == null ? null : Number(row.product_id),
            title: row.product_title || null,
            priceMin:
              row.product_price_min == null ? null : Number(row.product_price_min),
            priceMax:
              row.product_price_max == null ? null : Number(row.product_price_max),
          },
  };
}

async function loadCampaignItems(campaignId, includeProduct = false) {
  const result = await query(
    `
      SELECT
        di.id,
        di."campaignId" AS campaign_id,
        di."itemId" AS item_id,
        di."promotionPrice" AS promotion_price,
        di."modelId" AS model_id,
        di."modelPromotionPrice" AS model_promotion_price,
        di."promotionStock" AS promotion_stock,
        di."modelPromotionStock" AS model_promotion_stock,
        di."purchaseLimit" AS purchase_limit,
        di."productId" AS product_id,
        di."syncedToShopee" AS synced_to_shopee,
        di."createdAt" AS created_at,
        di."updatedAt" AS updated_at,
        p.title AS product_title,
        p."priceMin" AS product_price_min,
        p."priceMax" AS product_price_max
      FROM "DiscountItem" di
      LEFT JOIN "Product" p ON p.id = di."productId"
      WHERE di."campaignId" = $1
      ORDER BY di.id ASC
    `,
    [Number(campaignId)],
  );

  return result.rows.map((row) => {
    const mapped = mapDiscountItemRow(row);
    if (!includeProduct) {
      delete mapped.product;
    }
    return mapped;
  });
}

async function loadCampaignWithIncludes(baseCampaign, include = {}) {
  if (!baseCampaign) return null;
  const campaign = { ...baseCampaign };

  if (include.Shop) {
    const shop = await queryOne(
      `
        SELECT id, "shopId" AS shop_id
        FROM "Shop"
        WHERE id = $1
        LIMIT 1
      `,
      [campaign.shopId],
    );
    campaign.Shop = shop
      ? { id: Number(shop.id), shopId: shop.shop_id == null ? null : shop.shop_id }
      : null;
  }

  if (include.items) {
    const includeProduct = Boolean(include.items.include?.product);
    campaign.items = await loadCampaignItems(campaign.id, includeProduct);
  }

  return campaign;
}

const db = {
  shop: {
    async findFirst({ where }) {
      const row = await queryOne(
        `
          SELECT id, "accountId" AS account_id, "shopId" AS shop_id
          FROM "Shop"
          WHERE id = $1
            AND "accountId" = $2
          LIMIT 1
        `,
        [Number(where.id), Number(where.accountId)],
      );
      return mapShopRow(row);
    },
    async findFirstByAccount({ accountId }) {
      const row = await queryOne(
        `
          SELECT id, "accountId" AS account_id, "shopId" AS shop_id
          FROM "Shop"
          WHERE "accountId" = $1
          ORDER BY id ASC
          LIMIT 1
        `,
        [Number(accountId)],
      );
      return mapShopRow(row);
    },
  },
  discountCampaign: {
    async upsert({ where, update, create, select }) {
      const row = await queryOne(
        `
          INSERT INTO "DiscountCampaign" (
            "shopId",
            "shopeeDiscountId",
            name,
            status,
            "startTime",
            "endTime",
            "syncedToShopee",
            "shoppeeUpdateTime",
            "createdAt",
            "updatedAt"
          )
          VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $8, NOW(), NOW())
          ON CONFLICT ("shopeeDiscountId")
          DO UPDATE SET
            "shopId" = EXCLUDED."shopId",
            name = EXCLUDED.name,
            status = EXCLUDED.status,
            "startTime" = EXCLUDED."startTime",
            "endTime" = EXCLUDED."endTime",
            "syncedToShopee" = EXCLUDED."syncedToShopee",
            "shoppeeUpdateTime" = EXCLUDED."shoppeeUpdateTime",
            "updatedAt" = NOW()
          RETURNING id
        `,
        [
          Number((create || update).shopId),
          toBigIntString(where.shopeeDiscountId),
          (create || update).name,
          (create || update).status,
          (create || update).startTime,
          (create || update).endTime,
          Boolean((create || update).syncedToShopee),
          (create || update).shoppeeUpdateTime || null,
        ],
      );
      return select?.id ? { id: Number(row.id) } : { id: Number(row.id) };
    },
    async findMany({ where, include, orderBy }) {
      const result = await query(
        `
          SELECT
            id,
            "shopId" AS shop_id,
            "shopeeDiscountId" AS shopee_discount_id,
            name,
            status,
            "startTime" AS start_time,
            "endTime" AS end_time,
            "syncedToShopee" AS synced_to_shopee,
            "shoppeeUpdateTime" AS shoppee_update_time,
            description,
            tags,
            "createdAt" AS created_at,
            "updatedAt" AS updated_at
          FROM "DiscountCampaign"
          WHERE "shopId" = $1
          ORDER BY "createdAt" ${String(orderBy?.createdAt || "desc").toUpperCase() === "ASC" ? "ASC" : "DESC"}
        `,
        [Number(where.shopId)],
      );

      const campaigns = result.rows.map(mapCampaignRow);
      if (!include?.items) {
        return campaigns;
      }

      return Promise.all(
        campaigns.map((campaign) => loadCampaignWithIncludes(campaign, include)),
      );
    },
    async create({ data, include }) {
      const row = await queryOne(
        `
          INSERT INTO "DiscountCampaign" (
            "shopId",
            name,
            "startTime",
            "endTime",
            description,
            tags,
            status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING
            id,
            "shopId" AS shop_id,
            "shopeeDiscountId" AS shopee_discount_id,
            name,
            status,
            "startTime" AS start_time,
            "endTime" AS end_time,
            "syncedToShopee" AS synced_to_shopee,
            "shoppeeUpdateTime" AS shoppee_update_time,
            description,
            tags,
            "createdAt" AS created_at,
            "updatedAt" AS updated_at
        `,
        [
          Number(data.shopId),
          data.name,
          data.startTime,
          data.endTime,
          data.description || null,
          data.tags || null,
          data.status || "draft",
        ],
      );
      return loadCampaignWithIncludes(mapCampaignRow(row), include || {});
    },
    async findUnique({ where, include }) {
      const row = await queryOne(
        `
          SELECT
            id,
            "shopId" AS shop_id,
            "shopeeDiscountId" AS shopee_discount_id,
            name,
            status,
            "startTime" AS start_time,
            "endTime" AS end_time,
            "syncedToShopee" AS synced_to_shopee,
            "shoppeeUpdateTime" AS shoppee_update_time,
            description,
            tags,
            "createdAt" AS created_at,
            "updatedAt" AS updated_at
          FROM "DiscountCampaign"
          WHERE id = $1
          LIMIT 1
        `,
        [Number(where.id)],
      );
      if (!row) return null;
      return loadCampaignWithIncludes(mapCampaignRow(row), include || {});
    },
    async update({ where, data, include }) {
      const row = await queryOne(
        `
          UPDATE "DiscountCampaign"
          SET
            name = COALESCE($2, name),
            "startTime" = COALESCE($3, "startTime"),
            "endTime" = COALESCE($4, "endTime"),
            description = COALESCE($5, description),
            tags = CASE WHEN $6::boolean THEN $7 ELSE tags END,
            status = COALESCE($8, status),
            "shopeeDiscountId" = COALESCE($9::bigint, "shopeeDiscountId"),
            "syncedToShopee" = COALESCE($10, "syncedToShopee"),
            "shoppeeUpdateTime" = COALESCE($11, "shoppeeUpdateTime"),
            "updatedAt" = NOW()
          WHERE id = $1
          RETURNING
            id,
            "shopId" AS shop_id,
            "shopeeDiscountId" AS shopee_discount_id,
            name,
            status,
            "startTime" AS start_time,
            "endTime" AS end_time,
            "syncedToShopee" AS synced_to_shopee,
            "shoppeeUpdateTime" AS shoppee_update_time,
            description,
            tags,
            "createdAt" AS created_at,
            "updatedAt" AS updated_at
        `,
        [
          Number(where.id),
          data.name ?? null,
          data.startTime ?? null,
          data.endTime ?? null,
          data.description ?? null,
          Object.prototype.hasOwnProperty.call(data, "tags"),
          data.tags ?? null,
          data.status ?? null,
          data.shopeeDiscountId == null ? null : toBigIntString(data.shopeeDiscountId),
          Object.prototype.hasOwnProperty.call(data, "syncedToShopee")
            ? Boolean(data.syncedToShopee)
            : null,
          data.shoppeeUpdateTime ?? null,
        ],
      );
      return loadCampaignWithIncludes(mapCampaignRow(row), include || {});
    },
    async delete({ where }) {
      await query(
        `
          DELETE FROM "DiscountCampaign"
          WHERE id = $1
        `,
        [Number(where.id)],
      );
    },
  },
  discountItem: {
    async deleteMany({ where }) {
      const row = await queryOne(
        `
          DELETE FROM "DiscountItem"
          WHERE "campaignId" = $1
            AND "syncedToShopee" = $2
          RETURNING COUNT(*) OVER() AS affected
        `,
        [Number(where.campaignId), Boolean(where.syncedToShopee)],
      );
      return { count: Number(row?.affected || 0) };
    },
    async createMany({ data }) {
      if (!Array.isArray(data) || !data.length) {
        return { count: 0 };
      }

      const values = [];
      const tuples = data.map((item) => {
        values.push(
          Number(item.campaignId),
          toBigIntString(item.itemId),
          item.promotionPrice ?? null,
          item.modelId == null ? null : toBigIntString(item.modelId),
          item.modelPromotionPrice ?? null,
          item.promotionStock ?? null,
          item.modelPromotionStock ?? null,
          item.purchaseLimit ?? 0,
          item.productId == null ? null : Number(item.productId),
          Boolean(item.syncedToShopee),
        );
        const base = values.length - 9;
        return `($${base}, $${base + 1}::bigint, $${base + 2}, $${base + 3}::bigint, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
      });

      await query(
        `
          INSERT INTO "DiscountItem" (
            "campaignId",
            "itemId",
            "promotionPrice",
            "modelId",
            "modelPromotionPrice",
            "promotionStock",
            "modelPromotionStock",
            "purchaseLimit",
            "productId",
            "syncedToShopee"
          )
          VALUES ${tuples.join(", ")}
        `,
        values,
      );
      return { count: data.length };
    },
    async create({ data }) {
      const row = await queryOne(
        `
          INSERT INTO "DiscountItem" (
            "campaignId",
            "itemId",
            "promotionPrice",
            "modelId",
            "modelPromotionPrice",
            "promotionStock",
            "modelPromotionStock",
            "purchaseLimit",
            "productId"
          )
          VALUES ($1, $2::bigint, $3, $4::bigint, $5, $6, $7, $8, $9)
          RETURNING
            id,
            "campaignId" AS campaign_id,
            "itemId" AS item_id,
            "promotionPrice" AS promotion_price,
            "modelId" AS model_id,
            "modelPromotionPrice" AS model_promotion_price,
            "promotionStock" AS promotion_stock,
            "modelPromotionStock" AS model_promotion_stock,
            "purchaseLimit" AS purchase_limit,
            "productId" AS product_id,
            "syncedToShopee" AS synced_to_shopee,
            "createdAt" AS created_at,
            "updatedAt" AS updated_at
        `,
        [
          Number(data.campaignId),
          toBigIntString(data.itemId),
          data.promotionPrice ?? null,
          data.modelId == null ? null : toBigIntString(data.modelId),
          data.modelPromotionPrice ?? null,
          data.promotionStock ?? null,
          data.modelPromotionStock ?? null,
          data.purchaseLimit ?? 0,
          data.productId == null ? null : Number(data.productId),
        ],
      );
      return mapDiscountItemRow(row);
    },
    async findFirst({ where }) {
      const params = [
        Number(where.campaignId),
        toBigIntString(where.itemId),
      ];
      let sql = `
        SELECT
          id,
          "campaignId" AS campaign_id,
          "itemId" AS item_id,
          "promotionPrice" AS promotion_price,
          "modelId" AS model_id,
          "modelPromotionPrice" AS model_promotion_price,
          "promotionStock" AS promotion_stock,
          "modelPromotionStock" AS model_promotion_stock,
          "purchaseLimit" AS purchase_limit,
          "productId" AS product_id,
          "syncedToShopee" AS synced_to_shopee,
          "createdAt" AS created_at,
          "updatedAt" AS updated_at
        FROM "DiscountItem"
        WHERE "campaignId" = $1
          AND "itemId" = $2::bigint
      `;
      if (Object.prototype.hasOwnProperty.call(where, "modelId")) {
        params.push(where.modelId == null ? null : toBigIntString(where.modelId));
        sql += where.modelId == null
          ? ` AND "modelId" IS NULL`
          : ` AND "modelId" = $${params.length}::bigint`;
      }
      sql += ` LIMIT 1`;
      return mapDiscountItemRow(await queryOne(sql, params));
    },
    async update({ where, data }) {
      const row = await queryOne(
        `
          UPDATE "DiscountItem"
          SET
            "promotionPrice" = COALESCE($2::numeric, "promotionPrice"),
            "modelPromotionPrice" = COALESCE($3::numeric, "modelPromotionPrice"),
            "promotionStock" = COALESCE($4::int, "promotionStock"),
            "modelPromotionStock" = COALESCE($5::int, "modelPromotionStock"),
            "purchaseLimit" = COALESCE($6::int, "purchaseLimit"),
            "syncedToShopee" = COALESCE($7::boolean, "syncedToShopee"),
            "updatedAt" = NOW()
          WHERE id = $1
          RETURNING
            id,
            "campaignId" AS campaign_id,
            "itemId" AS item_id,
            "promotionPrice" AS promotion_price,
            "modelId" AS model_id,
            "modelPromotionPrice" AS model_promotion_price,
            "promotionStock" AS promotion_stock,
            "modelPromotionStock" AS model_promotion_stock,
            "purchaseLimit" AS purchase_limit,
            "productId" AS product_id,
            "syncedToShopee" AS synced_to_shopee,
            "createdAt" AS created_at,
            "updatedAt" AS updated_at
        `,
        [
          Number(where.id),
          data.promotionPrice ?? null,
          data.modelPromotionPrice ?? null,
          data.promotionStock ?? null,
          data.modelPromotionStock ?? null,
          data.purchaseLimit ?? null,
          Object.prototype.hasOwnProperty.call(data, "syncedToShopee")
            ? Boolean(data.syncedToShopee)
            : null,
        ],
      );
      return mapDiscountItemRow(row);
    },
    async delete({ where }) {
      await query(
        `
          DELETE FROM "DiscountItem"
          WHERE id = $1
        `,
        [Number(where.id)],
      );
    },
    async updateMany({ where, data }) {
      await query(
        `
          UPDATE "DiscountItem"
          SET
            "syncedToShopee" = COALESCE($2::boolean, "syncedToShopee"),
            "updatedAt" = NOW()
          WHERE "campaignId" = $1
        `,
        [
          Number(where.campaignId),
          Object.prototype.hasOwnProperty.call(data, "syncedToShopee")
            ? Boolean(data.syncedToShopee)
            : null,
        ],
      );
    },
  },
  oAuthToken: {
    async findUnique({ where, select }) {
      const row = await queryOne(
        `
          SELECT "accessToken" AS access_token
          FROM "OAuthToken"
          WHERE "shopId" = $1
          LIMIT 1
        `,
        [Number(where.shopId)],
      );
      if (!row) return null;
      return select?.accessToken ? { accessToken: row.access_token || null } : row;
    },
  },
};

module.exports = db;
