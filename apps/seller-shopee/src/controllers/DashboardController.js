const {
  listProductsByShopAndItemIds,
} = require("../repositories/analyticsSqlRepository");
const {
  aggregatePaidOrdersInRange,
  countAdsCampaignGroups,
  countCancelledPaidOrdersInRange,
  countOrdersInRange,
  countPaidOrdersInRange,
  countPausedProductsForShop,
  countSpxEnabledActiveProductsForShop,
  countProductsForShop,
  countReturnedOrdersInRange,
  groupSoldProductsByOrderIds,
  groupTopProductsByQuantitySince,
  listOrderItemsForProductsSince,
  listOrdersGmvByIds,
  listPaidOrdersInRange,
  listProductTitlesByIds,
  listProductsWithRatings,
} = require("../repositories/dashboardSqlRepository");
const {
  getPriceIncreaseDashboardSummary,
  listRecentPriceUpdateEvents,
} = require("../repositories/priceIncreaseSqlRepository");
const {
  findShopByDbIdAndAccountId,
} = require("../repositories/operationsSqlRepository");
const ShopeeAccountHealthService = require("../services/ShopeeAccountHealthService");
const { collectRoasMetricsForRange } = require("../services/AdsRoasMetricsService");
const { formatRemainingFromLock } = require("../services/priceIncreasePolicyService");
const SHOPEE_TZ = process.env.SHOPEE_REPORT_TZ_OFFSET || "-03:00";
const { hourIndexInOffset, tzOffsetToMinutes } = require("../utils/timezone");
const CANCELLED_ORDER_STATUSES = new Set(["CANCELLED"]);
const RETURNED_ORDER_STATUSES = new Set(["TO_RETURN", "RETURNED"]);
const ACCOUNT_HEALTH_RATINGS = {
  1: { label: "Ruim", tone: "critical" },
  2: { label: "Precisa melhorar", tone: "warning" },
  3: { label: "Boa", tone: "good" },
  4: { label: "Excelente", tone: "excellent" },
};
const ACCOUNT_HEALTH_TYPES = {
  1: "Envio",
  2: "Anuncios",
  3: "Atendimento",
};
const ACCOUNT_HEALTH_METRIC_OVERRIDES = {
  "preparation time": {
    label: "Tempo de preparacao",
    description:
      "Tempo medio que a loja leva para preparar os pedidos antes do envio.",
    compact: true,
    hideType: true,
  },
  "pre order listing rate": {
    label: "Taxa de anuncios em pre-venda",
    description:
      "Percentual de anuncios configurados como pre-venda dentro da operacao. Pre-venda indica itens com prazo estendido de preparacao ou envio.",
    compact: true,
    hideType: true,
  },
  "the amount of pre order listing": {
    label: "Dias de pre-encomenda",
    description:
      "Quantidade de dias que a % do produto como pre-encomenda e superior ou igual a meta.",
    compact: true,
    hideType: true,
  },
  "response rate": {
    label: "Taxa de respostas",
    description:
      "Percentual de atendimentos respondidos dentro do padrao esperado pela Shopee.",
  },
  "chat response rate": {
    label: "Taxa de respostas",
    description:
      "Percentual de atendimentos respondidos dentro do padrao esperado pela Shopee.",
  },
  "customer service response rate": {
    label: "Taxa de respostas",
    description:
      "Percentual de atendimentos respondidos dentro do padrao esperado pela Shopee.",
  },
  "spx listing rate": {
    label: "% anuncios com SPX",
    description:
      "Percentual de anuncios elegiveis/habilitados com a logistica SPX na loja.",
  },
};

function isMissingPriceUpdateTableError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const searchSpace = `${String(error?.message || "")} ${String(error?.detail || "")} ${String(error?.details || "")}`
    .toLowerCase();
  return code === "42P01" && searchSpace.includes("productpriceupdateevent");
}

async function loadPriceIncreaseDashboardData(shopId, now) {
  try {
    const [summary, recent] = await Promise.all([
      getPriceIncreaseDashboardSummary(shopId, now),
      listRecentPriceUpdateEvents(shopId, { limit: 25 }),
    ]);
    return {
      summary,
      recent,
    };
  } catch (error) {
    if (isMissingPriceUpdateTableError(error)) {
      return {
        summary: { blockedItems: 0, totalRecentEvents: 0 },
        recent: [],
      };
    }
    throw error;
  }
}
const ACCOUNT_HEALTH_DETAIL_SUPPORTED = new Set([
  1, 3, 4, 12, 15, 25, 28, 42, 43, 52, 53, 85, 88, 91, 92, 96, 97, 2001,
  2002, 2003, 2030, 2031, 2032, 2033, 2035,
]);
const CONTROL_PANEL_CACHE_TTL_MS = Math.max(
  15 * 1000,
  Number(process.env.SHOPEE_CONTROL_PANEL_CACHE_TTL_MS || 90 * 1000) || 90 * 1000,
);
const CONTROL_PANEL_CACHE_MAX_ITEMS = 60;
const CONTROL_PANEL_CACHE = new Map();

function toReportIsoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Date(date.getTime() + tzOffsetToMinutes(SHOPEE_TZ) * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function readControlPanelCache(shopDbId) {
  const key = String(shopDbId || "").trim();
  if (!key) return null;
  const entry = CONTROL_PANEL_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt > CONTROL_PANEL_CACHE_TTL_MS) {
    CONTROL_PANEL_CACHE.delete(key);
    return null;
  }
  return entry.payload || null;
}

function writeControlPanelCache(shopDbId, payload) {
  const key = String(shopDbId || "").trim();
  if (!key || !payload) return;
  CONTROL_PANEL_CACHE.set(key, {
    savedAt: Date.now(),
    payload,
  });
  if (CONTROL_PANEL_CACHE.size <= CONTROL_PANEL_CACHE_MAX_ITEMS) return;

  let oldestKey = null;
  let oldestSavedAt = Number.POSITIVE_INFINITY;
  for (const [mapKey, value] of CONTROL_PANEL_CACHE.entries()) {
    const savedAt = Number(value?.savedAt || 0);
    if (savedAt < oldestSavedAt) {
      oldestSavedAt = savedAt;
      oldestKey = mapKey;
    }
  }
  if (oldestKey != null) CONTROL_PANEL_CACHE.delete(oldestKey);
}

