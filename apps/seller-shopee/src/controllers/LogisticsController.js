const ShopeeLogisticsService = require("../services/ShopeeLogisticsService");
const { resolveShop } = require("../utils/resolveShop");
const {
  analyzeLogistics,
  analyzeSpxPhysicalEligibility,
  buildSpxSnapshot,
} = require("../utils/productLogistics");
const {
  listProductsByShopAndItemIdsForLogistics,
  listProductsByShopAndItemIdsForLogisticsAnyStatus,
  listProductsForLogistics,
  updateProductById,
} = require("../repositories/productSqlRepository");

function normalizeProductStatus(status) {
  return String(status || "").trim().toUpperCase();
}

function isActiveProductStatus(status) {
  const normalized = normalizeProductStatus(status);
  return normalized === "NORMAL" || normalized === "ACTIVE";
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function normalizeNumericItemIds(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter((value) => /^\d+$/.test(value)),
    ),
  );
}

const LOGISTICS_MAPPING_LABEL_BY_KIND = {
  seller: "Logística do vendedor",
  spx: "Shopee Xpress",
  pickup: "Retire perto de você",
};

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function parseMappingKinds(rawValue) {
  const tokens = String(rawValue || "")
    .split(",")
    .map((token) => normalizeText(token))
    .filter(Boolean);

  const kinds = new Set();
  const invalid = [];

  for (const token of tokens) {
    if (
      token === "logistica do vendedor" ||
      token === "seller" ||
      token === "seller logistics" ||
      token === "central logistica"
    ) {
      kinds.add("seller");
      continue;
    }
    if (
      token === "shopee xpress" ||
      token === "spx" ||
      token === "expresso aereo"
    ) {
      kinds.add("spx");
      continue;
    }
    if (
      token === "retire perto de voce" ||
      token === "retire perto de voce." ||
      token === "retire perto de você" ||
      token === "pickup" ||
      token === "retire"
    ) {
      kinds.add("pickup");
      continue;
    }
    invalid.push(token);
  }

  return {
    kinds: Array.from(kinds),
    invalid,
  };
}

function isLogisticsKindEnabled(summary, kind) {
  if (kind === "seller") return hasSellerLogisticsEnabled(summary);
  return Array.isArray(summary?.logistics)
    ? summary.logistics.some(
        (channel) => channel?.kind === kind && Boolean(channel?.enabled),
      )
    : false;
}

async function fetchLiveInfoByItemId(shopShopeeId, itemIds, contextLabel) {
  if (!shopShopeeId) return new Map();

  const normalizedItemIds = Array.from(
    new Set(
      (Array.isArray(itemIds) ? itemIds : [])
        .map((value) => String(value || "").trim())
        .filter((value) => /^\d+$/.test(value)),
    ),
  );
  const liveInfoByItemId = new Map();

  if (!normalizedItemIds.length) return liveInfoByItemId;

  for (const batch of chunk(normalizedItemIds, 20)) {
    try {
      const liveItems = await ShopeeLogisticsService.getProductsBaseInfo({
        shopId: String(shopShopeeId),
        itemIds: batch,
      });

      for (const item of liveItems) {
        if (item?.item_id == null) continue;
        liveInfoByItemId.set(String(item.item_id), item);
      }
    } catch (err) {
      console.warn(`[LogisticsController.${contextLabel}] failed to fetch live product`, {
        shopId: String(shopShopeeId),
        itemIds: batch,
        message: err?.shopee?.message || err?.message || "unknown_error",
      });
    }
  }

  return liveInfoByItemId;
}

function setChannelEnabled(rawChannel, enabled) {
  const next = { ...rawChannel };
  next.enabled = Boolean(enabled);
  if ("is_enabled" in next) next.is_enabled = Boolean(enabled);
  return next;
}

function getCachedReasons(product, fallbackReasons) {
  return Array.isArray(product.spxEligibilityReasonsCache)
    ? product.spxEligibilityReasonsCache
    : fallbackReasons;
}

function hasSellerLogisticsEnabled(summary) {
  return (
    Array.isArray(summary?.intelipostChannels) &&
    summary.intelipostChannels.some((channel) => channel?.enabled)
  );
}

function isSellerEligible(summary) {
  return (
    Array.isArray(summary?.intelipostChannels) &&
    summary.intelipostChannels.length > 0 &&
    !hasSellerLogisticsEnabled(summary)
  );
}

