const { requestShopeeAuthed } = require("../services/ShopeeAuthedHttp");
const {
  getIncomeInfo,
  getBuyerPaymentInfo,
  getOrderAdjustments,
  getReturnOrderSnList,
  getBuyerUserName,
  hasRichEscrowPayload,
} = require("../utils/orderEscrow");
const { findShopForAccountById } = require("../repositories/runtimeSqlRepository");
const {
  countOrdersForShop,
  findOrderDetailByShopAndOrderSn,
  listOrdersForShop,
  listPendingAddressAlertCountsByOrderIds,
  updateOrderEscrowDetail,
} = require("../repositories/ordersSqlRepository");

async function getActiveShopOrFail(req, res) {
  if (!req.auth) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  const shopDbId = req.auth.activeShopId || null;
  if (!shopDbId) {
    res.status(409).json({
      error: "select_shop_required",
      message: "Selecione uma loja para continuar.",
    });
    return null;
  }
  const shop = await findShopForAccountById(shopDbId, req.auth.accountId);
  if (!shop) {
    res.status(404).json({ error: "shop_not_found" });
    return null;
  }
  return shop;
}

function normalizeStatus(s) {
  return String(s || "")
    .toUpperCase()
    .trim();
}

function shouldShowAddressAlert(status) {
  return normalizeStatus(status) === "READY_TO_SHIP";
}

function parseMoneyToCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function getOrderItemsSubtotalCents(order) {
  const value = Number(order?.itemsSubtotalCents);
  return Number.isFinite(value) ? value : 0;
}

function buildIncomeItemMap(order) {
  const info = getIncomeInfo(order);
  const items = Array.isArray(info?.items) ? info.items : [];
  const map = new Map();

  for (const item of items) {
    const itemId = item?.item_id != null ? String(item.item_id) : "";
    const modelId = item?.model_id != null ? String(item.model_id) : "";
    const modelSku = item?.model_sku ? String(item.model_sku).trim().toUpperCase() : "";
    const itemSku = item?.item_sku ? String(item.item_sku).trim().toUpperCase() : "";

    const keyCandidates = [
      itemId && modelId ? `${itemId}:${modelId}` : "",
      modelSku ? `modelsku:${modelSku}` : "",
      itemSku ? `itemsku:${itemSku}` : "",
      itemId ? `${itemId}:item` : "",
    ].filter(Boolean);

    for (const key of keyCandidates) {
      if (!map.has(key)) map.set(key, item);
    }
  }

  return map;
}

function resolveIncomeItem(map, item) {
  if (!map || !item) return null;
  const keys = [
    item.itemId != null && item.modelId != null ? `${item.itemId}:${item.modelId}` : "",
    item.modelSku ? `modelsku:${String(item.modelSku).trim().toUpperCase()}` : "",
    item.itemSku ? `itemsku:${String(item.itemSku).trim().toUpperCase()}` : "",
    item.itemId != null ? `${item.itemId}:item` : "",
  ].filter(Boolean);

  for (const key of keys) {
    const match = map.get(key);
    if (match) return match;
  }

  return null;
}

function estimateItemUnitPriceCents(order, items, item) {
  const quantity = Math.max(1, Number(item?.quantity || 0));
  const totalQty = Math.max(
    1,
    items.reduce((sum, row) => sum + Math.max(1, Number(row?.quantity || 0)), 0),
  );
  const subtotal = getOrderItemsSubtotalCents(order);
  if (!subtotal) return 0;
  return Math.round(subtotal / totalQty);
}