function paidCancelledWhere(baseRange = {}) {
  return {
    orderStatus: { in: Array.from(CANCELLED_ORDER_STATUSES) },
    AND: [
      baseRange,
      {
        OR: [
          { incomeSyncedAt: { not: null } },
          { incomeNetCents: { not: null } },
          { incomeStatus: { not: null } },
        ],
      },
    ],
  };
}

function isoDateInOffsetNow(tzOffset) {
  const offsetMin = tzOffsetToMinutes(tzOffset);
  const now = new Date();
  const shifted = new Date(now.getTime() + offsetMin * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`; // YYYY-MM-DD
}

function addDaysIso(isoYmd, deltaDays) {
  const d = new Date(`${isoYmd}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfIsoDayInOffset(isoYmd, tzOffset) {
  return new Date(`${isoYmd}T00:00:00.000${tzOffset}`);
}

function buildPreviousClosedMonthRange(now = new Date(), tzOffset = SHOPEE_TZ) {
  const reference = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(reference.getTime())) return null;

  const shifted = new Date(
    reference.getTime() + tzOffsetToMinutes(tzOffset) * 60 * 1000,
  );
  const currentYear = shifted.getUTCFullYear();
  const currentMonthIndex = shifted.getUTCMonth();
  const previousMonthAnchor = new Date(Date.UTC(currentYear, currentMonthIndex - 1, 1));
  const year = previousMonthAnchor.getUTCFullYear();
  const month = previousMonthAnchor.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthText = String(month).padStart(2, "0");
  const dateFrom = `${year}-${monthText}-01`;
  const dateTo = `${year}-${monthText}-${String(lastDay).padStart(2, "0")}`;

  return {
    label: `${year}-${monthText}`,
    dateFrom,
    dateTo,
    start: new Date(`${dateFrom}T00:00:00.000${tzOffset}`),
    end: new Date(`${dateTo}T23:59:59.999${tzOffset}`),
  };
}

function buildPreviousClosedMonthSummary(range, aggregate = {}) {
  const gmvPreviousMonthCents = Number(aggregate?.total || 0);
  const paidOrdersPreviousMonth = Number(aggregate?.count || 0);

  return {
    period: {
      label: range?.label || null,
      dateFrom: range?.dateFrom || null,
      dateTo: range?.dateTo || null,
    },
    gmvPreviousMonthCents,
    paidOrdersPreviousMonth,
    avgTicketPreviousMonthCents: paidOrdersPreviousMonth
      ? Math.round(gmvPreviousMonthCents / paidOrdersPreviousMonth)
      : 0,
  };
}
async function getActiveShopOrFail(req, res) {
  if (!req.auth) return res.status(401).json({ error: "unauthorized" });
  const shopDbId = req.auth.activeShopId || null;
  if (!shopDbId) return res.status(409).json({ error: "select_shop_required" });

  const shop = await findShopByDbIdAndAccountId(shopDbId, req.auth.accountId);
  if (!shop) return res.status(404).json({ error: "shop_not_found" });
  return shop;
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function addMonths(d, n) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

function clampDayOfMonth(year, monthIndex, day) {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return Math.min(day, lastDay);
}

function pctDelta(curVal, prevVal) {
  if (!prevVal) return null;
  return Math.round(((curVal - prevVal) / prevVal) * 100);
}

function weekdayIndexInOffset(dateUtc, tzOffset = SHOPEE_TZ) {
  const offsetMin = tzOffsetToMinutes(tzOffset);
  const d = dateUtc instanceof Date ? dateUtc : new Date(dateUtc);
  const shiftedMs = d.getTime() + offsetMin * 60 * 1000;
  return new Date(shiftedMs).getUTCDay(); // 0=domingo ... 6=sabado
}

function formatMetricName(metricName) {
  return String(metricName || "")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeMetricKey(metricName) {
  return String(metricName || "")
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getMetricOverride(metricName) {
  return ACCOUNT_HEALTH_METRIC_OVERRIDES[normalizeMetricKey(metricName)] || null;
}

function getMetricDisplayName(metricName) {
  const override = getMetricOverride(metricName);
  return override?.label || formatMetricName(metricName);
}

function getMetricDescription(metricName) {
  return getMetricOverride(metricName)?.description || "";
}

function buildMetricSummary(metric, detail = { totalCount: 0, examples: [] }) {
  const override = getMetricOverride(metric?.metric_name);
  const compact = Boolean(override?.compact);
  const currentValue = Number(metric?.current_period);
  const targetValue = Number(metric?.target?.value);

  return {
    metricId: Number(metric?.metric_id),
    name: getMetricDisplayName(metric?.metric_name),
    typeLabel: override?.hideType
      ? ""
      : ACCOUNT_HEALTH_TYPES[Number(metric?.metric_type)] || "Conta",
    currentValue: Number.isFinite(currentValue) ? currentValue : null,
    currentLabel: formatMetricValue(metric?.current_period, Number(metric?.unit)),
    targetValue: Number.isFinite(targetValue) ? targetValue : null,
    targetLabel: `${metric?.target?.comparator || ""} ${formatMetricValue(
      metric?.target?.value,
      Number(metric?.unit),
    )}`.trim(),
    affectedCount: Number(detail.totalCount || 0),
    examples: compact ? [] : detail.examples || [],
    explanation: getMetricDescription(metric?.metric_name),
    showExamples: !compact,
    showAffectedCount: !compact,
    showTypeLabel: !override?.hideType,
    showTarget: !compact,
    isFailing: isMetricFailing(metric),
  };
}

function buildCustomerServiceSummary(metricList = []) {
  const sourceMetrics = metricList
    .filter((metric) => Number(metric?.metric_id) > 0)
    .filter((metric) => Number(metric?.metric_type) === 3);

  const serviceMetrics = metricList
    .filter((metric) => Number(metric?.metric_id) > 0)
    .filter((metric) => Number(metric?.metric_type) === 3)
    .map((metric) => buildMetricSummary(metric));

  const responseMetricSummary =
    serviceMetrics.find((metric) =>
      normalizeMetricKey(metric.name).includes("resposta"),
    ) ||
    serviceMetrics.find((metric) =>
      normalizeMetricKey(metric.name).includes("response"),
    ) ||
    serviceMetrics[0] ||
    null;

  const responseMetricSource =
    sourceMetrics.find((metric) =>
      normalizeMetricKey(metric.metric_name).includes("resposta"),
    ) ||
    sourceMetrics.find((metric) =>
      normalizeMetricKey(metric.metric_name).includes("response"),
    ) ||
    sourceMetrics[0] ||
    null;

  const failingCount = serviceMetrics.filter((metric) => metric.isFailing).length;
  const responseRatePct = Number(responseMetricSource?.current_period);

  return {
    responseRateLabel: responseMetricSummary?.name || "Taxa de respostas",
    responseRateValue: responseMetricSummary?.currentLabel || "Indisponivel",
    responseRatePct: Number.isFinite(responseRatePct) ? responseRatePct : null,
    summaryText: serviceMetrics.length
      ? `${serviceMetrics.length} metrica(s) de SAC monitoradas - ${failingCount} fora da meta`
      : "Sem metricas de atendimento disponiveis no momento.",
    metrics: serviceMetrics.map((metric) => ({
      name: metric.name,
      currentLabel: metric.currentLabel,
      targetLabel: metric.targetLabel,
      explanation: metric.explanation,
      isFailing: metric.isFailing,
    })),
  };
}

function formatMetricValue(value, unit) {
  if (value == null || value === "") return "—";

  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);

  if (unit === 2) return `${num.toFixed(2).replace(".", ",")}%`;
  if (unit === 3) return `${num.toFixed(0)} s`;
  if (unit === 4) return `${num.toFixed(2).replace(".", ",")} dia(s)`;
  if (unit === 5) return `${num.toFixed(2).replace(".", ",")} h`;
  if (Number.isInteger(num)) return String(num);
  return num.toFixed(2).replace(".", ",");
}

function compareMetric(current, comparator, target) {
  if (current == null || comparator == null || target == null) return false;

  switch (String(comparator)) {
    case "<":
      return Number(current) < Number(target);
    case "<=":
      return Number(current) <= Number(target);
    case ">":
      return Number(current) > Number(target);
    case ">=":
      return Number(current) >= Number(target);
    case "=":
      return Number(current) === Number(target);
    default:
      return false;
  }
}

function isMetricFailing(metric) {
  const current = metric?.current_period;
  const comparator = metric?.target?.comparator;
  const target = metric?.target?.value;

  if (current == null || comparator == null || target == null) return false;
  return !compareMetric(current, comparator, target);
}

function buildSpxListingRateFromActiveListings({
  activeListings = 0,
  spxEnabledActiveListings = 0,
  fallbackMetric = null,
}) {
  const totalActive = Math.max(0, Number(activeListings) || 0);
  const totalSpxActive = Math.max(
    0,
    Math.min(totalActive, Number(spxEnabledActiveListings) || 0),
  );
  const pct = totalActive > 0 ? (totalSpxActive / totalActive) * 100 : 0;
  const currentLabel = formatMetricValue(pct, 2);
  const fallbackTargetLabel = String(fallbackMetric?.targetLabel || "").trim();
  const targetLabel = fallbackTargetLabel || "";
  const explanation =
    totalActive > 0
      ? `${totalSpxActive} de ${totalActive} anuncios ativos com SPX habilitado.`
      : "Nenhum anuncio ativo para calcular a taxa de SPX.";

  return {
    metricId: 2035,
    name: "% anuncios com SPX",
    typeLabel: "Anuncios",
    currentValue: Number(pct.toFixed(2)),
    currentLabel,
    targetValue: fallbackMetric?.targetValue ?? null,
    targetLabel,
    affectedCount: totalSpxActive,
    examples: [],
    explanation,
    showExamples: false,
    showAffectedCount: true,
    showTypeLabel: true,
    showTarget: Boolean(targetLabel),
    isFailing: false,
    dataSource: "local_active_listings",
    totalActiveListings: totalActive,
    spxEnabledActiveListings: totalSpxActive,
  };
}

function getMetricSourceItems(metricId, response) {
  const source = response || {};
  if ([1, 85].includes(metricId)) return source.lsr_order_list || [];
  if ([3, 88].includes(metricId)) return source.nfr_order_list || [];
  if ([4, 2033].includes(metricId)) return source.apt_order_list || [];
  if ([25, 2001, 2002, 2003].includes(metricId)) return source.fhr_order_list || [];
  if ([42, 91].includes(metricId)) return source.cancellation_order_list || [];
  if ([43, 92].includes(metricId)) return source.return_refund_order_list || [];
  if ([52, 53].includes(metricId)) return source.violation_listing_list || [];
  if ([12].includes(metricId)) return source.pre_order_listing_list || [];
  if ([15].includes(metricId)) {
    return source.pre_order_listing_violation_data_list || [];
  }
  if ([28].includes(metricId)) return source.opfr_day_detail_data_list || [];
  if ([96].includes(metricId)) return source.sdd_listing_list || [];
  if ([97].includes(metricId)) return source.ndd_listing_list || [];
  if ([2035].includes(metricId)) return source.spx_listing_list || [];
  if ([2030, 2031].includes(metricId)) {
    const list = source.hd_listing_list;
    return Array.isArray(list) ? list : list ? [list] : [];
  }
  if ([2032].includes(metricId)) return source.saturday_shipment_list || [];
  return [];
}

function collectMetricSourceItemIds(metricId, response) {
  return Array.from(
    new Set(
      getMetricSourceItems(metricId, response)
        .map((item) => String(item?.item_id || "").trim())
        .filter((itemId) => /^\d+$/.test(itemId)),
    ),
  );
}

async function loadProductTitleMap(shopId, itemIds = []) {
  const ids = Array.from(
    new Set(
      itemIds
        .map((itemId) => String(itemId || "").trim())
        .filter((itemId) => /^\d+$/.test(itemId)),
    ),
  );

  if (!ids.length) return new Map();

  const products = await listProductsByShopAndItemIds(shopId, ids);

  return new Map(
    products.map((product) => [String(product.itemId), product.title || null]),
  );
}

function getMetricSourceExamples(metricId, response, productTitleMap = new Map()) {
  const items = getMetricSourceItems(metricId, response).slice(0, 3);

  return items
    .map((item) => {
      if (item?.order_sn && item?.late_by_days != null) {
        return `Pedido ${item.order_sn} • atraso ${item.late_by_days}d`;
      }
      if (item?.order_sn) return `Pedido ${item.order_sn}`;
      if (item?.item_id) {
        if (metricId === 2035) {
          const status =
            Number(item?.current_spx_status) === 1
              ? "SPX: Sim"
              : Number(item?.current_spx_status) === 2
                ? "SPX: Nao"
                : "SPX: Indisponivel";
          const itemLabel =
            productTitleMap.get(String(item.item_id)) || `Item ${item.item_id}`;
          return `${itemLabel} • ${status}`;
        }
        return productTitleMap.get(String(item.item_id)) || `Item ${item.item_id}`;
      }
      if (item?.date && item?.target) return `${item.date} • meta ${item.target}`;
      if (item?.date && item?.opfr != null) return `${item.date} • OPFR ${item.opfr}`;
      return null;
    })
    .filter(Boolean);
}

async function loadAccountHealthSummary(shop) {
  try {
    const [performancePayload, lateOrdersPayload] = await Promise.all([
      ShopeeAccountHealthService.getShopPerformance({
        shopId: String(shop.shopId),
      }),
      ShopeeAccountHealthService.getLateOrders({
        shopId: String(shop.shopId),
        pageSize: 5,
      }),
    ]);

    const performance = performancePayload?.response || {};
    const overall = performance?.overall_performance || {};
    const metricList = Array.isArray(performance?.metric_list)
      ? performance.metric_list
      : [];

    const failedMetrics = metricList
      .filter((metric) => Number(metric?.metric_id) > 0)
      .filter((metric) => isMetricFailing(metric));

    const detailedMetrics = failedMetrics
      .filter((metric) =>
        ACCOUNT_HEALTH_DETAIL_SUPPORTED.has(Number(metric.metric_id)),
      )
      .slice(0, 3);

    const detailResults = await Promise.all(
      detailedMetrics.map(async (metric) => {
        try {
          const detailPayload =
            await ShopeeAccountHealthService.getMetricSourceDetail({
              shopId: String(shop.shopId),
              metricId: Number(metric.metric_id),
              pageSize: 3,
            });
          const detailResponse = detailPayload?.response || {};
          const productTitleMap = await loadProductTitleMap(
            shop.id,
            collectMetricSourceItemIds(Number(metric.metric_id), detailResponse),
          );

          return {
            metricId: Number(metric.metric_id),
            totalCount: Number(detailResponse?.total_count || 0),
            examples: getMetricSourceExamples(
              Number(metric.metric_id),
              detailResponse,
              productTitleMap,
            ),
          };
        } catch {
          return {
            metricId: Number(metric.metric_id),
            totalCount: 0,
            examples: [],
          };
        }
      }),
    );

    const detailMap = new Map(
      detailResults.map((entry) => [Number(entry.metricId), entry]),
    );

    const ratingInfo =
      ACCOUNT_HEALTH_RATINGS[Number(overall?.rating)] || ACCOUNT_HEALTH_RATINGS[2];
    const lateOrdersResponse = lateOrdersPayload?.response || {};
    const lateOrderList = Array.isArray(lateOrdersResponse?.late_order_list)
      ? lateOrdersResponse.late_order_list
      : [];
    const spxMetricRaw =
      metricList.find((metric) => Number(metric?.metric_id) === 2035) || null;
    const spxListingRate = spxMetricRaw
      ? buildMetricSummary(spxMetricRaw, {
          totalCount: 0,
          examples: [],
        })
      : null;

    return {
      status: "ok",
      overall: {
        rating: Number(overall?.rating || 0),
        label: ratingInfo.label,
        tone: ratingInfo.tone,
        failedCount:
          Number(overall?.fulfillment_failed || 0) +
          Number(overall?.listing_failed || 0) +
          Number(overall?.custom_service_failed || 0),
        fulfillmentFailed: Number(overall?.fulfillment_failed || 0),
        listingFailed: Number(overall?.listing_failed || 0),
        customerServiceFailed: Number(overall?.custom_service_failed || 0),
      },
      lateOrders: {
        totalCount: Number(lateOrdersResponse?.total_count || 0),
        items: lateOrderList.slice(0, 3).map((item) => ({
          orderSn: item?.order_sn || "",
          lateByDays: Number(item?.late_by_days || 0),
        })),
      },
      highlightMetrics: failedMetrics.slice(0, 3).map((metric) => {
        const detail = detailMap.get(Number(metric.metric_id)) || {
          totalCount: 0,
          examples: [],
        };
        return buildMetricSummary(metric, detail);
      }),
      spxListingRate,
      customerService: buildCustomerServiceSummary(metricList),
    };
  } catch (error) {
    return {
      status: "unavailable",
      message: String(error?.message || "Nao foi possivel consultar a Shopee"),
      overall: {
        rating: 0,
        label: "Indisponivel",
        tone: "muted",
        failedCount: 0,
        fulfillmentFailed: 0,
        listingFailed: 0,
        customerServiceFailed: 0,
      },
      lateOrders: {
        totalCount: 0,
        items: [],
      },
      highlightMetrics: [],
      spxListingRate: null,
      customerService: {
        responseRateLabel: "Taxa de respostas",
        responseRateValue: "Indisponivel",
        responseRatePct: null,
        summaryText: "Sem metricas de atendimento disponiveis no momento.",
        metrics: [],
      },
    };
  }
}

async function loadShopRatingSummary(shopId) {
  const products = await listProductsWithRatings(shopId);

  let weightedStars = 0;
  let totalRatings = 0;

  for (const product of products) {
    const star = Number(product?.ratingStar);
    const count = Number(product?.ratingCount || 0);
    if (!Number.isFinite(star) || count <= 0) continue;
    weightedStars += star * count;
    totalRatings += count;
  }

  return {
    average:
      totalRatings > 0 ? Number((weightedStars / totalRatings).toFixed(2)) : null,
    totalRatings,
    productsWithRatings: products.length,
  };
}

async function aggMtd({ shopId, from, to }) {
  const agg = await aggregatePaidOrdersInRange(shopId, from, to);
  const gmv = Number(agg?.total || 0);
  const orders = Number(agg?.count || 0);
  const ticket = orders > 0 ? Math.round(gmv / orders) : 0;

  return { gmvMtdCents: gmv, ordersCountMtd: orders, ticketAvgCents: ticket };
}

async function monthlySales(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const previousClosedMonthRange = buildPreviousClosedMonthRange(now, SHOPEE_TZ);
    const daysInMonth = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0,
    ).getDate();
    const dayOfMonth = now.getDate();

    // ----- RANGE MTD "espelho" do mês anterior (mesmos dias/horário) -----
    const prevMonthDate = addMonths(now, -1);
    const prevFrom = startOfMonth(prevMonthDate);

    const prevDay = clampDayOfMonth(
      prevFrom.getFullYear(),
      prevFrom.getMonth(),
      now.getDate(),
    );
    const prevTo = new Date(
      prevFrom.getFullYear(),
      prevFrom.getMonth(),
      prevDay,
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds(),
    );

    const prevAgg = await aggMtd({
      shopId: shop.id,
      from: prevFrom,
      to: prevTo,
    });

    const prevFullMonthRawAgg = await aggregatePaidOrdersInRange(
      shop.id,
      previousClosedMonthRange.start,
      previousClosedMonthRange.end,
    );
    const previousClosedMonth = buildPreviousClosedMonthSummary(
      previousClosedMonthRange,
      prevFullMonthRawAgg,
    );
    const prevFullMonthAgg = {
      gmvMtdCents: previousClosedMonth.gmvPreviousMonthCents,
      ordersCountMtd: previousClosedMonth.paidOrdersPreviousMonth,
      ticketAvgCents: previousClosedMonth.avgTicketPreviousMonthCents,
    };

    // ----- Pedidos do mês (para montar dailyBars) -----
    const orders = await listPaidOrdersInRange(shop.id, start, now, "DESC");
    const heatmapWindowDays = 30;
    const heatmapStart = new Date(now);
    heatmapStart.setDate(heatmapStart.getDate() - (heatmapWindowDays - 1));
    heatmapStart.setHours(0, 0, 0, 0);
    const heatmapOrders = await listPaidOrdersInRange(
      shop.id,
      heatmapStart,
      now,
      "DESC",
    );

    const dailyBars = Array.from({ length: daysInMonth }, (_, i) => ({
      day: i + 1,
      gmvCents: 0,
    }));
    const heatmapWeekdays = [
      "Domingo",
      "Segunda",
      "Terca",
      "Quarta",
      "Quinta",
      "Sexta",
      "Sabado",
    ];
    const heatmapRows = heatmapWeekdays.map((label, weekdayIndex) => ({
      weekdayIndex,
      label,
      totalOrders: 0,
      totalGmvCents: 0,
      hours: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        orders: 0,
        gmvCents: 0,
      })),
    }));

    let gmvMtdCents = 0;

    for (const o of orders) {
      const dt = o.shopeeCreateTime || o.createdAt;
      const cents = Number(o.gmvCents || 0);
      gmvMtdCents += cents;

      const d = dt.getDate();
      if (d >= 1 && d <= daysInMonth) {
        dailyBars[d - 1].gmvCents += cents;
      }
    }

    for (const o of heatmapOrders) {
      const dt = o.shopeeCreateTime || o.createdAt;
      const cents = Number(o.gmvCents || 0);
      const weekdayIndex = weekdayIndexInOffset(dt, SHOPEE_TZ);
      const hour = hourIndexInOffset(dt, SHOPEE_TZ);
      if (
        weekdayIndex >= 0 &&
        weekdayIndex <= 6 &&
        hour >= 0 &&
        hour <= 23 &&
        heatmapRows[weekdayIndex] &&
        heatmapRows[weekdayIndex].hours[hour]
      ) {
        heatmapRows[weekdayIndex].totalOrders += 1;
        heatmapRows[weekdayIndex].totalGmvCents += cents;
        heatmapRows[weekdayIndex].hours[hour].orders += 1;
        heatmapRows[weekdayIndex].hours[hour].gmvCents += cents;
      }
    }

    const heatmapFlatCells = heatmapRows.flatMap((row) =>
      row.hours.map((cell) => ({
        weekdayIndex: row.weekdayIndex,
        weekdayLabel: row.label,
        hour: cell.hour,
        orders: Number(cell.orders || 0),
        gmvCents: Number(cell.gmvCents || 0),
      })),
    );
    const heatmapMaxOrders = heatmapFlatCells.reduce(
      (max, cell) => Math.max(max, Number(cell.orders || 0)),
      0,
    );
    const heatmapMinOrders = heatmapFlatCells.reduce(
      (min, cell) => Math.min(min, Number(cell.orders || 0)),
      Number.POSITIVE_INFINITY,
    );
    const heatmapHottest = heatmapFlatCells.reduce(
      (best, cell) =>
        (cell.orders || 0) > (best?.orders || 0)
          ? cell
          : best,
      null,
    );
    const heatmapColdest = heatmapFlatCells.reduce(
      (worst, cell) =>
        (cell.orders || 0) < (worst?.orders || Number.POSITIVE_INFINITY)
          ? cell
          : worst,
      null,
    );

    const avgPerDayCents = Math.round(gmvMtdCents / Math.max(1, dayOfMonth));
    const projectionCents = avgPerDayCents * daysInMonth;

    const ordersCountMtd = orders.length;
    const ticketAvgCents = ordersCountMtd
      ? Math.round(gmvMtdCents / ordersCountMtd)
      : 0;

    const compare = {
      prev: prevAgg,
      prevFullMonth: prevFullMonthAgg,
      delta: {
        gmvDeltaCents: gmvMtdCents - prevAgg.gmvMtdCents,
        gmvDeltaPct: pctDelta(gmvMtdCents, prevAgg.gmvMtdCents),

        ordersDeltaCount: ordersCountMtd - prevAgg.ordersCountMtd,
        ordersDeltaPct: pctDelta(ordersCountMtd, prevAgg.ordersCountMtd),

        ticketDeltaCents: ticketAvgCents - prevAgg.ticketAvgCents,
        ticketDeltaPct: pctDelta(ticketAvgCents, prevAgg.ticketAvgCents),
      },
    };

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    res.json({
      period: {
        label: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
        dayOfMonth,
        daysInMonth,
        progressPct: Math.round((dayOfMonth / daysInMonth) * 100),
      },
      metrics: {
        gmvMtdCents,
        avgPerDayCents,
        projectionCents,
        ordersCountMtd,
        ticketAvgCents,
        adsAttributedCents: null,
        adsStatus: "not_configured",
        organicEstimatedCents: gmvMtdCents,
      },
      dailyBars,
      previousClosedMonth,
      heatmap: {
        weekdays: heatmapWeekdays,
        hours: Array.from({ length: 24 }, (_unused, index) => index),
        rows: heatmapRows,
        stats: {
          windowDays: heatmapWindowDays,
          dateFrom: heatmapStart.toISOString(),
          dateTo: now.toISOString(),
          maxOrders: heatmapMaxOrders,
          minOrders: Number.isFinite(heatmapMinOrders) ? heatmapMinOrders : 0,
          hottest: heatmapHottest,
          coldest: heatmapColdest,
        },
      },
      compare,
    });
  } catch (e) {
    console.error("dashboard.monthlySales failed:", e);
    res.status(500).json({
      error: "dashboard_monthly_sales_failed",
      message: String(e?.message || e),
    });
  }
}