function hasDualLogisticsConflict(summary) {
  return Boolean(summary?.spxEnabled) && Boolean(summary?.heavyEnabled);
}

function summarizeProduct(product) {
  const logisticsAnalysis = analyzeLogistics(product.logistics);
  const physicalAnalysis = analyzeSpxPhysicalEligibility({
    logistics: product.logistics,
    dimension: product.dimension,
    weight: product.weight,
  });
  const hasLiveVerification = Boolean(product.spxLiveVerified);
  const hasSnapshot = Boolean(product.spxSnapshotAt) && !hasLiveVerification;

  const shippingMode =
    hasSnapshot && typeof product.shippingModeCache === "string"
      ? product.shippingModeCache
      : logisticsAnalysis.shippingMode;
  const spxEnabled = hasSnapshot
    ? Boolean(product.spxEnabledCache)
    : logisticsAnalysis.spxEnabled;
  const spxLogisticsEligible = hasSnapshot
    ? Boolean(product.spxLogisticsEligibleCache)
    : logisticsAnalysis.spxEligible;
  const spxPhysicalEligible = hasSnapshot
    ? Boolean(product.spxPhysicalEligibleCache)
    : physicalAnalysis.eligible;
  const spxEligibilityReasons = hasSnapshot
    ? getCachedReasons(product, physicalAnalysis.reasons)
    : physicalAnalysis.reasons;
  const spxEligible = hasSnapshot
    ? Boolean(product.spxEligibleCache)
    : Boolean(spxLogisticsEligible && spxPhysicalEligible);

  return {
    productDbId: product.id,
    itemId: String(product.itemId),
    title: product.title || null,
    status: product.status || null,
    dimension: product.dimension || null,
    weight: product.weight ?? null,
    logistics: logisticsAnalysis.logistics,
    spxChannel: logisticsAnalysis.spxChannel,
    pickupChannel: logisticsAnalysis.pickupChannel,
    intelipostChannels: logisticsAnalysis.intelipostChannels,
    shippingChannels: logisticsAnalysis.shippingChannels,
    shippingKinds: logisticsAnalysis.shippingKinds,
    shippingMode,
    spxEnabled,
    spxLogisticsEligible,
    spxPhysicalEligible,
    spxEligibilityReasons,
    spxEligibilityMetrics: physicalAnalysis.metrics,
    spxEligible,
    spxLiveVerified: hasLiveVerification,
    heavyChannel: logisticsAnalysis.heavyChannel,
    heavyEnabled: logisticsAnalysis.heavyEnabled,
    availableKinds: publicKinds(logisticsAnalysis.availableKinds),
    enabledKinds: publicKinds(logisticsAnalysis.enabledKinds),
  };
}

function mergeLiveProduct(product, live) {
  if (!live) return product;
  return {
    ...product,
    title: live.item_name || product.title,
    status: live.item_status || product.status,
    logistics: Array.isArray(live.logistic_info) ? live.logistic_info : product.logistics,
    dimension: live.dimension || product.dimension,
    weight: live.weight != null ? Number(live.weight) : product.weight,
    spxLiveVerified: true,
  };
}

function publicKinds(kinds) {
  return kinds.map((kind) => (kind === "intelipost" ? "seller" : kind));
}

function configurationErrorMessage(errors) {
  return errors.map((error) => error.message).join(" ") ||
    "Configuracao logistica invalida para este produto.";
}

