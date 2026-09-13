"use strict";

const { resolveShop } = require("../utils/resolveShop");
const {
  listMonitoredItems,
  upsertMonitoredItems,
  setItemPurchaseInTransit,
  confirmArrival,
  disableMonitoredItem,
  clearAwaitingStatusWhenStockIncreased,
  searchProductsForMonitoring,
  listProductBasicsByItemIds,
  mapItemSalesByRange,
  syncMonitoredProductsStock,
} = require("../repositories/stockAlertSqlRepository");
const ShopeeProductService = require("../services/ShopeeProductService");

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function endOfDay(date) {
  const value = new Date(date);
  value.setHours(23, 59, 59, 999);
  return value;
}

function addDays(date, days) {
  return new Date(date.getTime() + Number(days || 0) * DAY_MS);
}

function toYmd(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDateBr(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("pt-BR");
}

function parseDateInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.round(parsed));
}

function parseRange(query = {}) {
  const preset = String(query.periodPreset || "30d").toLowerCase();
  const now = new Date();
  let start = null;
  let end = null;

  if (preset === "custom") {
    const parsedStart = parseDateInput(query.dateFrom);
    const parsedEnd = parseDateInput(query.dateTo);
    if (parsedStart && parsedEnd && parsedStart <= parsedEnd) {
      start = startOfDay(parsedStart);
      end = endOfDay(parsedEnd);
    }
  }

  if (!start || !end) {
    const days =
      preset === "90d"
        ? 90
        : preset === "60d"
          ? 60
          : 30;
    end = endOfDay(now);
    start = startOfDay(addDays(end, -(days - 1)));
  }

  const totalDays = Math.max(1, Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1);
  const previousEnd = endOfDay(addDays(start, -1));
  const previousStart = startOfDay(addDays(previousEnd, -(totalDays - 1)));

  return {
    preset,
    start,
    end,
    totalDays,
    previousStart,
    previousEnd,
    periodLabel: `${formatDateBr(start)} ate ${formatDateBr(end)}`,
  };
}

function computeTrend(currentAvg, previousAvg) {
  if (previousAvg <= 0 && currentAvg <= 0) {
    return { status: "estabilidade", deltaPct: 0, factor: 1 };
  }
  if (previousAvg <= 0 && currentAvg > 0) {
    return { status: "crescimento", deltaPct: 100, factor: 1.2 };
  }

  const deltaPct = ((currentAvg - previousAvg) / previousAvg) * 100;
  if (deltaPct >= 15) {
    return { status: "crescimento", deltaPct, factor: 1.2 };
  }
  if (deltaPct <= -15) {
    return { status: "queda", deltaPct, factor: 0.85 };
  }
  return { status: "estabilidade", deltaPct, factor: 1 };
}

function computeRiskLevel(daysCoverage, adjustedDaily, monitorStatus) {
  if (monitorStatus === "awaiting_arrival") return "aguardando";
  if (adjustedDaily <= 0 || daysCoverage == null) return "baixo";
  if (daysCoverage <= 7) return "alto";
  if (daysCoverage <= 15) return "medio";
  if (daysCoverage <= 30) return "atencao";
  return "baixo";
}

function computeGiroBand(giro) {
  if (giro >= 1) return "alto";
  if (giro >= 0.4) return "medio";
  return "baixo";
}