async function todaySales(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const now = new Date();

    // “Hoje” e “ontem” no fuso do relatório (ex.: -03:00)
    const todayIso = isoDateInOffsetNow(SHOPEE_TZ);
    const yesterdayIso = addDaysIso(todayIso, -1);

    // Início de hoje/ontem (instantes UTC equivalentes ao 00:00 local do offset)
    const startToday = startOfIsoDayInOffset(todayIso, SHOPEE_TZ);
    const startYesterday = startOfIsoDayInOffset(yesterdayIso, SHOPEE_TZ);

    const orders = await listPaidOrdersInRange(
      shop.id,
      startYesterday,
      now,
      "DESC",
    );

    const hourlyToday = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      gmvCents: 0,
    }));
    const hourlyYesterday = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      gmvCents: 0,
    }));

    let gmvTodayCents = 0;
    let gmvYesterdayCents = 0;
    let ordersCountToday = 0;
    let ordersCountYesterday = 0;

    for (const o of orders) {
      const dt = o.shopeeCreateTime || o.createdAt;
      const cents = Number(o.gmvCents || 0);

      if (dt >= startToday) {
        const h = hourIndexInOffset(dt, SHOPEE_TZ);
        hourlyToday[h].gmvCents += cents;
        gmvTodayCents += cents;
        ordersCountToday += 1;
      } else if (dt >= startYesterday && dt < startToday) {
        const h = hourIndexInOffset(dt, SHOPEE_TZ);
        hourlyYesterday[h].gmvCents += cents;
        gmvYesterdayCents += cents;
        ordersCountYesterday += 1;
      }
    }

    const currentHour = hourIndexInOffset(now, SHOPEE_TZ);

    const sumUpToHour = (arr, h) =>
      arr.slice(0, h + 1).reduce((s, x) => s + Number(x.gmvCents || 0), 0);

    const cumTodayCents = sumUpToHour(hourlyToday, currentHour);
    const cumYesterdayCents = sumUpToHour(hourlyYesterday, currentHour);

    const deltaCents = cumTodayCents - cumYesterdayCents;
    const deltaPct =
      cumYesterdayCents > 0
        ? Math.round((deltaCents / cumYesterdayCents) * 100)
        : null;

    const ticketAvgTodayCents = ordersCountToday
      ? Math.round(gmvTodayCents / ordersCountToday)
      : 0;

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    res.json({
      period: {
        label: "Hoje",
        dayLabel: todayIso, // evita confusão de timezone no servidor
      },
      metrics: {
        gmvTodayCents,
        ordersCountToday,
        ticketAvgTodayCents,
        gmvYesterdayCents,
        ordersCountYesterday,
        currentHour,
        deltaCents,
        deltaPct,
      },
      hourlyBarsToday: hourlyToday,
      hourlyBarsYesterday: hourlyYesterday,
    });
  } catch (e) {
    console.error("dashboard.todaySales failed:", e);
    res.status(500).json({
      error: "dashboard_today_sales_failed",
      message: String(e?.message || e),
    });
  }
}

