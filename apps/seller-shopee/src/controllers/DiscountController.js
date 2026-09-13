const db = require("../config/db");
const ShopeeDiscountService = require("../services/ShopeeDiscountService");
const { requestShopeeAuthed } = require("../services/ShopeeAuthedHttp");
const {
  listActivePriceLocksByItemIds,
} = require("../repositories/priceIncreaseSqlRepository");
const { formatRemainingFromLock } = require("../services/priceIncreasePolicyService");

async function getActiveShopOrFail(req, res) {
  if (!req.auth) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  const accountId = req.auth.accountId || null;
  const shopDbId = req.auth.activeShopId || null;

  if (shopDbId) {
    const activeShop = await db.shop.findFirst({
      where: { id: shopDbId, accountId },
    });
    if (activeShop) return activeShop;
  }

  const fallbackShop = await db.shop.findFirstByAccount({ accountId });
  if (fallbackShop) return fallbackShop;

  res.status(409).json({
    error: "select_shop_required",
    message: "Selecione uma loja para continuar.",
  });
  return null;
}

async function getPromotionBlockedItems(shopDbId, items = []) {
  const normalizedRows = (Array.isArray(items) ? items : [])
    .map((item) => ({
      itemId: String(item?.itemId || "").trim(),
      modelId: item?.modelId == null ? "" : String(item.modelId).trim(),
      title: item?.title || item?.itemName || null,
    }))
    .filter((item) => /^\d+$/.test(item.itemId));

  if (!normalizedRows.length) return [];

  const lockMap = await listActivePriceLocksByItemIds(
    shopDbId,
    normalizedRows.map((item) => item.itemId),
    new Date(),
  );

  const now = new Date();
  return normalizedRows
    .map((item) => {
      const lockEntry = lockMap.get(item.itemId);
      if (!lockEntry) return null;
      const remaining = formatRemainingFromLock(
        lockEntry.lockUntil ? new Date(lockEntry.lockUntil) : null,
        now,
      );
      if (!remaining.isBlocked) return null;
      return {
        ...item,
        lockUntil: lockEntry.lockUntil || null,
        remainingLabel: remaining.remainingLabel,
      };
    })
    .filter(Boolean);
}

function buildPromotionLockMessage(blockedRows = []) {
  if (!blockedRows.length) return "";
  const firstRows = blockedRows.slice(0, 6);
  const details = firstRows
    .map(
      (row) =>
        `Item ${row.itemId}${row.modelId ? ` / Modelo ${row.modelId}` : ""} (${row.remainingLabel})`,
    )
    .join("; ");
  const suffix =
    blockedRows.length > firstRows.length
      ? `; +${blockedRows.length - firstRows.length} item(ns)`
      : "";
  return `Produtos com aumento recente de preco estao bloqueados para promocao por 7 dias: ${details}${suffix}.`;
}

function fromUnixSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000);
}

function toCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function normalizeRemoteStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["upcoming", "ongoing", "expired"].includes(status)) return status;
  return "draft";
}

function getRemoteDiscountStatus(remote, fallbackStatus) {
  return normalizeRemoteStatus(
    remote?.status || remote?.discount_status || remote?.promotion_status || fallbackStatus,
  );
}

function assertShopeeDiscountResponse(payload, endpoint) {
  if (!payload || typeof payload !== "object") {
    throw new Error(`A Shopee nao retornou dados para ${endpoint}.`);
  }

  if (payload.error) {
    throw new Error(`Shopee ${endpoint} falhou: ${payload.message || payload.error}.`);
  }
}