async function configureProducts({
  products,
  liveInfoByItemId,
  targetKinds,
  shopShopeeId,
  updateRemote,
  updateLocal,
}) {
  const results = [];
  const activeTotals = { seller: 0, spx: 0, heavy: 0 };
  let success = 0;
  let failed = 0;
  const liveByItemId = liveInfoByItemId instanceof Map ? liveInfoByItemId : new Map();

  for (const product of Array.isArray(products) ? products : []) {
    const itemId = String(product?.itemId || "");
    const sourceProduct = mergeLiveProduct(product, liveByItemId.get(itemId));
    const plan = buildTargetLogistics({
      logistics: sourceProduct.logistics || [],
      targetKinds,
    });
    const sourceAnalysis = analyzeLogistics(sourceProduct.logistics || []);
    const result = {
      itemId,
      title: sourceProduct.title || null,
      status: sourceProduct.status || null,
      availableKinds: publicKinds(sourceAnalysis.availableKinds),
      enabledKinds: publicKinds(sourceAnalysis.enabledKinds),
      errors: plan.errors,
    };

    if (!plan.ok) {
      failed += 1;
      results.push({ ...result, ok: false, message: configurationErrorMessage(plan.errors) });
      continue;
    }

    try {
      await updateRemote({ shopId: String(shopShopeeId), itemId, logistics: plan.logistics });
      await updateLocal(product.id, {
        logistics: plan.logistics,
        ...buildSpxSnapshot({
          logistics: plan.logistics,
          dimension: sourceProduct.dimension,
          weight: sourceProduct.weight,
        }).cache,
      });

      const enabledKinds = publicKinds(analyzeLogistics(plan.logistics).enabledKinds);
      for (const kind of ["seller", "spx", "heavy"]) {
        if (enabledKinds.includes(kind)) activeTotals[kind] += 1;
      }
      success += 1;
      results.push({
        ...result,
        ok: true,
        changed: plan.changed,
        enabledKinds,
        message: plan.changed
          ? "Configuracao logistica aplicada com sucesso."
          : "Produto ja estava na configuracao logistica desejada.",
      });
    } catch (err) {
      failed += 1;
      results.push({
        ...result,
        ok: false,
        message: err?.shopee?.message || err?.message ||
          "Falha ao atualizar a logistica do produto.",
      });
    }
  }

  return {
    ok: success > 0,
    totalRequested: results.length,
    success,
    failed,
    activeTotals,
    results,
  };
}


async function ensureSpxCache(products) {
  const staleProducts = products.filter((product) => !product.spxSnapshotAt);

  if (!staleProducts.length) return;

  await Promise.all(
    staleProducts.map((product) =>
      updateProductById(
        product.id,
        buildSpxSnapshot({
          logistics: product.logistics,
          dimension: product.dimension,
          weight: product.weight,
        }).cache,
      ),
    ),
  );
}

async function getActiveShopOrFail(req, res) {
  try {
    return await resolveShop(req, "active");
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      error:
        err.statusCode === 400
          ? "select_shop_required"
          : err.statusCode === 404
            ? "shop_not_found"
            : "logistics_shop_resolve_failed",
      message: err.message || "Falha ao resolver a loja ativa.",
    });
  }
}

async function list(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop?.id) return;

  const products = (await listProductsForLogistics(shop.id)).filter((product) =>
    isActiveProductStatus(product?.status),
  );
  await ensureSpxCache(products);

  const liveInfoByItemId = await fetchLiveInfoByItemId(
    shop.shopId,
    products.map((product) => product?.itemId),
    "list",
  );

  const liveAwareProducts = products.map((product) => {
    const live = liveInfoByItemId.get(String(product.itemId));
    if (!live) return product;

    return {
      ...product,
      title: live.item_name || product.title,
      status: live.item_status || product.status,
      logistics: live.logistic_info || product.logistics,
      dimension: live.dimension || product.dimension,
      weight: live.weight != null ? Number(live.weight) : product.weight,
      spxLiveVerified: true,
    };
  });

  const summarized = liveAwareProducts.map((product) => summarizeProduct(product));

  return res.json({
    products: { all: summarized },
    spx: {
      enabled: summarized.filter((product) => product.spxEnabled),
      eligible: summarized.filter((product) => product.spxEligible),
      unavailable: summarized.filter((product) => !product.availableKinds.includes("spx")),
    },
    heavy: {
      enabled: summarized.filter((product) => product.heavyEnabled),
      eligible: summarized.filter((product) => product.availableKinds.includes("heavy") && !product.heavyEnabled),
      unavailable: summarized.filter((product) => !product.availableKinds.includes("heavy")),
    },
    seller: {
      enabled: summarized.filter(
        (product) => hasSellerLogisticsEnabled(product),
      ),
      eligible: summarized.filter((product) => isSellerEligible(product)),
      unavailable: summarized.filter((product) => !product.availableKinds.includes("seller")),
    },
  });
}