/**
 * Fallback: sem OrderItem ainda, não dá pra calcular top do mês por GMV real.
 * Aqui retorna "quantity" baseado em Product.sold (geral) e "gmvCents" zerado
 * só pra não quebrar o widget no front.
 */
async function topSellersMonth(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Top 10 produtos mais vendidos do mês (por quantidade)
    const topProducts = await groupTopProductsByQuantitySince(
      shop.id,
      startOfMonth,
      10,
    );

    const productIds = topProducts.map((row) => row.productId);
    const products = await listProductTitlesByIds(productIds);
    const productMap = Object.fromEntries(products.map((p) => [p.id, p.title]));

    const orderItems = await listOrderItemsForProductsSince(
      shop.id,
      productIds,
      startOfMonth,
    );

    const orderIds = [...new Set(orderItems.map((oi) => oi.orderId))];
    const orders = await listOrdersGmvByIds(orderIds);

    const orderGmvMap = Object.fromEntries(
      orders.map((o) => [o.id, o.gmvCents || 0]),
    );

    // Calcular quantidade total de items por order para proporção
    const orderItemQuantityMap = {};
    for (const oi of orderItems) {
      if (!orderItemQuantityMap[oi.orderId])
        orderItemQuantityMap[oi.orderId] = 0;
      orderItemQuantityMap[oi.orderId] += Number(oi.quantity) || 0;
    }

    // Calcular GMV proporcional por produto
    const productGmvMap = {};
    const productQuantityMap = {};
    for (const oi of orderItems) {
      if (!productGmvMap[oi.productId]) productGmvMap[oi.productId] = 0;
      if (!productQuantityMap[oi.productId])
        productQuantityMap[oi.productId] = 0;

      const itemQty = Number(oi.quantity) || 0;
      const totalQtyInOrder = orderItemQuantityMap[oi.orderId] || 1;
      const orderGmv = orderGmvMap[oi.orderId] || 0;

      // GMV proporcional = (itemQty / totalQtyInOrder) * orderGmv
      const proportionalGmv = (itemQty / totalQtyInOrder) * orderGmv;
      productGmvMap[oi.productId] += proportionalGmv;
      productQuantityMap[oi.productId] += itemQty;
    }

    const items = topProducts.map((tp) => ({
      title: productMap[tp.productId] || "-",
      quantity: Number(tp.quantity || 0),
      gmvCents: Math.round(productGmvMap[tp.productId] || 0),
    }));

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    res.json({ items });
  } catch (e) {
    console.error("dashboard.topSellersMonth failed:", e);
    res.status(500).json({
      error: "dashboard_top_sellers_failed",
      message: String(e?.message || e),
    });
  }
}