function buildItemRecommendation({
  riskLevel,
  trendStatus,
  recommendedPurchaseQty,
  stockoutDate,
  daysCoverage,
  itemSku,
}) {
  if (riskLevel === "alto") {
    return {
      tone: "danger",
      title: "Reposicao urgente",
      message: `Compra imediata recomendada para SKU ${itemSku || "-"}. Ruptura prevista em ${Number.isFinite(daysCoverage) ? `${Math.max(0, Math.ceil(daysCoverage))} dia(s)` : "curto prazo"}.`,
      quantity: Math.max(0, recommendedPurchaseQty || 0),
      stockoutDate: stockoutDate || null,
    };
  }
  if (riskLevel === "medio" || riskLevel === "atencao") {
    return {
      tone: "warning",
      title: "Planejar reposicao",
      message: `Planeje compra preventiva para SKU ${itemSku || "-"} e evite ruptura.`,
      quantity: Math.max(0, recommendedPurchaseQty || 0),
      stockoutDate: stockoutDate || null,
    };
  }
  if (trendStatus === "queda") {
    return {
      tone: "info",
      title: "Demanda em desaceleracao",
      message: `SKU ${itemSku || "-"} em queda de demanda. Evite excesso de estoque.`,
      quantity: Math.max(0, Math.floor((recommendedPurchaseQty || 0) * 0.6)),
      stockoutDate: stockoutDate || null,
    };
  }
  return {
    tone: "positive",
    title: "Estoque sob controle",
    message: `SKU ${itemSku || "-"} com cobertura adequada no momento.`,
    quantity: Math.max(0, recommendedPurchaseQty || 0),
    stockoutDate: stockoutDate || null,
  };
}

function toItemId(value) {
  if (value == null || value === "") return null;
  try {
    return BigInt(String(value)).toString();
  } catch (_error) {
    return null;
  }
}

function chunk(items, size) {
  const source = Array.isArray(items) ? items : [];
  const safeSize = Math.max(1, Number(size) || 1);
  const output = [];
  for (let i = 0; i < source.length; i += safeSize) {
    output.push(source.slice(i, i + safeSize));
  }
  return output;
}

function salesFromMap(map, itemId) {
  if (!(map instanceof Map)) return 0;
  const value = Number(map.get(itemId) || 0);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function extractBaseInfoItems(payload) {
  const response = payload?.response ?? payload ?? {};
  const candidateArrays = [
    response?.item_list,
    response?.items,
    response?.item,
    payload?.item_list,
    payload?.items,
    payload?.item,
    response,
  ];
  for (const candidate of candidateArrays) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object" && candidate.item_id != null) {
      return [candidate];
    }
  }
  return [];
}

async function listProducts(req, res, next) {
  try {
    const shop = await resolveShop(req, "active");
    const q = String(req.query.q || "").trim();
    const limit = parsePositiveInt(req.query.limit, 40) || 40;
    if (!q) {
      return res.json({
        items: [],
        meta: {
          requiresSearch: true,
        },
      });
    }
    const monitored = await listMonitoredItems(shop.id);
    const monitoredSet = new Set(monitored.map((row) => row.itemId));
    const items = await searchProductsForMonitoring(shop.id, q, limit);

    res.json({
      items: items.map((item) => ({
        ...item,
        isMonitored: monitoredSet.has(item.itemId),
      })),
    });
  } catch (error) {
    next(error);
  }
}