function mapRemoteDiscountItemRows(remoteItems) {
  const rows = [];

  for (const item of Array.isArray(remoteItems) ? remoteItems : []) {
    const itemId = item?.item_id;
    if (!itemId) continue;

    const purchaseLimit = Number(item?.purchase_limit || 0) || 0;
    const modelList = Array.isArray(item?.model_list) ? item.model_list : [];

    if (modelList.length > 0) {
      for (const model of modelList) {
        if (!model?.model_id) continue;
        rows.push({
          itemId: BigInt(String(itemId)),
          modelId: BigInt(String(model.model_id)),
          promotionPrice: null,
          modelPromotionPrice: toCents(model.model_promotion_price),
          promotionStock: null,
          modelPromotionStock:
            Number(model.model_promotion_stock || 0) || null,
          purchaseLimit,
          syncedToShopee: true,
        });
      }
      continue;
    }

    rows.push({
      itemId: BigInt(String(itemId)),
      modelId: null,
      promotionPrice: toCents(item.item_promotion_price),
      modelPromotionPrice: null,
      promotionStock: Number(item.item_promotion_stock || 0) || null,
      modelPromotionStock: null,
      purchaseLimit,
      syncedToShopee: true,
    });
  }

  return rows;
}

async function fetchAllRemoteDiscounts(shop) {
  const discountsById = new Map();

  // The Shopee API paginates promotions by status. Asking for "all" can omit
  // campaigns depending on the shop's enabled channel/API version.
  for (const discountStatus of ["upcoming", "ongoing", "expired"]) {
    let pageNo = 1;
    let more = true;

    while (more) {
      const payload = await requestShopeeAuthed({
        method: "GET",
        path: "/api/v2/discount/get_discount_list",
        query: {
          discount_status: discountStatus,
          page_no: pageNo,
          page_size: 100,
        },
        shopId: String(shop.shopId),
      });
      assertShopeeDiscountResponse(payload, "get_discount_list");

      const response = payload.response || {};
      const page = Array.isArray(response.discount_list)
        ? response.discount_list
        : [];

      for (const discount of page) {
        const discountId = discount?.discount_id;
        if (!discountId) continue;
        discountsById.set(String(discountId), {
          ...discount,
          status: getRemoteDiscountStatus(discount, discountStatus),
        });
      }

      more = Boolean(response.more);
      pageNo += 1;
      if (pageNo > 100) {
        throw new Error("A paginacao de promocoes excedeu o limite de seguranca.");
      }
    }
  }

  return Array.from(discountsById.values());
}

async function fetchRemoteDiscountItems(shop, discountId) {
  const items = [];
  let pageNo = 1;
  let more = true;

  while (more) {
    const payload = await requestShopeeAuthed({
      method: "GET",
      path: "/api/v2/discount/get_discount",
      query: {
        discount_id: Number(discountId),
        page_no: pageNo,
        page_size: 100,
      },
      shopId: String(shop.shopId),
    });
    assertShopeeDiscountResponse(payload, "get_discount");

    const response = payload.response || {};
    const page = Array.isArray(response.item_list) ? response.item_list : [];

    items.push(...page);
    more = Boolean(response.more);
    pageNo += 1;
    if (pageNo > 100) {
      throw new Error(`A paginacao dos itens da promocao ${discountId} excedeu o limite de seguranca.`);
    }
  }

  return items;
}
async function syncRemoteCampaigns(shop) {
  const remoteDiscounts = await fetchAllRemoteDiscounts(shop);
  let syncedItems = 0;

  for (const remote of remoteDiscounts) {
    const shopeeDiscountId = remote?.discount_id;
    if (!shopeeDiscountId) continue;

    const startTime = fromUnixSeconds(remote.start_time);
    const endTime = fromUnixSeconds(remote.end_time);
    const name = String(remote.discount_name || "").trim() || `Promocao ${shopeeDiscountId}`;

    const campaign = await db.discountCampaign.upsert({
      where: { shopeeDiscountId: BigInt(String(shopeeDiscountId)) },
      update: {
        shopId: shop.id,
        name,
        status: getRemoteDiscountStatus(remote),
        startTime: startTime || new Date(),
        endTime: endTime || new Date(),
        syncedToShopee: true,
        shoppeeUpdateTime: new Date(),
      },
      create: {
        shopId: shop.id,
        shopeeDiscountId: BigInt(String(shopeeDiscountId)),
        name,
        status: getRemoteDiscountStatus(remote),
        startTime: startTime || new Date(),
        endTime: endTime || new Date(),
        syncedToShopee: true,
        shoppeeUpdateTime: new Date(),
      },
      select: { id: true },
    });

    const remoteItems = await fetchRemoteDiscountItems(shop, shopeeDiscountId);
    const itemRows = mapRemoteDiscountItemRows(remoteItems);

    await db.discountItem.deleteMany({
      where: { campaignId: campaign.id, syncedToShopee: true },
    });

    if (itemRows.length > 0) {
      await db.discountItem.createMany({
        data: itemRows.map((row) => ({
          campaignId: campaign.id,
          ...row,
        })),
      });
    }
    syncedItems += itemRows.length;
  }

  return {
    campaigns: remoteDiscounts.length,
    items: syncedItems,
  };
}