function buildDisplayOrderItems(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const incomeItemMap = buildIncomeItemMap(order);

  return items.map((item) => {
    const incomeItem = resolveIncomeItem(incomeItemMap, item) || {};
    const quantity = Math.max(1, Number(item?.quantity || 0));

    const rawPriceCentsCandidates = [
      item.dealPrice,
      item.variationPrice,
      item.orderPrice,
      parseMoneyToCents(incomeItem?.discounted_price),
      parseMoneyToCents(incomeItem?.selling_price),
      parseMoneyToCents(incomeItem?.original_price),
    ];

    const unitPriceCents =
      rawPriceCentsCandidates.find((value) => Number(value) > 0) ??
      estimateItemUnitPriceCents(order, items, item);

    return {
      ...item,
      unitPriceCents,
      subtotalCents: unitPriceCents * quantity,
      incomeItem,
    };
  });
}

function moneyField(info, names = [], fallback = null) {
  for (const name of names) {
    const value = String(name || "")
      .split(".")
      .filter(Boolean)
      .reduce((acc, key) => (acc == null ? undefined : acc[key]), info);

    if (value != null) {
      return parseMoneyToCents(value);
    }
  }
  return fallback;
}

function getIncomeItems(order) {
  const info = getIncomeInfo(order);
  return Array.isArray(info?.items) ? info.items : [];
}

function sumIncomeItemsMoneyField(order, names = []) {
  const items = getIncomeItems(order);
  return items.reduce((sum, item) => sum + moneyField(item, names, 0), 0);
}

function moneyFieldWithItemFallback(order, names = [], itemNames = [], fallback = 0) {
  const info = getIncomeInfo(order);
  const topLevel = moneyField(info, names, null);
  if (topLevel != null && topLevel !== 0) return topLevel;

  const fromItems = sumIncomeItemsMoneyField(order, itemNames);
  if (fromItems !== 0) return fromItems;

  return fallback;
}

function pushMoneyLine(lines, label, cents, options = {}) {
  const { kind = "neutral", hideZero = true } = options;
  const amount = Number(cents);
  if (!Number.isFinite(amount)) return;
  if (hideZero && amount === 0) return;
  lines.push({ label, cents: amount, kind });
}

function appendSummarySection(summary, title, lines, options = {}) {
  if (!Array.isArray(lines) || !lines.length) return;
  const totalCentsOverride =
    options && Number.isFinite(Number(options.totalCentsOverride))
      ? Number(options.totalCentsOverride)
      : null;
  summary.push({
    title,
    totalCents:
      totalCentsOverride != null
        ? totalCentsOverride
        : lines.reduce((sum, line) => sum + Number(line.cents || 0), 0),
    lines,
  });
}

function formatAdjustmentDate(value) {
  if (!value) return null;

  const date =
    typeof value === "number"
      ? new Date(Number(value) * 1000)
      : new Date(value);

  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleString("pt-BR");
}