async function enableSpx(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop?.id) return;
  const normalizedItemIds = normalizeNumericItemIds(req.body?.itemIds);

  if (!normalizedItemIds.length) {
    return res.status(400).json({
      error: "bad_request",
      message: "Informe ao menos um item elegivel para ativar SPX e Expresso Aereo.",
    });
  }

  const products = (
    await listProductsByShopAndItemIdsForLogistics(shop.id, normalizedItemIds)
  ).filter((product) => isActiveProductStatus(product?.status));
  const liveInfoByItemId = await fetchLiveInfoByItemId(
    shop.shopId,
    normalizedItemIds,
    "enableSpx",
  );

  const results = [];

  for (const product of products) {
    const live = liveInfoByItemId.get(String(product.itemId));
    const summary = summarizeProduct(
      live
        ? {
            ...product,
            title: live.item_name || product.title,
            status: live.item_status || product.status,
            logistics: live.logistic_info || product.logistics,
            dimension: live.dimension || product.dimension,
            weight: live.weight != null ? Number(live.weight) : product.weight,
            spxLiveVerified: true,
          }
        : product,
    );

    if (!summary.spxChannel) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: false,
        message: "Produto sem canal Shopee Xpress ou Expresso Aereo na logistica sincronizada.",
      });
      continue;
    }

    if (!summary.spxPhysicalEligible) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: false,
        message:
          summary.spxEligibilityReasons.join(" ") ||
          "Produto fora das regras fisicas do SPX e Expresso Aereo.",
      });
      continue;
    }

    const target = buildTargetLogistics({
      logistics: summary.logistics.map((channel) => channel.raw),
      targetKinds: ["seller", "spx"],
    });
    if (!target.ok) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: false,
        message: configurationErrorMessage(target.errors),
      });
      continue;
    }
    const updatedLogistics = target.logistics;
    try {
      await ShopeeLogisticsService.updateProductLogistics({
        shopId: String(shop.shopId),
        itemId: String(product.itemId),
        logistics: updatedLogistics,
      });

      await updateProductById(product.id, {
          logistics: updatedLogistics,
          ...buildSpxSnapshot({
            logistics: updatedLogistics,
            dimension: summary.dimension,
            weight: summary.weight,
          }).cache,
      });

      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: true,
        message:
          "Canais SPX e logistica do vendedor habilitados com sucesso.",
      });
    } catch (err) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: false,
        message:
          err?.shopee?.message ||
          err?.message ||
          "Falha ao atualizar a logistica do produto.",
      });
    }
  }

  return res.json({
    ok: results.some((result) => result.ok),
    results,
  });
}

async function enableSellerLogistics(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop?.id) return;

  const normalizedItemIds = normalizeNumericItemIds(req.body?.itemIds);

  if (!normalizedItemIds.length) {
    return res.status(400).json({
      error: "bad_request",
      message: "Informe ao menos um item para habilitar a logistica do vendedor.",
    });
  }

  const products = (
    await listProductsByShopAndItemIdsForLogistics(shop.id, normalizedItemIds)
  ).filter((product) => isActiveProductStatus(product?.status));
  const liveInfoByItemId = await fetchLiveInfoByItemId(
    shop.shopId,
    normalizedItemIds,
    "enableSellerLogistics",
  );

  const results = [];

  for (const product of products) {
    const live = liveInfoByItemId.get(String(product.itemId));
    const summary = summarizeProduct(
      live
        ? {
            ...product,
            title: live.item_name || product.title,
            status: live.item_status || product.status,
            logistics: live.logistic_info || product.logistics,
            dimension: live.dimension || product.dimension,
            weight: live.weight != null ? Number(live.weight) : product.weight,
            spxLiveVerified: true,
          }
        : product,
    );

    if (!Array.isArray(summary.intelipostChannels) || !summary.intelipostChannels.length) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: false,
        message: "Produto sem canal Logistica do vendedor disponivel.",
      });
      continue;
    }

    if (hasSellerLogisticsEnabled(summary)) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: true,
        message: "Logistica do vendedor ja estava habilitada.",
      });
      continue;
    }

    const updatedLogistics = summary.logistics.map((channel) => {
      if (channel.kind === "intelipost") {
        return setChannelEnabled(channel.raw, true);
      }
      return channel.raw;
    });

    try {
      await ShopeeLogisticsService.updateProductLogistics({
        shopId: String(shop.shopId),
        itemId: String(product.itemId),
        logistics: updatedLogistics,
      });

      await updateProductById(product.id, {
        logistics: updatedLogistics,
        ...buildSpxSnapshot({
          logistics: updatedLogistics,
          dimension: summary.dimension,
          weight: summary.weight,
        }).cache,
      });

      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: true,
        message: "Logistica do vendedor habilitada com sucesso.",
      });
    } catch (err) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: false,
        message:
          err?.shopee?.message ||
          err?.message ||
          "Falha ao habilitar a logistica do vendedor.",
      });
    }
  }

  return res.json({
    ok: results.some((result) => result.ok),
    results,
  });
}