class DiscountController {
  /**
   * Listar campanhas de desconto
   * GET /api/discounts
   */
  async listCampaigns(req, res) {
    try {
      const shop = await getActiveShopOrFail(req, res);
      if (!shop) return;

      const shouldSync = String(req.query.sync || "") === "1";
      let syncSummary = null;
      if (shouldSync) {
        try {
          syncSummary = await syncRemoteCampaigns(shop);
        } catch (syncError) {
          console.error("Error syncing remote Shopee discounts:", syncError);
          return res.status(502).json({
            success: false,
            error: "Nao foi possivel sincronizar as promocoes da Shopee.",
            details: syncError.message,
          });
        }
      }

      const campaigns = await db.discountCampaign.findMany({
        where: { shopId: shop.id },
        include: {
          items: {
            select: {
              id: true,
              itemId: true,
              modelId: true,
              promotionPrice: true,
              modelPromotionPrice: true,
              promotionStock: true,
              purchaseLimit: true,
              syncedToShopee: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      res.json({ success: true, data: campaigns, sync: syncSummary });
    } catch (error) {
      console.error("Error listing campaigns:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Criar nova campanha de desconto
   * POST /api/discounts
   */
  async createCampaign(req, res) {
    try {
      const shop = await getActiveShopOrFail(req, res);
      if (!shop) return;

      const { name, startTime, endTime, description, tags, items } =
        req.body;

      if (!name || !startTime || !endTime) {
        return res.status(400).json({
          success: false,
          error: "name, startTime e endTime são obrigatórios",
        });
      }

      // Validar datas
      const start = new Date(startTime);
      const end = new Date(endTime);
      const now = new Date();

      if (start <= now) {
        return res.status(400).json({
          success: false,
          error: "Data de início deve ser no futuro (mínimo 1 hora)",
        });
      }

      if (end <= start) {
        return res.status(400).json({
          success: false,
          error: "Data de fim deve ser após data de início (mínimo 1 hora)",
        });
      }

      // Calcular duração em dias
      const durationDays = (end - start) / (1000 * 60 * 60 * 24);
      if (durationDays > 180) {
        return res.status(400).json({
          success: false,
          error: "Campanha não pode durar mais de 180 dias",
        });
      }

      if (items && Array.isArray(items) && items.length > 0) {
        const blockedRows = await getPromotionBlockedItems(shop.id, items);
        if (blockedRows.length) {
          return res.status(409).json({
            success: false,
            error: "promotion_lock_active",
            message: buildPromotionLockMessage(blockedRows),
            blockedItems: blockedRows,
          });
        }
      }

      // Criar campanha
      const campaign = await db.discountCampaign.create({
        data: {
          shopId: Number(shop.id),
          name,
          startTime: start,
          endTime: end,
          description,
          tags: tags ? JSON.stringify(tags) : null,
          status: "draft",
        },
        include: { items: true },
      });

      // Adicionar itens se fornecidos
      if (items && Array.isArray(items) && items.length > 0) {
        const itemsToCreate = items.map((item) => ({
          campaignId: campaign.id,
          itemId: BigInt(item.itemId),
          modelId: item.modelId ? BigInt(item.modelId) : null,
          promotionPrice: item.promotionPrice || null,
          modelPromotionPrice: item.modelPromotionPrice || null,
          promotionStock: item.promotionStock || null,
          modelPromotionStock: item.modelPromotionStock || null,
          purchaseLimit: item.purchaseLimit || 0,
          productId: item.productId || null,
        }));

        await db.discountItem.createMany({
          data: itemsToCreate,
        });
      }

      // Buscar campanha com itens
      const updatedCampaign = await db.discountCampaign.findUnique({
        where: { id: campaign.id },
        include: { items: true },
      });

      res.json({ success: true, data: updatedCampaign });
    } catch (error) {
      console.error("Error creating campaign:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Obter detalhes da campanha
   * GET /api/discounts/:id
   */
  async getCampaign(req, res) {
    try {
      const { id } = req.params;

      const campaign = await db.discountCampaign.findUnique({
        where: { id: parseInt(id) },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  title: true,
                  priceMin: true,
                  priceMax: true,
                },
              },
            },
          },
        },
      });

      if (!campaign)
        return res
          .status(404)
          .json({ success: false, error: "Campanha não encontrada" });

      res.json({ success: true, data: campaign });
    } catch (error) {
      console.error("Error getting campaign:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Atualizar campanha
   * PUT /api/discounts/:id
   */
  async updateCampaign(req, res) {
    try {
      const { id } = req.params;
      const { name, startTime, endTime, description, tags, status } = req.body;

      const campaign = await db.discountCampaign.findUnique({
        where: { id: parseInt(id) },
      });

      if (!campaign)
        return res
          .status(404)
          .json({ success: false, error: "Campanha não encontrada" });

      // Se campanha já está sincronizada com Shopee, há restrições
      if (campaign.syncedToShopee && campaign.status === "ongoing") {
        return res.status(400).json({
          success: false,
          error:
            "Não é possível alterar data de início de campanha em andamento",
        });
      }

      const updated = await db.discountCampaign.update({
        where: { id: parseInt(id) },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(startTime ? { startTime: new Date(startTime) } : {}),
          ...(endTime ? { endTime: new Date(endTime) } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(tags !== undefined ? { tags: tags ? JSON.stringify(tags) : null } : {}),
          ...(status !== undefined ? { status } : {}),
        },
        include: { items: true },
      });

      res.json({ success: true, data: updated });
    } catch (error) {
      console.error("Error updating campaign:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Duplicar campanha
   * POST /api/discounts/:id/duplicate
   */
  async duplicateCampaign(req, res) {
    try {
      const { id } = req.params;
      const { newName, newStartTime, newEndTime } = req.body;

      const campaign = await db.discountCampaign.findUnique({
        where: { id: parseInt(id) },
        include: { items: true },
      });

      if (!campaign)
        return res
          .status(404)
          .json({ success: false, error: "Campanha não encontrada" });

      // Criar nova campanha
      const newCampaign = await db.discountCampaign.create({
        data: {
          shopId: campaign.shopId,
          name: newName || `${campaign.name} (Cópia)`,
          startTime: newStartTime ? new Date(newStartTime) : campaign.startTime,
          endTime: newEndTime ? new Date(newEndTime) : campaign.endTime,
          description: campaign.description,
          tags: campaign.tags,
          status: "draft",
        },
      });

      // Copiar itens
      if (campaign.items && campaign.items.length > 0) {
        const itemsToCreate = campaign.items.map((item) => ({
          campaignId: newCampaign.id,
          itemId: item.itemId,
          modelId: item.modelId,
          promotionPrice: item.promotionPrice,
          modelPromotionPrice: item.modelPromotionPrice,
          promotionStock: item.promotionStock,
          modelPromotionStock: item.modelPromotionStock,
          purchaseLimit: item.purchaseLimit,
          productId: item.productId,
        }));

        await db.discountItem.createMany({
          data: itemsToCreate,
        });
      }

      const result = await db.discountCampaign.findUnique({
        where: { id: newCampaign.id },
        include: { items: true },
      });

      res.json({ success: true, data: result });
    } catch (error) {
      console.error("Error duplicating campaign:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Adicionar itens à campanha
   * POST /api/discounts/:id/items
   */
  async addItems(req, res) {
    try {
      const { id } = req.params;
      const { items } = req.body;

      const campaign = await db.discountCampaign.findUnique({
        where: { id: parseInt(id) },
      });

      if (!campaign)
        return res
          .status(404)
          .json({ success: false, error: "Campanha não encontrada" });

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
          success: false,
          error: "Itens são obrigatórios",
        });
      }

      const blockedRows = await getPromotionBlockedItems(campaign.shopId, items);
      if (blockedRows.length) {
        return res.status(409).json({
          success: false,
          error: "promotion_lock_active",
          message: buildPromotionLockMessage(blockedRows),
          blockedItems: blockedRows,
        });
      }

      const createdItems = [];
      const errors = [];

      for (const item of items) {
        try {
          const created = await db.discountItem.create({
            data: {
              campaignId: campaign.id,
              itemId: BigInt(item.itemId),
              modelId: item.modelId ? BigInt(item.modelId) : null,
              promotionPrice: item.promotionPrice || null,
              modelPromotionPrice: item.modelPromotionPrice || null,
              promotionStock: item.promotionStock || null,
              modelPromotionStock: item.modelPromotionStock || null,
              purchaseLimit: item.purchaseLimit || 0,
              productId: item.productId || null,
            },
          });
          createdItems.push(created);
        } catch (err) {
          errors.push({
            itemId: item.itemId,
            modelId: item.modelId,
            error: err.message,
          });
        }
      }

      res.json({
        success: true,
        data: {
          count: createdItems.length,
          items: createdItems,
          errors: errors.length > 0 ? errors : null,
        },
      });
    } catch (error) {
      console.error("Error adding items:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Atualizar item da campanha
   * PUT /api/discounts/:campaignId/items/:itemId
   */
  async updateItem(req, res) {
    try {
      const { campaignId, itemId } = req.params;
      const {
        modelId,
        promotionPrice,
        modelPromotionPrice,
        promotionStock,
        modelPromotionStock,
        purchaseLimit,
      } = req.body;

      const item = await db.discountItem.findFirst({
        where: {
          campaignId: parseInt(campaignId),
          itemId: BigInt(itemId),
          ...(modelId ? { modelId: BigInt(String(modelId)) } : {}),
        },
      });

      if (!item)
        return res
          .status(404)
          .json({ success: false, error: "Item não encontrado" });

      const updated = await db.discountItem.update({
        where: { id: item.id },
        data: {
          ...(promotionPrice !== undefined &&
            item.modelId == null && {
              promotionPrice,
            }),
          ...(modelPromotionPrice !== undefined &&
            item.modelId != null && {
              modelPromotionPrice,
            }),
          ...(promotionPrice !== undefined &&
            item.modelId != null && {
              modelPromotionPrice: promotionPrice,
            }),
          ...(promotionStock !== undefined &&
            item.modelId == null && {
              promotionStock,
            }),
          ...(modelPromotionStock !== undefined &&
            item.modelId != null && {
              modelPromotionStock,
            }),
          ...(promotionStock !== undefined &&
            item.modelId != null && {
              modelPromotionStock: promotionStock,
            }),
          ...(purchaseLimit !== undefined && {
            purchaseLimit,
          }),
        },
      });

      res.json({ success: true, data: updated });
    } catch (error) {
      console.error("Error updating item:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Remover item da campanha
   * DELETE /api/discounts/:campaignId/items/:itemId
   */
  async removeItem(req, res) {
    try {
      const { campaignId, itemId } = req.params;
      const { modelId } = req.query;

      const item = await db.discountItem.findFirst({
        where: {
          campaignId: parseInt(campaignId),
          itemId: BigInt(itemId),
          ...(modelId && {
            modelId: BigInt(modelId),
          }),
        },
      });

      if (!item)
        return res
          .status(404)
          .json({ success: false, error: "Item não encontrado" });

      await db.discountItem.delete({
        where: { id: item.id },
      });

      res.json({
        success: true,
        data: { message: "Item removido com sucesso" },
      });
    } catch (error) {
      console.error("Error removing item:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Encerrar campanha
   * POST /api/discounts/:id/end
   */
  async endCampaign(req, res) {
    try {
      const { id } = req.params;

      const campaign = await db.discountCampaign.findUnique({
        where: { id: parseInt(id) },
        include: { Shop: true },
      });

      if (!campaign)
        return res
          .status(404)
          .json({ success: false, error: "Campanha não encontrada" });

      if (campaign.status !== "ongoing") {
        return res.status(400).json({
          success: false,
          error: "Apenas campanhas em andamento podem ser encerradas",
        });
      }

      // Chamar API Shopee para encerrar
      if (campaign.shopeeDiscountId && campaign.syncedToShopee) {
        try {
          const tokenRow = await db.oAuthToken.findUnique({
            where: { shopId: campaign.shopId },
            select: { accessToken: true },
          });

          if (tokenRow?.accessToken) {
            await ShopeeDiscountService.endDiscount({
              accessToken: tokenRow.accessToken,
              shopId: campaign.Shop.shopId,
              discountId: Number(campaign.shopeeDiscountId),
            });
          }
        } catch (err) {
          console.error("Error calling Shopee API:", err);
          // Continua mesmo se Shopee falhar
        }
      }

      const updated = await db.discountCampaign.update({
        where: { id: parseInt(id) },
        data: { status: "expired" },
      });

      res.json({ success: true, data: updated });
    } catch (error) {
      console.error("Error ending campaign:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Publicar campanha (sincronizar com Shopee)
   * POST /api/discounts/:id/publish
   */
  async publishCampaign(req, res) {
    try {
      const { id } = req.params;

      const campaign = await db.discountCampaign.findUnique({
        where: { id: parseInt(id) },
        include: { items: true, Shop: true },
      });

      if (!campaign)
        return res
          .status(404)
          .json({ success: false, error: "Campanha não encontrada" });

      if (campaign.status !== "draft") {
        return res.status(400).json({
          success: false,
          error: "Apenas campanhas em rascunho podem ser publicadas",
        });
      }

      if (campaign.items.length === 0) {
        return res.status(400).json({
          success: false,
          error: "Campanha deve ter pelo menos um item",
        });
      }

      const blockedRows = await getPromotionBlockedItems(
        campaign.shopId,
        campaign.items.map((item) => ({
          itemId: item.itemId,
          modelId: item.modelId,
          title: item?.product?.title || null,
        })),
      );
      if (blockedRows.length) {
        return res.status(409).json({
          success: false,
          error: "promotion_lock_active",
          message: buildPromotionLockMessage(blockedRows),
          blockedItems: blockedRows,
        });
      }

      // Obter token de acesso da loja
      const tokenRow = await db.oAuthToken.findUnique({
        where: { shopId: campaign.shopId },
        select: { accessToken: true },
      });

      if (!tokenRow?.accessToken) {
        return res.status(400).json({
          success: false,
          error: "Loja não possui access token configurado",
        });
      }

      try {
        // Criar desconto no Shopee
        const discountResponse = await ShopeeDiscountService.addDiscount({
          accessToken: tokenRow.accessToken,
          shopId: campaign.Shop.shopId,
          campaign: {
            name: campaign.name,
            startTime: campaign.startTime,
            endTime: campaign.endTime,
            description: campaign.description,
          },
        });

        if (!discountResponse.success) {
          throw new Error(JSON.stringify(discountResponse.error));
        }

        const shopeeDiscountId = discountResponse.data?.response?.discount_id;

        if (!shopeeDiscountId) {
          throw new Error("Shopee não retornou discount_id");
        }

        // Adicionar itens ao desconto no Shopee
        const itemsResponse = await ShopeeDiscountService.addDiscountItems({
          accessToken: tokenRow.accessToken,
          shopId: campaign.Shop.shopId,
          discountId: shopeeDiscountId,
          items: campaign.items.map((item) => ({
            itemId: item.itemId,
            modelId: item.modelId,
            promotionPrice: item.promotionPrice,
            purchaseLimit: item.purchaseLimit || 0,
          })),
        });

        if (!itemsResponse.success) {
          console.warn("Aviso ao adicionar itens:", itemsResponse.error);
          // Continua mesmo com erro parcial
        }

        // Atualizar campanha no banco
        const updated = await db.discountCampaign.update({
          where: { id: parseInt(id) },
          data: {
            shopeeDiscountId: BigInt(shopeeDiscountId),
            status: "upcoming",
            syncedToShopee: true,
            shoppeeUpdateTime: new Date(),
          },
          include: { items: true },
        });

        // Marcar itens como sincronizados
        await db.discountItem.updateMany({
          where: { campaignId: campaign.id },
          data: { syncedToShopee: true },
        });

        res.json({ success: true, data: updated });
      } catch (shopeeError) {
        console.error("Error syncing with Shopee:", shopeeError);
        res.status(400).json({
          success: false,
          error: `Erro ao sincronizar com Shopee: ${shopeeError.message}`,
        });
      }
    } catch (error) {
      console.error("Error publishing campaign:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Excluir campanha
   * DELETE /api/discounts/:id
   */
  async deleteCampaign(req, res) {
    try {
      const { id } = req.params;

      const campaign = await db.discountCampaign.findUnique({
        where: { id: parseInt(id) },
        include: { Shop: true },
      });

      if (!campaign)
        return res
          .status(404)
          .json({ success: false, error: "Campanha não encontrada" });

      // Se sincronizado com Shopee e em andamento, tentar deletar lá também
      if (campaign.syncedToShopee && campaign.shopeeDiscountId) {
        try {
          const tokenRow = await db.oAuthToken.findUnique({
            where: { shopId: campaign.shopId },
            select: { accessToken: true },
          });

          if (tokenRow?.accessToken) {
            // Tentar encerrar primeiro se em andamento
            if (campaign.status === "ongoing") {
              await ShopeeDiscountService.endDiscount({
                accessToken: tokenRow.accessToken,
                shopId: campaign.Shop.shopId,
                discountId: Number(campaign.shopeeDiscountId),
              });
            }

            // Depois deletar (apenas em rascunho)
            if (campaign.status === "draft") {
              await ShopeeDiscountService.deleteDiscount({
                accessToken: tokenRow.accessToken,
                shopId: campaign.Shop.shopId,
                discountId: Number(campaign.shopeeDiscountId),
              });
            }
          }
        } catch (err) {
          console.error("Error deleting from Shopee:", err);
          // Continua mesmo se falhar
        }
      }

      // Deletar do banco
      await db.discountCampaign.delete({
        where: { id: parseInt(id) },
      });

      res.json({
        success: true,
        data: { message: "Campanha deletada com sucesso" },
      });
    } catch (error) {
      console.error("Error deleting campaign:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Exportar campanhas para CSV/JSON
   * GET /api/discounts/export?format=json&shopId=123
   */
  async exportCampaigns(req, res) {
    try {
      const { format = "json", shopId } = req.query;

      if (!shopId)
        return res.status(400).json({
          success: false,
          error: "shopId é obrigatório",
        });

      const campaigns = await db.discountCampaign.findMany({
        where: { shopId: parseInt(shopId) },
        include: { items: true },
      });

      if (format === "csv") {
        // Gerar CSV
        const csv = this.generateCSV(campaigns);
        res.set("Content-Type", "text/csv");
        res.set("Content-Disposition", 'attachment; filename="campaigns.csv"');
        res.send(csv);
      } else {
        // JSON
        res.set("Content-Type", "application/json");
        res.set("Content-Disposition", 'attachment; filename="campaigns.json"');
        res.json(campaigns);
      }
    } catch (error) {
      console.error("Error exporting campaigns:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Importar campanhas de arquivo
   * POST /api/discounts/import
   */
  async importCampaigns(req, res) {
    try {
      const { shopId, campaigns } = req.body;

      if (!shopId || !campaigns || !Array.isArray(campaigns)) {
        return res.status(400).json({
          success: false,
          error: "shopId e campaigns array são obrigatórios",
        });
      }

      const created = [];
      const errors = [];

      for (const campaignData of campaigns) {
        try {
          const campaign = await db.discountCampaign.create({
            data: {
              shopId: parseInt(shopId),
              name: campaignData.name,
              startTime: new Date(campaignData.startTime),
              endTime: new Date(campaignData.endTime),
              description: campaignData.description,
              tags: campaignData.tags
                ? JSON.stringify(campaignData.tags)
                : null,
              status: "draft",
            },
          });

          // Adicionar itens
          if (campaignData.items && Array.isArray(campaignData.items)) {
            const items = campaignData.items.map((item) => ({
              campaignId: campaign.id,
              itemId: BigInt(item.itemId),
              modelId: item.modelId ? BigInt(item.modelId) : null,
              promotionPrice: item.promotionPrice || null,
              modelPromotionPrice: item.modelPromotionPrice || null,
              promotionStock: item.promotionStock || null,
              modelPromotionStock: item.modelPromotionStock || null,
              purchaseLimit: item.purchaseLimit || 0,
              productId: item.productId || null,
            }));

            await db.discountItem.createMany({
              data: items,
            });
          }

          const result = await db.discountCampaign.findUnique({
            where: { id: campaign.id },
            include: { items: true },
          });

          created.push(result);
        } catch (err) {
          errors.push({
            name: campaignData.name,
            error: err.message,
          });
        }
      }

      res.json({
        success: true,
        data: {
          count: created.length,
          campaigns: created,
          errors: errors.length > 0 ? errors : null,
        },
      });
    } catch (error) {
      console.error("Error importing campaigns:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Gerar CSV a partir das campanhas
   */
  generateCSV(campaigns) {
    const headers = [
      "ID",
      "Nome",
      "Status",
      "Data Início",
      "Data Fim",
      "Item ID",
      "Model ID",
      "Preço Promoção",
      "Preço Promoção (Modelo)",
      "Stock Promoção",
      "Limite Compra",
    ];

    const rows = [];

    campaigns.forEach((campaign) => {
      if (campaign.items.length === 0) {
        rows.push([
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.startTime.toISOString().split("T")[0],
          campaign.endTime.toISOString().split("T")[0],
          "",
          "",
          "",
          "",
          "",
          "",
        ]);
      } else {
        campaign.items.forEach((item) => {
          rows.push([
            campaign.id,
            campaign.name,
            campaign.status,
            campaign.startTime.toISOString().split("T")[0],
            campaign.endTime.toISOString().split("T")[0],
            item.itemId,
            item.modelId || "",
            item.promotionPrice || "",
            item.modelPromotionPrice || "",
            item.promotionStock || "",
            item.purchaseLimit,
          ]);
        });
      }
    });

    let csv = headers.join(",") + "\n";
    rows.forEach((row) => {
      csv +=
        row
          .map((cell) =>
            typeof cell === "string" && cell.includes(",") ? `"${cell}"` : cell,
          )
          .join(",") + "\n";
    });

    return csv;
  }
}

module.exports = new DiscountController();