function buildBuyerPaymentSnapshot(buyerPaymentInfo) {
  if (!buyerPaymentInfo || !Object.keys(buyerPaymentInfo).length) return [];

  const lines = [];
  pushMoneyLine(
    lines,
    "Total pago pelo comprador",
    moneyField(buyerPaymentInfo, ["buyer_total_amount"], 0),
    { kind: "positive", hideZero: false },
  );
  pushMoneyLine(
    lines,
    "Subtotal do checkout",
    moneyField(buyerPaymentInfo, ["merchant_subtotal"], 0),
    { kind: "positive" },
  );
  pushMoneyLine(
    lines,
    "Frete pago no checkout",
    moneyField(buyerPaymentInfo, ["shipping_fee"], 0),
    { kind: "positive" },
  );
  pushMoneyLine(
    lines,
    "Embalagem cobrada do comprador",
    moneyField(buyerPaymentInfo, ["buyer_paid_packaging_fee"], 0),
    { kind: "positive" },
  );
  pushMoneyLine(
    lines,
    "Bulky handling fee",
    moneyField(buyerPaymentInfo, ["bulky_handling_fee"], 0),
    { kind: "positive" },
  );
  pushMoneyLine(
    lines,
    "Seguro pago pelo comprador",
    moneyField(buyerPaymentInfo, ["insurance_premium"], 0),
    { kind: "positive" },
  );
  pushMoneyLine(
    lines,
    "Taxa de servico do comprador",
    moneyField(buyerPaymentInfo, ["buyer_service_fee"], 0),
    { kind: "positive" },
  );
  pushMoneyLine(
    lines,
    "Tributos no checkout",
    moneyField(
      buyerPaymentInfo,
      [
        "buyer_tax_amount",
        "import_tax_amount",
        "iof_tax_amount",
        "icms_tax_amount",
      ],
      0,
    ),
    { kind: "positive" },
  );
  pushMoneyLine(
    lines,
    "Cupom do vendedor no checkout",
    -Math.abs(moneyField(buyerPaymentInfo, ["seller_voucher"], 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    lines,
    "Cupom Shopee no checkout",
    -Math.abs(moneyField(buyerPaymentInfo, ["shopee_voucher"], 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    lines,
    "Moedas Shopee resgatadas",
    -Math.abs(moneyField(buyerPaymentInfo, ["shopee_coins_redeemed"], 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    lines,
    "Promocao no cartao",
    -Math.abs(moneyField(buyerPaymentInfo, ["credit_card_promotion"], 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    lines,
    "Desconto PIX no checkout",
    -Math.abs(moneyField(buyerPaymentInfo, ["discount_pix"], 0)),
    { kind: "negative" },
  );

  return lines;
}

function buildPaymentSummary(order) {
  const info = getIncomeInfo(order);
  const buyerPaymentInfo = getBuyerPaymentInfo(order);
  const orderAdjustments = getOrderAdjustments(order);
  const summary = [];
  const legacySellerDiscountFallbackCents =
    Number(order?.finVoucherSellerCents || 0) !==
    Number(order?.voucherFromSellerCents || 0)
      ? order?.finVoucherSellerCents ?? 0
      : 0;

  const productLines = [];
  pushMoneyLine(
    productLines,
    "Subtotal dos Produtos",
    moneyField(info, ["original_cost_of_goods_sold", "cost_of_goods_sold"], order.itemsSubtotalCents ?? 0),
    { kind: "positive", hideZero: false },
  );
  pushMoneyLine(
    productLines,
    "Preco do Produto",
    moneyField(
      info,
      [
        "order_discounted_price",
        "cost_of_goods_sold",
        "order_selling_price",
        "order_original_price",
      ],
      order.itemsSubtotalCents ?? order.gmvCents ?? 0,
    ),
    { kind: "positive", hideZero: false },
  );
  appendSummarySection(summary, "Produtos", productLines);

  const shippingLines = [];
  pushMoneyLine(
    shippingLines,
    "Taxa de frete paga pelo comprador",
    moneyField(info, ["buyer_paid_shipping_fee"], order.shippingCents ?? 0),
    { kind: "positive", hideZero: false },
  );
  pushMoneyLine(
    shippingLines,
    "Frete real cobrado pelo parceiro logistico",
    -Math.abs(
      moneyField(info, ["actual_shipping_fee", "final_shipping_fee"], order.actualShippingFeeCents ?? 0),
    ),
    { kind: "negative", hideZero: false },
  );
  pushMoneyLine(
    shippingLines,
    "Rebate de frete da Shopee",
    moneyField(info, ["shopee_shipping_rebate"], 0),
    { kind: "positive" },
  );
  pushMoneyLine(
    shippingLines,
    "Desconto de frete da 3PL",
    moneyField(info, ["shipping_fee_discount_from_3pl"], 0),
    { kind: "positive" },
  );
  pushMoneyLine(
    shippingLines,
    "Desconto de frete do vendedor",
    -Math.abs(moneyField(info, ["seller_shipping_discount"], 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    shippingLines,
    "Frete reverso",
    -Math.abs(moneyField(info, ["reverse_shipping_fee"], 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    shippingLines,
    "Taxa de retorno ao vendedor",
    -Math.abs(moneyField(info, ["final_return_to_seller_shipping_fee"], 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    shippingLines,
    "Protecao de frete do vendedor",
    -Math.abs(moneyField(info, ["shipping_seller_protection_fee_amount"], 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    shippingLines,
    "Premio de protecao de entrega",
    -Math.abs(
      moneyField(info, ["delivery_seller_protection_fee_premium_amount"], 0),
    ),
    { kind: "negative" },
  );
  pushMoneyLine(
    shippingLines,
    "Reembolso de protecao RSF",
    moneyField(info, ["rsf_seller_protection_fee_claim_amount"], 0),
    { kind: "positive" },
  );
  pushMoneyLine(
    shippingLines,
    "Reembolso de protecao FSF",
    moneyField(info, ["fsf_seller_protection_fee_claim_amount"], 0),
    { kind: "positive" },
  );
  appendSummarySection(summary, "Frete", shippingLines);

  const couponLines = [];
  const sellerVoucherCodes = Array.isArray(info?.seller_voucher_code)
    ? info.seller_voucher_code.filter(Boolean)
    : [];
  pushMoneyLine(
    couponLines,
    `Cupom da loja pago pelo vendedor${sellerVoucherCodes.length ? ` - ${sellerVoucherCodes.join(", ")}` : ""}`,
    Math.abs(
      moneyFieldWithItemFallback(
        order,
        ["voucher_from_seller"],
        ["discount_from_voucher_seller"],
        order.voucherFromSellerCents ?? 0,
      ),
    ),
    { kind: "neutral" },
  );
  pushMoneyLine(
    couponLines,
    "Desconto do vendedor",
    Math.abs(
      moneyFieldWithItemFallback(
        order,
        ["seller_discount", "order_seller_discount"],
        ["seller_discount"],
        legacySellerDiscountFallbackCents,
      ),
    ),
    { kind: "neutral" },
  );
  pushMoneyLine(
    couponLines,
    "Cashback em moedas do vendedor",
    Math.abs(moneyField(info, ["seller_coin_cash_back"], 0)),
    { kind: "neutral" },
  );
  pushMoneyLine(
    couponLines,
    "Trade-in pago pelo vendedor",
    Math.abs(moneyField(info, ["trade_in_bonus_by_seller"], 0)),
    { kind: "neutral" },
  );
  pushMoneyLine(
    couponLines,
    "Rebate de produto pago pelo vendedor",
    Math.abs(moneyField(info, ["seller_product_rebate.amount"], 0)),
    { kind: "neutral" },
  );
  pushMoneyLine(
    couponLines,
    "Desconto PIX",
    Math.abs(
      moneyFieldWithItemFallback(order, ["pix_discount", "discount_pix"], [], 0),
    ),
    { kind: "neutral" },
  );
  pushMoneyLine(
    couponLines,
    "Cupom da Shopee",
    Math.abs(
      moneyFieldWithItemFallback(
        order,
        ["voucher_from_shopee"],
        ["discount_from_voucher_shopee"],
        order.voucherFromShopeeCents ?? 0,
      ),
    ),
    { kind: "neutral" },
  );
  pushMoneyLine(
    couponLines,
    "Moedas Shopee",
    Math.abs(
      moneyFieldWithItemFallback(order, ["coins"], ["discount_from_coin"], 0),
    ),
    { kind: "neutral" },
  );
  pushMoneyLine(
    couponLines,
    "Promocao de pagamento",
    Math.abs(moneyField(info, ["payment_promotion", "credit_card_promotion"], 0)),
    { kind: "neutral" },
  );
  pushMoneyLine(
    couponLines,
    "Desconto Shopee",
    Math.abs(moneyField(info, ["shopee_discount", "original_shopee_discount"], 0)),
    { kind: "neutral" },
  );
  appendSummarySection(
    summary,
    "Descontos e cupons ja refletidos no preco final",
    couponLines,
    { totalCentsOverride: 0 },
  );

  const feeLines = [];
  pushMoneyLine(
    feeLines,
    "Taxa de comissao",
    -Math.abs(moneyField(info, ["net_commission_fee", "commission_fee"], order.finCommissionCents ?? 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    feeLines,
    "Taxa de servico",
    -Math.abs(moneyField(info, ["net_service_fee", "service_fee"], order.finServiceFeeCents ?? 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    feeLines,
    "Taxa de transacao do vendedor",
    -Math.abs(moneyField(info, ["seller_transaction_fee"], order.finTransactionFeeCents ?? 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    feeLines,
    "Taxa de processamento do pedido",
    -Math.abs(moneyField(info, ["seller_order_processing_fee"], 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    feeLines,
    "Taxa de campanha",
    -Math.abs(moneyField(info, ["campaign_fee"], 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    feeLines,
    "Comissao de afiliados",
    -Math.abs(moneyField(info, ["order_ams_commission_fee"], 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    feeLines,
    "Ads / suporte tecnico",
    -Math.abs(moneyField(info, ["ads_escrow_top_up_fee_or_technical_support_fee"], 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    feeLines,
    "FBS fee",
    -Math.abs(moneyField(info, ["fbs_fee"], 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    feeLines,
    "Taxa de devolucao internacional",
    -Math.abs(moneyField(info, ["overseas_return_service_fee"], 0)),
    { kind: "negative" },
  );
  appendSummarySection(summary, "Taxas e encargos", feeLines);

  const cancellationLines = [];
  pushMoneyLine(
    cancellationLines,
    "Devolucao ao comprador",
    -Math.abs(moneyField(info, ["seller_return_refund"], 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    cancellationLines,
    "Ajuste por disputa",
    -Math.abs(moneyField(info, ["drc_adjustable_refund"], 0)),
    { kind: "negative" },
  );
  pushMoneyLine(
    cancellationLines,
    "Compensacao por perda do vendedor",
    moneyField(info, ["seller_lost_compensation"], 0),
    { kind: "positive" },
  );
  appendSummarySection(summary, "Cancelamentos e devolucoes", cancellationLines);

  const taxLines = [];
  const taxFieldLabels = [
    ["withholding_tax", "Withholding Tax"],
    ["withholding_vat_tax", "Withholding VAT"],
    ["withholding_pit_tax", "Withholding PIT"],
    ["escrow_tax", "Escrow Tax"],
    ["sales_tax_on_lvg", "Sales Tax LVG"],
    ["final_product_vat_tax", "VAT Produto"],
    ["final_shipping_vat_tax", "VAT Frete"],
    ["final_escrow_product_gst", "GST Produto"],
    ["final_escrow_shipping_gst", "GST Frete"],
    ["vat_on_imported_goods", "VAT Importacao"],
  ];
  for (const [fieldName, label] of taxFieldLabels) {
    pushMoneyLine(
      taxLines,
      label,
      -Math.abs(moneyField(info, [fieldName], 0)),
      { kind: "negative" },
    );
  }
  appendSummarySection(summary, "Impostos", taxLines);

  const accountingAdjustments = orderAdjustments.map((adjustment) => {
    const amountCents = parseMoneyToCents(adjustment?.amount);
    const labelParts = [
      adjustment?.adjustment_reason || "Ajuste contabilizado",
      formatAdjustmentDate(adjustment?.date),
    ].filter(Boolean);

    return {
      label: labelParts.join(" - "),
      cents: amountCents,
      kind:
        amountCents < 0
          ? "negative"
          : amountCents > 0
            ? "positive"
            : "neutral",
    };
  });
  appendSummarySection(summary, "Ajustes contabilizados", accountingAdjustments);

  const buyerPaymentSnapshot = buildBuyerPaymentSnapshot(buyerPaymentInfo);

  const estimatedIncomeCents =
    moneyField(info, ["escrow_amount", "escrow_amount_after_adjustment"], null) ??
    order.incomeNetCents ??
    order.escrowAmountCents ??
    0;

  return {
    paymentMethod:
      order.paymentMethod ||
      buyerPaymentInfo?.buyer_payment_method ||
      info?.buyer_payment_method ||
      null,
    buyerUserName: getBuyerUserName(order),
    returnOrderSnList: getReturnOrderSnList(order),
    buyerPaymentSnapshot,
    estimatedIncomeCents,
    sections: summary,
  };
}

async function hydrateOrderEscrowDetail(order, shop) {
  const hasBuyerSnapshot = Boolean(
    getBuyerPaymentInfo(order) && Object.keys(getBuyerPaymentInfo(order)).length,
  );
  const alreadyRich =
    hasRichEscrowPayload(order) &&
    (hasBuyerSnapshot ||
      getReturnOrderSnList(order).length > 0 ||
      Boolean(getBuyerUserName(order)));

  if (alreadyRich || !order?.orderSn || !shop?.shopId) {
    return order;
  }

  try {
    const escrow = await requestShopeeAuthed({
      method: "get",
      path: "/api/v2/payment/get_escrow_detail",
      shopId: String(shop.shopId),
      query: { order_sn: String(order.orderSn) },
    });

    if (escrow?.error || !escrow?.response) {
      return order;
    }

    const payload = escrow.response;
    const incomeInfo =
      payload?.order_income &&
      typeof payload.order_income === "object" &&
      !Array.isArray(payload.order_income)
        ? payload.order_income
        : {};
    const nextIncomeNetCents = parseMoneyToCents(incomeInfo?.escrow_amount);
    const nextPaymentMethod =
      payload?.buyer_payment_info?.buyer_payment_method ||
      incomeInfo?.buyer_payment_method ||
      order.paymentMethod ||
      null;

    const incomeSyncedAt = new Date();

    await updateOrderEscrowDetail(order.id, {
      incomeSyncedAt,
      incomeStatus: incomeInfo?.status || order.incomeStatus || "UNKNOWN",
      incomeNetCents: nextIncomeNetCents,
      incomeDetailRaw: payload,
      paymentMethod: nextPaymentMethod,
    });

    return {
      ...order,
      incomeSyncedAt,
      incomeStatus: incomeInfo?.status || order.incomeStatus || "UNKNOWN",
      incomeNetCents: nextIncomeNetCents,
      incomeDetailRaw: payload,
      paymentMethod: nextPaymentMethod,
    };
  } catch (error) {
    console.error("[orders.detail] escrow refresh failed", {
      orderSn: order?.orderSn,
      error: String(error?.message || error),
    });
  }

  return order;
}

function serializeOrderListItem(order) {
  const previewItems = Array.isArray(order?.items)
    ? order.items.map((item) => ({
        itemName: item.itemName || null,
        modelName: item.modelName || null,
        modelSku: item.modelSku || null,
        quantity: item.quantity ?? 0,
        dealPrice: item.dealPrice ?? null,
        imageUrl: item.imageUrl || null,
      }))
    : [];

  return {
    ...order,
    itemsPreview: previewItems,
    itemsCount: Number(order?._count?.items || previewItems.length || 0),
  };
}

async function list(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const limit = Math.min(Number(req.query.limit || 60), 200);

  const page = Math.max(Number(req.query.page || 1), 1);
  const pageSize = Math.min(Math.max(Number(req.query.pageSize || 60), 1), 200);

  // ✅ Paginado só quando veio page ou pageSize (senão mantém modo legado por limit)
  const usePagination = Boolean(req.query.page || req.query.pageSize);

  let statuses = null;
  const search = String(req.query.q || req.query.search || "").trim();
  const statusFilterRaw = String(req.query.status || "").trim();
  const showAllStatuses = statusFilterRaw.toUpperCase() === "ALL";

  // ✅ Se veio status, filtra exatamente aquilo
  if (statusFilterRaw && !showAllStatuses) {
    statuses = statusFilterRaw
      .split(",")
      .map(normalizeStatus)
      .filter(Boolean);

  }
    // ✅ comportamento atual (operacional): esconder finalizados/cancelados/devolução etc.
  const total = usePagination
    ? await countOrdersForShop({
        shopId: shop.id,
        statuses,
        search,
        excludeHiddenStatuses: !statuses && !showAllStatuses,
      })
    : null;

  const items = await listOrdersForShop({
    shopId: shop.id,
    statuses,
    search,
    excludeHiddenStatuses: !statuses && !showAllStatuses,
    limit: usePagination ? pageSize : limit,
    offset: usePagination ? (page - 1) * pageSize : 0,
  });

  if (!items.length) {
    res.json(
      usePagination
        ? {
            items: [],
            pagination: {
              page,
              pageSize,
              total: total || 0,
              totalPages: total ? Math.ceil(total / pageSize) : 0,
            },
          }
        : { items: [] },
    );
    return;
  }

  const orderIds = items
    .filter((order) => shouldShowAddressAlert(order.orderStatus))
    .map((order) => order.id);

  const grouped = orderIds.length
    ? await listPendingAddressAlertCountsByOrderIds(orderIds)
    : [];

  const countMap = new Map(grouped.map((g) => [g.orderId, g.total]));

  const enrichedItems = items.map((o) => {
    const c = shouldShowAddressAlert(o.orderStatus) ? countMap.get(o.id) || 0 : 0;
    return {
      ...serializeOrderListItem(o),
      hasAddressAlert: c > 0,
      addressAlertCount: c,
    };
  });

  res.json(
    usePagination
      ? {
          items: enrichedItems,
          pagination: {
            page,
            pageSize,
            total,
            totalPages: Math.ceil((total || 0) / pageSize),
          },
        }
      : { items: enrichedItems },
  );
}

async function detail(req, res) {
  const { orderSn } = req.params;

  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const order = await findOrderDetailByShopAndOrderSn(shop.id, String(orderSn));

  if (!order) return res.status(404).json({ error: "order_not_found" });

  const hydratedOrder = await hydrateOrderEscrowDetail(order, shop);
  const paymentSummary = buildPaymentSummary(hydratedOrder);
  const displayItems = buildDisplayOrderItems(hydratedOrder);

  res.json({
    order: hydratedOrder,
    displayItems,
    paymentSummary,
    lastAddressSnapshot: hydratedOrder.addressSnapshots[0] || null,
  });
}

async function portalRef(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const orderSn = String(req.params.orderSn || "").trim();
  if (!orderSn) {
    return res.status(400).json({ error: "order_sn_required" });
  }

  try {
    const localOrder = await findOrderDetailByShopAndOrderSn(shop.id, orderSn);
    const localOrderId = String(localOrder?.orderId || "").trim();
    if (/^\d{10,20}$/.test(localOrderId)) {
      return res.json({
        orderSn,
        orderId: localOrderId,
        portalOrderRef: localOrderId,
        source: "database",
      });
    }

    const payload = await requestShopeeAuthed({
      method: "get",
      path: "/api/v2/order/get_order_detail",
      shopId: String(shop.shopId),
      query: {
        order_sn_list: orderSn,
        response_optional_fields: "order_id,order_sn",
      },
    });

    const first = payload?.response?.order_list?.[0] || null;
    const orderIdRaw = String(first?.order_id || "").trim();
    const portalOrderRef = /^\d{10,20}$/.test(orderIdRaw)
      ? orderIdRaw
      : String(first?.order_sn || orderSn).trim();

    return res.json({
      orderSn: String(first?.order_sn || orderSn).trim(),
      orderId: /^\d{10,20}$/.test(orderIdRaw) ? orderIdRaw : null,
      portalOrderRef,
    });
  } catch (error) {
    console.error("[orders.portalRef] failed", {
      orderSn,
      error: String(error?.message || error),
    });
    return res.status(502).json({
      error: "order_portal_ref_lookup_failed",
      message: String(error?.message || error),
    });
  }
}

module.exports = { list, detail, portalRef };