async function disableSpx(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop?.id) return;

  const normalizedItemIds = normalizeNumericItemIds(req.body?.itemIds);
  if (!normalizedItemIds.length) {
    return res.status(400).json({
      error: "bad_request",
      message: "Informe ao menos um item para desativar SPX e Expresso Aereo.",
    });
  }

  const products = (
    await listProductsByShopAndItemIdsForLogistics(shop.id, normalizedItemIds)
  ).filter((product) => isActiveProductStatus(product?.status));

  const liveInfoByItemId = await fetchLiveInfoByItemId(
    shop.shopId,
    normalizedItemIds,
    "disableSpx",
  );

  const results = [];

  for (const product of products) {
    const live = liveInfoByItemId.get(String(product.itemId));
    const summary = summarizeProduct(
      live
        ? {
            ...product,
            title: live.item_name || product.title,
            status: live.item_status || product.status,
            logistics: live.logistic_info || product.logistics,
            dimension: live.dimension || product.dimension,
            weight: live.weight != null ? Number(live.weight) : product.weight,
            spxLiveVerified: true,
          }
        : product,
    );

    if (!summary.spxChannel) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: false,
        message: "Produto sem canal Shopee Xpress ou Expresso Aereo na logistica sincronizada.",
      });
      continue;
    }

    if (!summary.spxEnabled) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: true,
        message: "Os canais SPX disponiveis ja estavam desativados.",
      });
      continue;
    }

    const updatedLogistics = summary.logistics.map((channel) => {
      if (channel.kind === "spx" || channel.kind === "pickup") {
        return setChannelEnabled(channel.raw, false);
      }
      return channel.raw;
    });

    try {
      await ShopeeLogisticsService.updateProductLogistics({
        shopId: String(shop.shopId),
        itemId: String(product.itemId),
        logistics: updatedLogistics,
      });

      await updateProductById(product.id, {
        logistics: updatedLogistics,
        ...buildSpxSnapshot({
          logistics: updatedLogistics,
          dimension: summary.dimension,
          weight: summary.weight,
        }).cache,
      });

      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: true,
        message: "Canais SPX disponiveis e Retire Perto de Voce desativados com sucesso.",
      });
    } catch (err) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: false,
        message:
          err?.shopee?.message ||
          err?.message ||
          "Falha ao desativar Shopee Xpress e Expresso Aereo.",
      });
    }
  }

  return res.json({
    ok: results.some((result) => result.ok),
    results,
  });
}

async function disableSellerLogistics(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop?.id) return;

  const normalizedItemIds = normalizeNumericItemIds(req.body?.itemIds);
  if (!normalizedItemIds.length) {
    return res.status(400).json({
      error: "bad_request",
      message: "Informe ao menos um item para desabilitar logistica do vendedor.",
    });
  }

  const products = (
    await listProductsByShopAndItemIdsForLogistics(shop.id, normalizedItemIds)
  ).filter((product) => isActiveProductStatus(product?.status));

  const liveInfoByItemId = await fetchLiveInfoByItemId(
    shop.shopId,
    normalizedItemIds,
    "disableSellerLogistics",
  );

  const results = [];

  for (const product of products) {
    const live = liveInfoByItemId.get(String(product.itemId));
    const summary = summarizeProduct(
      live
        ? {
            ...product,
            title: live.item_name || product.title,
            status: live.item_status || product.status,
            logistics: live.logistic_info || product.logistics,
            dimension: live.dimension || product.dimension,
            weight: live.weight != null ? Number(live.weight) : product.weight,
            spxLiveVerified: true,
          }
        : product,
    );

    if (
      !Array.isArray(summary.intelipostChannels) ||
      !summary.intelipostChannels.length
    ) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: false,
        message: "Produto sem canal Logistica do vendedor disponivel.",
      });
      continue;
    }

    if (summary.spxEnabled || summary.heavyEnabled) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: false,
        message:
          "Desative SPX ou entrega pesada antes de desabilitar a logistica do vendedor.",
      });
      continue;
    }


    if (!hasSellerLogisticsEnabled(summary)) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: true,
        message: "Logistica do vendedor ja estava desabilitada.",
      });
      continue;
    }

    const updatedLogistics = summary.logistics.map((channel) => {
      if (channel.kind === "intelipost") {
        return setChannelEnabled(channel.raw, false);
      }
      return channel.raw;
    });

    try {
      await ShopeeLogisticsService.updateProductLogistics({
        shopId: String(shop.shopId),
        itemId: String(product.itemId),
        logistics: updatedLogistics,
      });

      await updateProductById(product.id, {
        logistics: updatedLogistics,
        ...buildSpxSnapshot({
          logistics: updatedLogistics,
          dimension: summary.dimension,
          weight: summary.weight,
        }).cache,
      });

      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: true,
        message: "Logistica do vendedor desabilitada com sucesso.",
      });
    } catch (err) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: false,
        message:
          err?.shopee?.message ||
          err?.message ||
          "Falha ao desabilitar logistica do vendedor.",
      });
    }
  }

  return res.json({
    ok: results.some((result) => result.ok),
    results,
  });
}