async function controlPanelSummary(req, res) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;
    const forceRefresh = String(req.query?.force || "").trim() === "1";

    if (!forceRefresh) {
      const cachedPayload = readControlPanelCache(shop.id);
      if (cachedPayload) {
        res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
        res.set("Pragma", "no-cache");
        res.set("Expires", "0");
        return res.json(cachedPayload);
      }
    }

    const now = new Date();
    const from30d = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const previousClosedMonthRange = buildPreviousClosedMonthRange(now, SHOPEE_TZ);
    const adsDateFrom = toReportIsoDate(monthStart);
    const adsDateTo = toReportIsoDate(now);
    const adsMetricsPromise = adsDateFrom && adsDateTo
      ? collectRoasMetricsForRange({
          shop,
          shopDbId: shop.id,
          start: new Date(`${adsDateFrom}T00:00:00.000${SHOPEE_TZ}`),
          end: new Date(`${adsDateTo}T23:59:59.999${SHOPEE_TZ}`),
          dateFrom: adsDateFrom,
          dateTo: adsDateTo,
        }).catch((error) => {
          console.warn("[DashboardController] Ads contribution unavailable", {
            shopId: shop.id,
            message: error?.message,
            code: error?.code,
          });
          return null;
        })
      : Promise.resolve(null);
    const accountHealthPromise = loadAccountHealthSummary(shop);

    const [paidOrders30d, paidOrdersMtd] = await Promise.all([
      listPaidOrdersInRange(shop.id, from30d, now, "ASC"),
      listPaidOrdersInRange(shop.id, monthStart, now, "ASC"),
    ]);

    const [
      activeListings,
      pausedListings,
      spxEnabledActiveListings,
      totalOrders30d,
      ordersCountMtd,
      totalOrdersMonth,
      cancelledOrders30d,
      returnedOrders30d,
      activeAdGroups,
      gmvMtdAgg,
      previousClosedMonthAgg,
      shopRating,
      adsMetrics,
    ] = await Promise.all([
      countProductsForShop(shop.id),
      countPausedProductsForShop(shop.id),
      countSpxEnabledActiveProductsForShop(shop.id),
      countOrdersInRange(shop.id, from30d, now),
      countPaidOrdersInRange(shop.id, monthStart, now),
      countOrdersInRange(shop.id, monthStart, now),
      countCancelledPaidOrdersInRange(shop.id, from30d, now),
      countReturnedOrdersInRange(shop.id, from30d, now),
      countAdsCampaignGroups(shop.id),
      aggregatePaidOrdersInRange(shop.id, monthStart, now),
      aggregatePaidOrdersInRange(
        shop.id,
        previousClosedMonthRange.start,
        previousClosedMonthRange.end,
      ),
      loadShopRatingSummary(shop.id),
      adsMetricsPromise,
    ]);
    const previousClosedMonth = buildPreviousClosedMonthSummary(
      previousClosedMonthRange,
      previousClosedMonthAgg,
    );
    const {
      summary: priceIncreaseSummary,
      recent: recentPriceUpdates,
    } = await loadPriceIncreaseDashboardData(shop.id, now);
    const recentPriceUpdateItems = Array.isArray(recentPriceUpdates)
      ? recentPriceUpdates
      : Array.isArray(recentPriceUpdates?.items)
        ? recentPriceUpdates.items
        : [];

    const paidOrderIds = paidOrders30d.map((order) => order.id);
    const soldProductsRows = paidOrderIds.length
      ? await groupSoldProductsByOrderIds(shop.id, paidOrderIds)
      : [];
    const paidOrderIdsMtd = paidOrdersMtd.map((order) => order.id);
    const soldProductsRowsMtd = paidOrderIdsMtd.length
      ? await groupSoldProductsByOrderIds(shop.id, paidOrderIdsMtd)
      : [];

    const listingsWithSales30d = soldProductsRows.length;
    const unitsSold30d = soldProductsRows.reduce(
      (sum, row) => sum + Number(row?.quantity || 0),
      0,
    );
    const unitsSoldMtd = soldProductsRowsMtd.reduce(
      (sum, row) => sum + Number(row?.quantity || 0),
      0,
    );
    const gmv30dCents = paidOrders30d.reduce(
      (sum, order) => sum + Number(order.gmvCents || 0),
      0,
    );
    const paidOrdersCount30d = paidOrders30d.length;
    const avgTicket30dCents = paidOrdersCount30d
      ? Math.round(gmv30dCents / paidOrdersCount30d)
      : 0;
    const gmvMtdCents = Number(gmvMtdAgg?.total || 0);
    const avgTicketMtdCents = ordersCountMtd
      ? Math.round(gmvMtdCents / ordersCountMtd)
      : 0;
    const conversionPaidPct30d = totalOrders30d
      ? Number(((paidOrdersCount30d / totalOrders30d) * 100).toFixed(1))
      : 0;
    const listingsWithSalesPct = activeListings
      ? Number(((listingsWithSales30d / activeListings) * 100).toFixed(1))
      : 0;
    const monthPaidRatePct = totalOrdersMonth
      ? Number(((ordersCountMtd / totalOrdersMonth) * 100).toFixed(1))
      : 0;
    const conversionPaidPctMtd = totalOrdersMonth
      ? Number(((ordersCountMtd / totalOrdersMonth) * 100).toFixed(1))
      : 0;

    const dailyMap = new Map();
    for (let index = 29; index >= 0; index -= 1) {
      const date = new Date(now.getTime() - index * 24 * 60 * 60 * 1000);
      const key = date.toISOString().slice(0, 10);
      dailyMap.set(key, {
        date: key,
        label: date.toLocaleDateString("pt-BR", {
          day: "2-digit",
          month: "2-digit",
        }),
        gmvCents: 0,
        orders: 0,
      });
    }

    for (const order of paidOrders30d) {
      const when = order.shopeeCreateTime || order.createdAt;
      const key = new Date(when).toISOString().slice(0, 10);
      if (!dailyMap.has(key)) continue;
      const bucket = dailyMap.get(key);
      bucket.gmvCents += Number(order.gmvCents || 0);
      bucket.orders += 1;
    }

    const topProducts = soldProductsRows
      .slice()
      .sort((a, b) => Number(b?.quantity || 0) - Number(a?.quantity || 0))
      .slice(0, 5);

    const topProductIds = topProducts
      .map((row) => row.productId)
      .filter((id) => id != null);

    const productNames = topProductIds.length
      ? await listProductTitlesByIds(topProductIds)
      : [];

    const productNameMap = new Map(productNames.map((item) => [item.id, item.title]));

    const accountHealthRaw = await accountHealthPromise;
    const accountHealth = {
      ...accountHealthRaw,
      spxListingRate: buildSpxListingRateFromActiveListings({
        activeListings,
        spxEnabledActiveListings,
        fallbackMetric: accountHealthRaw?.spxListingRate || null,
      }),
    };

    const payload = {
      generatedAt: now.toISOString(),
      shop: {
        id: shop.id,
        shopId: String(shop.shopId || ""),
        name: shop.name || "Loja Shopee",
      },
      metrics: {
        gmvMtdCents,
        avgTicketMtdCents,
        totalOrdersMonth,
        paidOrdersMtd: ordersCountMtd,
        unitsSoldMtd,
        conversionPaidPctMtd,
        totalListings: activeListings,
        activeListings,
        spxEnabledActiveListings,
        pausedListings,
        listingsWithSales30d,
        listingsWithSalesPct,
        totalOrders30d,
        paidOrders30d: paidOrdersCount30d,
        cancelledOrders30d,
        returnedOrders30d,
        gmv30dCents,
        avgTicket30dCents,
        unitsSold30d,
        conversionPaidPct30d,
        ordersCountMtd,
        monthPaidRatePct,
        activeAdGroups,
        adsAttributedSalesCents: Number(adsMetrics?.metrics?.attributedGmvCents || 0),
        adsContributionPct: adsMetrics?.metrics?.adsRevenueSharePct ?? null,
        adsAttributedOrders: Number(adsMetrics?.counts?.ordersMatched || 0),
        adsMetricsSource: adsMetrics?.sourceAdsTotals || "unavailable",
      },
      previousClosedMonth,
      dailyBars30d: Array.from(dailyMap.values()),
      topProducts30d: topProducts.map((row) => ({
        productId: row.productId,
        title: productNameMap.get(row.productId) || "Produto",
        quantity: Number(row?.quantity || 0),
      })),
      priceIncrease: {
        summary: {
          blockedItems: Number(priceIncreaseSummary?.blockedItems || 0),
          totalRecentEvents: Number(priceIncreaseSummary?.totalRecentEvents || 0),
        },
        items: recentPriceUpdateItems
          .slice(0, 8)
          .map((event) => {
            const lockUntilDate = event?.lockUntil ? new Date(event.lockUntil) : null;
            const remaining = formatRemainingFromLock(lockUntilDate, now);
            return {
              itemId: event.itemId == null ? null : String(event.itemId),
              modelId: event.modelId == null ? null : String(event.modelId),
              title: event.productTitle || "Produto",
              itemSku: event.itemSku || null,
              oldValue: event.oldValue,
              newValue: event.newValue,
              updateField: event.updateField || null,
              updateTime: event.updateTime || null,
              lockUntil: event.lockUntil || null,
              isBlockedForPromotion: Boolean(event.isBlockedForPromotion),
              isBlockedNow: remaining.isBlocked,
              remainingMs: remaining.remainingMs,
              remainingLabel: remaining.remainingLabel,
            };
          }),
      },
      shopRating,
      accountHealth,
    };

    writeControlPanelCache(shop.id, payload);

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    return res.json(payload);
  } catch (e) {
    console.error("dashboard.controlPanelSummary failed:", e);
    return res.status(500).json({
      error: "dashboard_control_panel_failed",
      message: String(e?.message || e),
    });
  }
}

module.exports = {
  monthlySales,
  todaySales,
  topSellersMonth,
  controlPanelSummary,
  _test: { buildPreviousClosedMonthRange, buildPreviousClosedMonthSummary },
};