async function monitorItems(req, res, next) {
  try {
    const shop = await resolveShop(req, "active");
    const rawItemIds = Array.isArray(req.body?.itemIds) ? req.body.itemIds : [];
    const itemIds = rawItemIds.map((value) => toItemId(value)).filter(Boolean);
    if (!itemIds.length) {
      return res.status(400).json({ error: "item_ids_required" });
    }

    const result = await upsertMonitoredItems(shop.id, itemIds);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
}

async function unmonitorItem(req, res, next) {
  try {
    const shop = await resolveShop(req, "active");
    const itemId = toItemId(req.params.itemId);
    if (!itemId) return res.status(400).json({ error: "invalid_item_id" });
    const ok = await disableMonitoredItem(shop.id, itemId);
    res.json({ ok });
  } catch (error) {
    next(error);
  }
}

async function purchaseMarked(req, res, next) {
  try {
    const shop = await resolveShop(req, "active");
    const itemId = toItemId(req.params.itemId);
    if (!itemId) return res.status(400).json({ error: "invalid_item_id" });

    const expectedArrivalDate = String(req.body?.expectedArrivalDate || "").trim();
    const parsedArrival = parseDateInput(expectedArrivalDate);
    if (!parsedArrival) {
      return res.status(400).json({ error: "expected_arrival_date_required" });
    }

    const currentStock = parsePositiveInt(req.body?.currentStock, 0);
    const ok = await setItemPurchaseInTransit(
      shop.id,
      itemId,
      toYmd(parsedArrival),
      currentStock,
    );
    res.json({ ok: Boolean(ok) });
  } catch (error) {
    next(error);
  }
}

async function confirmItemArrival(req, res, next) {
  try {
    const shop = await resolveShop(req, "active");
    const itemId = toItemId(req.params.itemId);
    if (!itemId) return res.status(400).json({ error: "invalid_item_id" });
    const ok = await confirmArrival(shop.id, itemId);
    res.json({ ok: Boolean(ok) });
  } catch (error) {
    next(error);
  }
}

async function overview(req, res, next) {
  try {
    const shop = await resolveShop(req, "active");
    const range = parseRange(req.query || {});
    const riskOnly = String(req.query?.riskOnly || "").trim() === "1";

    const monitored = await listMonitoredItems(shop.id);
    const itemIds = monitored.map((row) => row.itemId).filter(Boolean);
    if (!itemIds.length) {
      return res.json({
        meta: {
          periodPreset: range.preset,
          dateFrom: toYmd(range.start),
          dateTo: toYmd(range.end),
          periodLabel: range.periodLabel,
          monitoredCount: 0,
        },
        summary: {
          total: 0,
          highRiskCount: 0,
          mediumRiskCount: 0,
          awaitingArrivalCount: 0,
          averageCoverageDays: 0,
        },
        kpiRiskItems: [],
        insights: [
          {
            tone: "info",
            title: "Sem itens monitorados",
            message: "Selecione produtos para iniciar o alerta inteligente de estoque.",
          },
        ],
        items: [],
      });
    }

    const products = await listProductBasicsByItemIds(shop.id, itemIds);
    const productMap = new Map(products.map((row) => [row.itemId, row]));
    const monitoredRows = monitored.filter((row) => productMap.has(row.itemId));
    const monitoredItemIds = monitoredRows.map((row) => row.itemId);
    const todayStart = startOfDay(new Date());

    const range30Start = startOfDay(addDays(range.end, -29));
    const range60Start = startOfDay(addDays(range.end, -59));
    const range90Start = startOfDay(addDays(range.end, -89));

    const [salesRange, salesPrev, sales30, sales60, sales90] = await Promise.all([
      mapItemSalesByRange(shop.id, monitoredItemIds, range.start, range.end),
      mapItemSalesByRange(shop.id, monitoredItemIds, range.previousStart, range.previousEnd),
      mapItemSalesByRange(shop.id, monitoredItemIds, range30Start, range.end),
      mapItemSalesByRange(shop.id, monitoredItemIds, range60Start, range.end),
      mapItemSalesByRange(shop.id, monitoredItemIds, range90Start, range.end),
    ]);

    const leadDays = Math.max(1, parsePositiveInt(process.env.STOCK_ALERT_LEAD_DAYS, 15) || 15);
    const rows = [];
    let autoResumedCount = 0;

    for (const monitorRow of monitoredRows) {
      const product = productMap.get(monitorRow.itemId);
      if (!product) continue;

      let status = monitorRow.status || "monitoring";
      let expectedArrivalDate = monitorRow.expectedArrivalDate || null;
      const stock = Math.max(0, parsePositiveInt(product.totalStock, 0));

      if (
        status === "awaiting_arrival" &&
        monitorRow.lastKnownStock != null &&
        stock > Number(monitorRow.lastKnownStock || 0)
      ) {
        // Estoque subiu: volta automaticamente para monitoramento normal.
        // Nao interrompe retorno da tela mesmo se houver falha no update.
        // eslint-disable-next-line no-await-in-loop
        await clearAwaitingStatusWhenStockIncreased(shop.id, monitorRow.itemId, stock);
        status = "monitoring";
        expectedArrivalDate = null;
        autoResumedCount += 1;
      }

      const salesPeriod = salesFromMap(salesRange, monitorRow.itemId);
      const salesPeriodPrev = salesFromMap(salesPrev, monitorRow.itemId);
      const salesLast30 = salesFromMap(sales30, monitorRow.itemId);
      const salesLast60 = salesFromMap(sales60, monitorRow.itemId);
      const salesLast90 = salesFromMap(sales90, monitorRow.itemId);

      const averageSalesPerDay = salesPeriod / Math.max(1, range.totalDays);
      const previousAveragePerDay = salesPeriodPrev / Math.max(1, range.totalDays);
      const trend = computeTrend(averageSalesPerDay, previousAveragePerDay);
      const adjustedDailyDemand = averageSalesPerDay * trend.factor;
      const daysCoverage =
        adjustedDailyDemand > 0 ? stock / adjustedDailyDemand : null;
      const stockoutDate =
        daysCoverage == null ? null : addDays(todayStart, Math.ceil(daysCoverage));
      const riskLevel = computeRiskLevel(daysCoverage, adjustedDailyDemand, status);
      const giro = stock > 0 ? salesLast30 / stock : salesLast30 > 0 ? salesLast30 : 0;
      const giroBand = computeGiroBand(giro);

      const safetyDays =
        trend.status === "crescimento" ? 10 : trend.status === "queda" ? 5 : 7;
      const safetyStock = Math.ceil(adjustedDailyDemand * safetyDays);
      const idealStock = Math.ceil(adjustedDailyDemand * (leadDays + safetyDays));
      const recommendedPurchaseQty = Math.max(0, idealStock - stock);

      const alerts = [];
      if (
        (riskLevel === "alto" || riskLevel === "medio") &&
        status !== "awaiting_arrival" &&
        stockoutDate
      ) {
        alerts.push(
          `Realizar nova compra deste item, pois o estoque acabara ate ${formatDateBr(stockoutDate)}.`,
        );
      }

      if (status === "awaiting_arrival" && expectedArrivalDate) {
        const expectedDate = parseDateInput(expectedArrivalDate);
        if (expectedDate) {
          const daysToArrival = Math.floor(
            (startOfDay(expectedDate).getTime() - todayStart.getTime()) / DAY_MS,
          );
          if (daysToArrival === 2) {
            alerts.push("Entrega prevista em 2 dias. Prepare a conferencia do recebimento.");
          } else if (daysToArrival === 1) {
            alerts.push("Entrega prevista para amanha. Reforce a conferencia da chegada.");
          } else if (daysToArrival === 0) {
            alerts.push(
              "Atencao: o novo estoque deste produto esta previsto para chegar hoje. Confirme se a mercadoria ja chegou. Caso o estoque ainda nao tenha sido atualizado automaticamente, realize a conferencia manual.",
            );
          }
        }
      }

      rows.push({
        itemId: monitorRow.itemId,
        title: product.title || "Produto sem titulo",
        itemSku: product.itemSku || "",
        imageUrl: product.imageUrl || null,
        status,
        expectedArrivalDate,
        stock,
        sales: {
          days30: salesLast30,
          days60: salesLast60,
          days90: salesLast90,
          period: salesPeriod,
          previousPeriod: salesPeriodPrev,
        },
        averageSalesPerDay,
        adjustedDailyDemand,
        daysCoverage,
        stockoutDate: stockoutDate ? stockoutDate.toISOString() : null,
        trend: {
          status: trend.status,
          deltaPct: trend.deltaPct,
        },
        riskLevel,
        giro,
        giroBand,
        safetyStock,
        idealStock,
        recommendedPurchaseQty,
        recommendation: buildItemRecommendation({
          riskLevel,
          trendStatus: trend.status,
          recommendedPurchaseQty,
          stockoutDate: stockoutDate ? stockoutDate.toISOString() : null,
          daysCoverage,
          itemSku: product.itemSku || "",
        }),
        alerts,
      });
    }

    const filteredRows = riskOnly
      ? rows.filter((row) => ["alto", "medio", "atencao"].includes(row.riskLevel))
      : rows;

    const sortedRiskRows = rows
      .filter((row) => ["alto", "medio"].includes(row.riskLevel))
      .sort((a, b) => {
        const aDays = Number.isFinite(a.daysCoverage) ? a.daysCoverage : Number.MAX_SAFE_INTEGER;
        const bDays = Number.isFinite(b.daysCoverage) ? b.daysCoverage : Number.MAX_SAFE_INTEGER;
        return aDays - bDays;
      });

    const highRiskCount = rows.filter((row) => row.riskLevel === "alto").length;
    const mediumRiskCount = rows.filter((row) => row.riskLevel === "medio").length;
    const awaitingArrivalCount = rows.filter((row) => row.status === "awaiting_arrival").length;
    const coverageValues = rows
      .map((row) => row.daysCoverage)
      .filter((value) => Number.isFinite(value));
    const averageCoverageDays = coverageValues.length
      ? coverageValues.reduce((acc, value) => acc + value, 0) / coverageValues.length
      : 0;

    const growthCount = rows.filter((row) => row.trend.status === "crescimento").length;
    const declineCount = rows.filter((row) => row.trend.status === "queda").length;
    const stableCount = rows.filter((row) => row.trend.status === "estabilidade").length;
    const highGiroCount = rows.filter((row) => row.giroBand === "alto").length;
    const lowGiroCount = rows.filter((row) => row.giroBand === "baixo").length;
    const totalCurrentPeriodSales = rows.reduce(
      (acc, row) => acc + Number(row?.sales?.period || 0),
      0,
    );
    const totalPreviousPeriodSales = rows.reduce(
      (acc, row) => acc + Number(row?.sales?.previousPeriod || 0),
      0,
    );
    const salesGrowthPct =
      totalPreviousPeriodSales > 0
        ? ((totalCurrentPeriodSales - totalPreviousPeriodSales) / totalPreviousPeriodSales) * 100
        : totalCurrentPeriodSales > 0
          ? 100
          : 0;

    const insights = [];
    if (autoResumedCount > 0) {
      insights.push({
        tone: "positive",
        title: "Chegada de estoque detectada",
        message: `${autoResumedCount} item(ns) voltaram automaticamente para monitoramento normal.`,
      });
    }
    insights.push({
      tone: highRiskCount > 0 ? "danger" : "positive",
      title: "Risco de ruptura",
      message:
        highRiskCount > 0
          ? `${highRiskCount} item(ns) com risco alto de ruptura exigem reposicao imediata.`
          : "Nenhum item em risco alto de ruptura no momento.",
    });
    insights.push({
      tone: "info",
      title: "Tendencia de demanda",
      message: `${growthCount} item(ns) em crescimento, ${declineCount} em queda e ${stableCount} em estabilidade no periodo analisado.`,
    });
    insights.push({
      tone: "info",
      title: "Giro do estoque",
      message: `${highGiroCount} item(ns) com giro alto e ${lowGiroCount} com giro baixo.`,
    });
    insights.push({
      tone: "warning",
      title: "Estoque de seguranca",
      message:
        "Recomendacao de compra considera media diaria ajustada, tendencia e estoque de seguranca para evitar ruptura e excesso.",
    });

    const recommendations = [
      {
        tone: highRiskCount > 0 ? "danger" : "positive",
        title: "Reposicao prioritaria",
        message:
          highRiskCount > 0
            ? `Priorize ${highRiskCount} item(ns) de risco alto com compra imediata.`
            : "Sem necessidade de reposicao emergencial neste momento.",
      },
      {
        tone: salesGrowthPct >= 0 ? "positive" : "warning",
        title: "Crescimento de vendas vs periodo anterior",
        message: `Variacao de ${salesGrowthPct.toFixed(2)}% no volume vendido frente ao periodo anterior equivalente.`,
      },
      {
        tone: lowGiroCount > highGiroCount ? "warning" : "info",
        title: "Equilibrio de giro",
        message: `${highGiroCount} item(ns) com giro alto e ${lowGiroCount} com giro baixo. Ajuste compras para reduzir capital parado.`,
      },
    ];

    res.json({
      meta: {
        periodPreset: range.preset,
        dateFrom: toYmd(range.start),
        dateTo: toYmd(range.end),
        periodLabel: range.periodLabel,
        monitoredCount: monitoredRows.length,
        riskOnly,
      },
      summary: {
        total: rows.length,
        highRiskCount,
        mediumRiskCount,
        awaitingArrivalCount,
        averageCoverageDays,
        growthCount,
        declineCount,
        stableCount,
        totalCurrentPeriodSales,
        totalPreviousPeriodSales,
        salesGrowthPct,
        highGiroCount,
        lowGiroCount,
      },
      kpiRiskItems: sortedRiskRows.slice(0, 5).map((row) => ({
        itemId: row.itemId,
        title: row.title,
        itemSku: row.itemSku,
        imageUrl: row.imageUrl || null,
        stock: row.stock,
        riskLevel: row.riskLevel,
        stockoutDate: row.stockoutDate,
      })),
      insights,
      recommendations,
      items: filteredRows,
    });
  } catch (error) {
    next(error);
  }
}

async function syncMonitoredStock(req, res, next) {
  try {
    const shop = await resolveShop(req, "active");
    const monitored = await listMonitoredItems(shop.id);
    const monitoredItemIds = monitored.map((row) => row.itemId).filter(Boolean);

    if (!monitoredItemIds.length) {
      return res.json({
        ok: true,
        summary: {
          monitoredItems: 0,
          fetchedFromShopee: 0,
          updatedProducts: 0,
          updatedModels: 0,
        },
      });
    }

    const baseInfoList = [];
    for (const batch of chunk(monitoredItemIds, 20)) {
      // eslint-disable-next-line no-await-in-loop
      const response = await ShopeeProductService.getItemBaseInfo({
        shopId: String(shop.shopId),
        itemIdList: batch,
      });
      const items = extractBaseInfoItems(response);
      baseInfoList.push(...items);
    }

    const baseByItemId = new Map();
    for (const item of baseInfoList) {
      const itemId = toItemId(item?.item_id);
      if (!itemId) continue;
      baseByItemId.set(itemId, item);
    }

    const missingItemIds = monitoredItemIds.filter((itemId) => !baseByItemId.has(itemId));
    for (const itemId of missingItemIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await ShopeeProductService.getItemBaseInfo({
          shopId: String(shop.shopId),
          itemIdList: [itemId],
        });
        const items = extractBaseInfoItems(response);
        for (const item of items) {
          const fetchedItemId = toItemId(item?.item_id);
          if (!fetchedItemId) continue;
          baseByItemId.set(fetchedItemId, item);
        }
      } catch (_error) {
        // Ignora item com falha pontual e segue com os demais.
      }
    }

    const snapshots = [];
    let modelFetchErrors = 0;

    for (const itemId of monitoredItemIds) {
      const base = baseByItemId.get(itemId);
      if (!base) continue;

      const stock = Number(
        base?.stock_info_v2?.summary_info?.total_available_stock ?? null,
      );
      const safeStock = Number.isFinite(stock) ? Math.max(0, Math.round(stock)) : null;
      const hasModel = Boolean(base?.has_model);
      let models = [];

      if (hasModel) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const modelResponse = await ShopeeProductService.getModelList({
            shopId: String(shop.shopId),
            itemId,
          });
          const apiModels = Array.isArray(modelResponse?.response?.model)
            ? modelResponse.response.model
            : [];
          models = apiModels
            .map((model) => {
              const modelId = toItemId(model?.model_id);
              if (!modelId) return null;
              const modelStock = Number(
                model?.stock_info_v2?.summary_info?.total_available_stock ?? null,
              );
              return {
                modelId,
                stock: Number.isFinite(modelStock)
                  ? Math.max(0, Math.round(modelStock))
                  : null,
              };
            })
            .filter(Boolean);
        } catch (_error) {
          modelFetchErrors += 1;
        }
      }

      snapshots.push({
        itemId,
        stock: safeStock,
        models,
      });
    }

    const syncResult = await syncMonitoredProductsStock(shop.id, snapshots);

    return res.json({
      ok: true,
      summary: {
        monitoredItems: monitoredItemIds.length,
        fetchedFromShopee: baseByItemId.size,
        updatedProducts: syncResult.updatedProducts || 0,
        updatedModels: syncResult.updatedModels || 0,
        modelFetchErrors,
      },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listProducts,
  monitorItems,
  unmonitorItem,
  purchaseMarked,
  confirmItemArrival,
  overview,
  syncMonitoredStock,
};