function getConflictAdjustedLogistics(summary, keepMode = "spx") {
  const targetKinds = keepMode === "seller"
    ? ["seller"]
    : ["seller", "spx"];
  const target = buildTargetLogistics({
    logistics: summary.logistics.map((channel) => channel.raw),
    targetKinds,
  });

  return target.ok ? target.logistics : null;
}
async function resolveLogisticsConflicts(req, res, keepMode = "spx") {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop?.id) return;

  const normalizedItemIds = normalizeNumericItemIds(req.body?.itemIds);

  const baseProducts = normalizedItemIds.length
    ? await listProductsByShopAndItemIdsForLogistics(shop.id, normalizedItemIds)
    : await listProductsForLogistics(shop.id);
  const products = (Array.isArray(baseProducts) ? baseProducts : []).filter((product) =>
    isActiveProductStatus(product?.status),
  );

  const liveInfoByItemId = await fetchLiveInfoByItemId(
    shop.shopId,
    products.map((product) => product?.itemId),
    keepMode === "seller" ? "resolveConflictsKeepSeller" : "resolveConflictsKeepSpx",
  );

  const results = [];

  for (const product of products) {
    const live = liveInfoByItemId.get(String(product.itemId));
    const summary = summarizeProduct(
      live
        ? {
            ...product,
            title: live.item_name || product.title,
            status: live.item_status || product.status,
            logistics: live.logistic_info || product.logistics,
            dimension: live.dimension || product.dimension,
            weight: live.weight != null ? Number(live.weight) : product.weight,
            spxLiveVerified: true,
          }
        : product,
    );

    if (!hasDualLogisticsConflict(summary)) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: true,
        message: "Sem conflito entre SPX e logistica do vendedor.",
      });
      continue;
    }

    const updatedLogistics = getConflictAdjustedLogistics(summary, keepMode);

    try {
      await ShopeeLogisticsService.updateProductLogistics({
        shopId: String(shop.shopId),
        itemId: String(product.itemId),
        logistics: updatedLogistics,
      });

      await updateProductById(product.id, {
        logistics: updatedLogistics,
        ...buildSpxSnapshot({
          logistics: updatedLogistics,
          dimension: summary.dimension,
          weight: summary.weight,
        }).cache,
      });

      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: true,
        message:
          keepMode === "seller"
            ? "Conflito resolvido: mantida Logistica do vendedor e SPX desativado."
            : "Conflito resolvido: mantido SPX e Logistica do vendedor desativada.",
      });
    } catch (err) {
      results.push({
        itemId: String(product.itemId),
        title: product.title || null,
        ok: false,
        message:
          err?.shopee?.message ||
          err?.message ||
          "Falha ao resolver conflito de logistica.",
      });
    }
  }

  return res.json({
    ok: results.some((result) => result.ok),
    keepMode: keepMode === "seller" ? "seller" : "spx",
    results,
  });
}

async function applyAutomaticMapping(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop?.id) return;

  const rawMappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
  if (!rawMappings.length) {
    return res.status(400).json({
      error: "bad_request",
      message: "Envie ao menos um item no mapeamento automático.",
    });
  }

  const mergedByItemId = new Map();
  for (const raw of rawMappings) {
    const itemId = String(raw?.itemId || "").trim();
    if (!/^\d+$/.test(itemId)) continue;
    const parsed = parseMappingKinds(raw?.logisticsRaw || raw?.logistics || raw?.types);
    const current = mergedByItemId.get(itemId) || {
      itemId,
      kinds: new Set(),
      invalid: [],
    };
    parsed.kinds.forEach((kind) => current.kinds.add(kind));
    current.invalid.push(...parsed.invalid);
    mergedByItemId.set(itemId, current);
  }

  const itemIds = Array.from(mergedByItemId.keys());
  if (!itemIds.length) {
    return res.status(400).json({
      error: "bad_request",
      message: "Nenhum ID de anúncio válido foi encontrado no arquivo.",
    });
  }

  const products = await listProductsByShopAndItemIdsForLogisticsAnyStatus(
    shop.id,
    itemIds,
  );
  const productsByItemId = new Map(
    products.map((product) => [String(product.itemId || "").trim(), product]),
  );
  const liveInfoByItemId = await fetchLiveInfoByItemId(
    shop.shopId,
    itemIds,
    "applyAutomaticMapping",
  );

  const results = [];
  let alreadyDesiredActive = 0;
  let totalSpxActive = 0;
  let totalPickupActive = 0;
  let totalSellerActive = 0;
  let success = 0;
  let failed = 0;

  for (const itemId of itemIds) {
    const entry = mergedByItemId.get(itemId);
    const desiredKinds = Array.from(entry?.kinds || []);
    if (!desiredKinds.length) {
      failed += 1;
      results.push({
        itemId,
        title: null,
        ok: false,
        message:
          "Tipo de Logística inválido ou vazio. Use: Logística do vendedor, Shopee Xpress, Retire perto de você.",
      });
      continue;
    }

    const product = productsByItemId.get(itemId) || null;
    const live = liveInfoByItemId.get(itemId) || null;
    const sourceProduct = live
      ? {
          ...(product || {}),
          itemId,
          id: product?.id || null,
          title: live.item_name || product?.title || null,
          status: live.item_status || product?.status || null,
          logistics: live.logistic_info || product?.logistics || null,
          dimension: live.dimension || product?.dimension || null,
          weight: live.weight != null ? Number(live.weight) : product?.weight,
          spxLiveVerified: true,
        }
      : product;

    if (!sourceProduct || !sourceProduct.logistics) {
      failed += 1;
      results.push({
        itemId,
        title: null,
        ok: false,
        message: "Produto não encontrado para a loja ativa ou sem logística disponível.",
      });
      continue;
    }

    const summary = summarizeProduct(sourceProduct);
    const missingRequired = [];
    if (desiredKinds.includes("spx") && !summary.spxChannel) {
      missingRequired.push(LOGISTICS_MAPPING_LABEL_BY_KIND.spx);
    }
    if (desiredKinds.includes("pickup") && !summary.pickupChannel) {
      missingRequired.push(LOGISTICS_MAPPING_LABEL_BY_KIND.pickup);
    }
    if (
      desiredKinds.includes("seller") &&
      (!Array.isArray(summary.intelipostChannels) || !summary.intelipostChannels.length)
    ) {
      missingRequired.push(LOGISTICS_MAPPING_LABEL_BY_KIND.seller);
    }

    if (missingRequired.length) {
      failed += 1;
      results.push({
        itemId,
        title: summary.title || null,
        ok: false,
        message: `Canais não disponíveis neste produto: ${missingRequired.join(", ")}.`,
      });
      continue;
    }

    const wasAlreadyDesired = desiredKinds.every((kind) =>
      isLogisticsKindEnabled(summary, kind),
    );

    // Aplica o mapeamento como estado alvo: ativa apenas os tipos solicitados
    // (seller/spx/pickup) e desativa os demais dentro desse conjunto.
    const updatedLogistics = summary.logistics.map((channel) => {
      if (channel.kind === "intelipost") {
        return setChannelEnabled(channel.raw, desiredKinds.includes("seller"));
      }
      if (channel.kind === "spx") {
        return setChannelEnabled(channel.raw, desiredKinds.includes("spx"));
      }
      if (channel.kind === "pickup") {
        return setChannelEnabled(channel.raw, desiredKinds.includes("pickup"));
      }
      return channel.raw;
    });

    try {
      await ShopeeLogisticsService.updateProductLogistics({
        shopId: String(shop.shopId),
        itemId,
        logistics: updatedLogistics,
      });

      if (product?.id) {
        await updateProductById(product.id, {
          logistics: updatedLogistics,
          ...buildSpxSnapshot({
            logistics: updatedLogistics,
            dimension: summary.dimension,
            weight: summary.weight,
          }).cache,
        });
      }

      const finalSummary = summarizeProduct({
        ...sourceProduct,
        logistics: updatedLogistics,
      });
      if (finalSummary.spxEnabled) totalSpxActive += 1;
      if (isLogisticsKindEnabled(finalSummary, "pickup")) totalPickupActive += 1;
      if (hasSellerLogisticsEnabled(finalSummary)) totalSellerActive += 1;
      if (wasAlreadyDesired) alreadyDesiredActive += 1;

      success += 1;
      results.push({
        itemId,
        title: finalSummary.title || null,
        ok: true,
        message: wasAlreadyDesired
          ? "Produto já estava com a logística desejada ativa."
          : "Mapeamento automático aplicado com sucesso.",
      });
    } catch (err) {
      failed += 1;
      results.push({
        itemId,
        title: summary.title || null,
        ok: false,
        message:
          err?.shopee?.message ||
          err?.message ||
          "Falha ao aplicar mapeamento automático de logística.",
      });
    }
  }

  const summaryLines = [
    `${alreadyDesiredActive} produtos já estavam com a logística desejada ativa`,
    `${totalSpxActive} produtos ativos em Shopee Xpress, ${totalPickupActive} Retire perto de você e ${totalSellerActive} Logística do vendedor`,
  ];

  return res.json({
    ok: success > 0,
    totalRequested: itemIds.length,
    success,
    failed,
    alreadyDesiredActive,
    activeTotals: {
      shopeeXpress: totalSpxActive,
      pickup: totalPickupActive,
      sellerLogistics: totalSellerActive,
    },
    summaryLines,
    results,
  });
}

async function resolveConflictsKeepSpx(req, res) {
  return resolveLogisticsConflicts(req, res, "spx");
}

async function resolveConflictsKeepSeller(req, res) {
  return resolveLogisticsConflicts(req, res, "seller");
}

async function configure(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop?.id) return;

  const itemIds = normalizeNumericItemIds(req.body?.itemIds);
  if (!itemIds.length || !Array.isArray(req.body?.targetKinds)) {
    return res.status(400).json({
      error: "bad_request",
      message: "Informe itemIds e targetKinds para configurar a logistica.",
    });
  }

  const products = (
    await listProductsByShopAndItemIdsForLogistics(shop.id, itemIds)
  ).filter((product) => isActiveProductStatus(product?.status));
  const configured = await configureProducts({
    products,
    liveInfoByItemId: await fetchLiveInfoByItemId(shop.shopId, itemIds, "configure"),
    targetKinds: req.body.targetKinds,
    shopShopeeId: shop.shopId,
    updateRemote: ShopeeLogisticsService.updateProductLogistics,
    updateLocal: updateProductById,
  });
  const found = new Set(products.map((product) => String(product.itemId)));
  for (const itemId of itemIds) {
    if (found.has(itemId)) continue;
    configured.failed += 1;
    configured.results.push({
      itemId, title: null, status: null, availableKinds: [], enabledKinds: [],
      errors: [{ code: "product_unavailable", message: "Produto nao encontrado ou inativo." }],
      ok: false, message: "Produto nao encontrado ou inativo.",
    });
  }
  configured.totalRequested = itemIds.length;
  return res.json(configured);
}


module.exports = {
  configureProducts,
  list,
  enableSpx,
  disableSpx,
  enableSellerLogistics,
  disableSellerLogistics,
  resolveConflictsKeepSpx,
  resolveConflictsKeepSeller,
  applyAutomaticMapping,
};
const { buildTargetLogistics } = require("../domain/logisticsConfigurationPolicy");
module.exports.configure = configure;
module.exports.getConflictAdjustedLogistics = getConflictAdjustedLogistics;
module.exports.isSellerEligible = isSellerEligible;
