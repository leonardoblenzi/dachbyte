const asyncHandler = require("../utils/asyncHandler");
const {
  buildMonthlyAdsCostIndex,
  getAllocatedAdsCostForItems,
} = require("../utils/monthlyAdsCost");
const {
  getIncomeInfo,
  getBuyerPaymentInfo,
  getOrderAdjustments,
  hasRichEscrowPayload,
} = require("../utils/orderEscrow");
const { resolveShop } = require("../utils/resolveShop");
const {
  syncOrderIncome,
} = require("../services/OrderSyncService");
const {
  findShopTaxRateById,
  listMarginOrdersWithItems,
  listProductsByShopAndItemIds,
  sumAdsSpendByShopAndRange,
  sumStorePaidRevenueCents,
} = require("../repositories/analyticsSqlRepository");

const { assessFinancialReview } = require("../services/PricingV7FinancialReview");
const { collectRoasMetricsForRange } = require("../services/AdsRoasMetricsService");
const MARGIN_EXCLUDED_STATUSES = ["CANCELLED", "UNPAID", "IN_CANCEL"];
const RETURNED_ORDER_STATUSES = new Set(["RETURNED", "TO_RETURN"]);
const SAO_PAULO_UTC_OFFSET = "-03:00";

function isValidIsoDate(value) {
  const normalized = String(value || "").trim();
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(normalized);
  if (!match) return false;

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === normalized;
}

function parseMarginDateRange(dateFromValue, dateToValue) {
  const dateFrom = String(dateFromValue || "").trim();
  const dateTo = String(dateToValue || "").trim();
  if (!isValidIsoDate(dateFrom) || !isValidIsoDate(dateTo) || dateFrom > dateTo) {
    throw new Error("Periodo invalido.");
  }

  return {
    dateFrom,
    dateTo,
    start: new Date(`${dateFrom}T00:00:00.000${SAO_PAULO_UTC_OFFSET}`),
    end: new Date(`${dateTo}T23:59:59.999${SAO_PAULO_UTC_OFFSET}`),
  };
}

function toAbsCents(value) {
  return Math.abs(Number(value || 0));
}

function toNumberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toCurrencyValue(cents) {
  return toNumberOrZero(cents) / 100;
}

function parseMoneyToCents(value) {
  if (value == null) return 0;

  let numeric = value;
  if (typeof numeric === "string") {
    numeric = Number(numeric.replace(",", "."));
  }

  return Number.isFinite(numeric) ? Math.round(Number(numeric) * 100) : 0;
}

function getValueByPath(source, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), source);
}

function hasValueByPath(source, path) {
  return getValueByPath(source, path) != null;
}

function getMoneyByPathCents(source, path) {
  return parseMoneyToCents(getValueByPath(source, path));
}

function pickMoneyCents(source, paths = []) {
  for (const path of paths) {
    if (hasValueByPath(source, path)) {
      return getMoneyByPathCents(source, path);
    }
  }

  return 0;
}

function pickMoneyCentsOrNull(source, paths = []) {
  for (const path of paths) {
    if (hasValueByPath(source, path)) {
      return getMoneyByPathCents(source, path);
    }
  }

  return null;
}

function sumMoneyCents(source, paths = []) {
  return paths.reduce(
    (total, path) => total + getMoneyByPathCents(source, path),
    0,
  );
}

function sumItemsMoneyCents(source, paths = []) {
  const items = Array.isArray(source?.items) ? source.items : [];
  return items.reduce(
    (total, item) => total + sumMoneyCents(item, paths),
    0,
  );
}

function hasAnyValue(source, paths = []) {
  return paths.some((path) => hasValueByPath(source, path));
}

function hasIncomeBreakdown(order) {
  return Boolean(order?.incomeSyncedAt);
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

function hasDetailedFinancialData(order) {
  if (Object.keys(getIncomeInfo(order)).length) return true;

  return [
    "incomeNetCents",
    "escrowAmountCents",
    "finCommissionCents",
    "finServiceFeeCents",
    "finTransactionFeeCents",
    "finShippingFeeCents",
    "finVoucherSellerCents",
    "finDiscountVoucherSellerCents",
    "finVoucherShopeeCents",
    "finShopeeDiscountCents",
    "finDiscountFromCoinCents",
    "finDiscountVoucherShopeeCents",
  ].some((field) => toNumberOrZero(order?.[field]) !== 0);
}

function getOrderRevenueCents(order) {
  const info = getIncomeInfo(order);
  const buyerPaymentInfo = getBuyerPaymentInfo(order);
  const paidTotalCents =
    pickMoneyCentsOrNull(buyerPaymentInfo, ["buyer_total_amount"]) ??
    pickMoneyCentsOrNull(info, ["buyer_total_amount"]);

  if (paidTotalCents != null && paidTotalCents > 0) {
    return paidTotalCents;
  }

  if (toNumberOrZero(order?.totalAmountCents) > 0) {
    return toNumberOrZero(order.totalAmountCents);
  }

  return toNumberOrZero(order?.gmvCents);
}

function getCommissionCostCents(order) {
  const info = getIncomeInfo(order);
  if (Object.keys(info).length) {
    const netCommission = pickMoneyCentsOrNull(info, ["net_commission_fee"]);
    const netService = pickMoneyCentsOrNull(info, ["net_service_fee"]);
    const commission = Math.abs(
      netCommission ?? pickMoneyCents(info, ["commission_fee"]),
    );
    const service = Math.abs(
      netService ?? pickMoneyCents(info, ["service_fee"]),
    );
    const independentFees = [
      "order_ams_commission_fee",
      "ads_escrow_top_up_fee_or_technical_support_fee",
      "fbs_fee",
      "overseas_return_service_fee",
    ].reduce(
      (total, field) => total + Math.abs(getMoneyByPathCents(info, field)),
      0,
    );

    if (netService != null) {
      return commission + service + independentFees;
    }

    const serviceComponents = [
      "seller_transaction_fee",
      "seller_order_processing_fee",
      "campaign_fee",
    ].reduce(
      (total, field) => total + Math.abs(getMoneyByPathCents(info, field)),
      0,
    );
    return commission + service + serviceComponents + independentFees;
  }

  if (hasIncomeBreakdown(order)) {
    return (
      toAbsCents(order.finCommissionCents) +
      toAbsCents(order.finServiceFeeCents) +
      toAbsCents(order.finTransactionFeeCents)
    );
  }

  return (
    toAbsCents(order.commFeeCents) +
    toAbsCents(order.serviceFeeCents) +
    toAbsCents(order.transactionFeeCents)
  );
}

function getFinancialBreakdownCents(order) {
  const info = getIncomeInfo(order);
  const buyer = getBuyerPaymentInfo(order);
  const abs = (paths, fallback = 0) => {
    const value = pickMoneyCentsOrNull(info, paths);
    return Math.abs(value ?? fallback);
  };
  const itemAbs = (paths) => Math.abs(sumItemsMoneyCents(info, paths));
  const buyerAbs = (paths) => Math.abs(pickMoneyCents(buyer, paths));

  const commissionGross = abs(["commission_fee"]);
  const commissionNet = abs(
    ["net_commission_fee"],
    commissionGross || toAbsCents(order.finCommissionCents),
  );
  const serviceGross = abs(["service_fee"]);
  const serviceNet = abs(
    ["net_service_fee"],
    serviceGross || toAbsCents(order.finServiceFeeCents),
  );
  const transactionFee = abs(
    ["seller_transaction_fee", "transaction_fee", "credit_card_transaction_fee"],
    toAbsCents(order.finTransactionFeeCents),
  );
  const additionalServiceFee = abs(["seller_order_processing_fee"]);
  const soldItemFee = abs(["campaign_fee"]);
  const serviceComponents =
    transactionFee + additionalServiceFee + soldItemFee;

  const sellerVoucher = Math.max(
    abs(["voucher_from_seller"], toAbsCents(order.finVoucherSellerCents)),
    itemAbs(["discount_from_voucher_seller"]),
    abs(["prorated_seller_voucher_offset_return_items"]),
  );
  const shopeeVoucher = Math.max(
    abs(["voucher_from_shopee"], toAbsCents(order.finVoucherShopeeCents)),
    itemAbs(["discount_from_voucher_shopee"]),
    abs(["prorated_shopee_voucher_offset_return_items"]),
  );

  return {
    products: {
      originalPrice: abs(["order_original_price", "original_cost_of_goods_sold"]),
      discountedSubtotal: abs([
        "cost_of_goods_sold",
        "order_discounted_price",
        "order_selling_price",
      ], toNumberOrZero(order.itemsSubtotalCents)),
      buyerTotal: buyerAbs(["buyer_total_amount"]) || abs(["buyer_total_amount"]),
      checkoutSubtotal: buyerAbs(["merchant_subtotal"]),
    },
    discounts: {
      pix: Math.max(
        abs(["pix_discount", "discount_pix"]),
        buyerAbs(["discount_pix"]),
        abs(["prorated_pix_discount_offset_return_items"]),
      ),
      sellerVoucher,
      sellerDiscount: Math.max(
        abs(["seller_discount", "order_seller_discount"]),
        itemAbs(["seller_discount"]),
      ),
      shopeeVoucher,
      shopeeDiscount: Math.max(
        abs(["shopee_discount", "original_shopee_discount"]),
        toAbsCents(order.finShopeeDiscountCents),
      ),
      coins: Math.max(
        abs(["coins"]),
        itemAbs(["discount_from_coin"]),
        toAbsCents(order.finDiscountFromCoinCents),
      ),
      paymentPromotion: abs(["payment_promotion", "credit_card_promotion"]),
      sellerCoinCashback: abs(["seller_coin_cash_back"]),
      tradeInSeller: abs(["trade_in_bonus_by_seller"]),
      sellerProductRebate: abs(["seller_product_rebate.amount"]),
    },
    shipping: {
      estimated: abs(["estimated_shipping_fee"], toNumberOrZero(order.estimatedShippingFeeCents)),
      buyerPaid: abs(["buyer_paid_shipping_fee"]) || buyerAbs(["shipping_fee"]),
      actual: abs(
        ["actual_shipping_fee", "final_shipping_fee"],
        toNumberOrZero(order.actualShippingFeeCents),
      ),
      discount3pl: abs(["shipping_fee_discount_from_3pl"]),
      sellerDiscount: abs(["seller_shipping_discount"]),
      shopeeRebate: abs(["shopee_shipping_rebate"]),
      reverse: abs(["reverse_shipping_fee"]),
      returnToSeller: abs(["final_return_to_seller_shipping_fee"]),
      sellerProtection: abs(["shipping_seller_protection_fee_amount"]),
      deliveryProtection: abs(["delivery_seller_protection_fee_premium_amount"]),
      protectionClaimRsf: abs(["rsf_seller_protection_fee_claim_amount"]),
      protectionClaimFsf: abs(["fsf_seller_protection_fee_claim_amount"]),
    },
    fees: {
      commissionGross,
      commissionNet,
      commissionCommercialAdjustment: Math.max(0, commissionGross - commissionNet),
      serviceGross,
      serviceNet,
      additionalService: additionalServiceFee,
      transaction: transactionFee,
      soldItem: soldItemFee,
      serviceCommercialAdjustment: Math.max(0, serviceComponents - serviceNet),
      affiliateCommission: abs(["order_ams_commission_fee"]),
      adsTechnicalSupport: abs([
        "ads_escrow_top_up_fee_or_technical_support_fee",
      ]),
      fbs: abs(["fbs_fee"]),
      overseasReturnService: abs(["overseas_return_service_fee"]),
    },
    taxes: {
      withholding: abs(["withholding_tax"]),
      withholdingVat: abs(["withholding_vat_tax"]),
      withholdingPit: abs(["withholding_pit_tax"]),
      escrow: abs(["escrow_tax"]),
      salesLvg: abs(["sales_tax_on_lvg"]),
      productVat: abs(["final_product_vat_tax"]),
      shippingVat: abs(["final_shipping_vat_tax"]),
      productGst: abs(["final_escrow_product_gst"]),
      shippingGst: abs(["final_escrow_shipping_gst"]),
      importedGoodsVat: abs(["vat_on_imported_goods"]),
      importDuty: abs(["th_import_duty"]),
    },
    returns: {
      sellerRefund: abs(["seller_return_refund"]),
      disputeAdjustment: abs(["drc_adjustable_refund"]),
      sellerLostCompensation: abs(["seller_lost_compensation"]),
    },
    accountingAdjustments: getOrderAdjustments(order).map((adjustment) => ({
      reason: String(adjustment?.adjustment_reason || "Ajuste contabilizado"),
      date: adjustment?.date == null ? null : String(adjustment.date),
      amountCents: parseMoneyToCents(adjustment?.amount),
    })),
  };
}

function financialBreakdownToCurrency(value) {
  if (Array.isArray(value)) return value.map(financialBreakdownToCurrency);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        financialBreakdownToCurrency(child),
      ]),
    );
  }
  return typeof value === "number" ? toCurrencyValue(value) : value;
}

function listRawFinancialFields(order) {
  const rows = [];
  const financialPattern =
    /(amount|fee|tax|discount|voucher|commission|refund|rebate|coin|shipping|goods_sold|price|income|escrow)/i;

  function visit(value, path, depth) {
    if (rows.length >= 250 || depth > 4 || value == null) return;
    if (Array.isArray(value)) return;
    if (typeof value === "object") {
      Object.entries(value).forEach(([key, child]) => {
        visit(child, path ? `${path}.${key}` : key, depth + 1);
      });
      return;
    }

    const fieldName = path.split(".").at(-1) || "";
    if (!financialPattern.test(fieldName)) return;
    const numeric = typeof value === "string"
      ? Number(value.replace(",", "."))
      : Number(value);
    if (!Number.isFinite(numeric)) return;
    rows.push({ field: path, valueCents: Math.round(numeric * 100) });
  }

  visit(getIncomeInfo(order), "order_income", 0);
  visit(getBuyerPaymentInfo(order), "buyer_payment_info", 0);
  return rows;
}

function getVoucherCostCents(order) {
  const info = getIncomeInfo(order);
  if (Object.keys(info).length) {
    const orderLevelSellerVoucherCents = pickMoneyCents(info, [
      "voucher_from_seller",
    ]);
    const itemLevelSellerVoucherCents = sumItemsMoneyCents(info, [
      "discount_from_voucher_seller",
    ]);
    const proratedSellerVoucherRefundCents = pickMoneyCents(info, [
      "prorated_seller_voucher_offset_return_items",
    ]);

    return Math.max(
      orderLevelSellerVoucherCents,
      itemLevelSellerVoucherCents,
      proratedSellerVoucherRefundCents,
    );
  }

  if (hasIncomeBreakdown(order)) {
    return Math.max(
      toAbsCents(order.finVoucherSellerCents),
      toAbsCents(order.finDiscountVoucherSellerCents),
      toAbsCents(order.voucherFromSellerCents),
    );
  }

  return toAbsCents(order.voucherFromSellerCents);
}

function getShopeeRebatesCents(order) {
  const info = getIncomeInfo(order);
  if (Object.keys(info).length) {
    const shopeeVoucherCents = Math.max(
      pickMoneyCents(info, ["voucher_from_shopee"]),
      sumItemsMoneyCents(info, ["discount_from_voucher_shopee"]),
      pickMoneyCents(info, ["prorated_shopee_voucher_offset_return_items"]),
    );

    const shopeeDiscountCents = Math.max(
      pickMoneyCents(info, ["shopee_discount"]),
      pickMoneyCents(info, ["original_shopee_discount"]),
    );

    const shopeePixCents = Math.max(
      pickMoneyCents(info, ["pix_discount", "discount_pix"]),
      pickMoneyCents(info, ["prorated_pix_discount_offset_return_items"]),
    );

    const shopeeCoinsCents = Math.max(
      pickMoneyCents(info, ["coins"]),
      sumItemsMoneyCents(info, ["discount_from_coin"]),
      pickMoneyCents(info, ["prorated_coins_value_offset_return_items"]),
    );

    const shopeeShippingRebateCents = pickMoneyCents(info, [
      "shopee_shipping_rebate",
    ]);

    return (
      shopeeVoucherCents +
      shopeeDiscountCents +
      shopeePixCents +
      shopeeCoinsCents +
      shopeeShippingRebateCents
    );
  }

  if (hasIncomeBreakdown(order)) {
    return (
      toAbsCents(order.finVoucherShopeeCents) +
      toAbsCents(order.finDiscountVoucherShopeeCents) +
      toAbsCents(order.finShopeeDiscountCents) +
      toAbsCents(order.finDiscountFromCoinCents)
    );
  }

  return toAbsCents(order.voucherFromShopeeCents);
}

function getShippingCostDetailsCents(order) {
  const info = getIncomeInfo(order);
  const buyerPaymentInfo = getBuyerPaymentInfo(order);
  const buyerPaidShippingCents = Math.max(
    0,
    pickMoneyCentsOrNull(info, ["buyer_paid_shipping_fee"]) ??
      pickMoneyCentsOrNull(buyerPaymentInfo, ["shipping_fee"]) ??
      toNumberOrZero(order.shippingCents) ??
      0,
  );
  const actualShippingCents = Math.max(0, pickMoneyCentsOrNull(info, ["actual_shipping_fee"]) ?? toNumberOrZero(order.actualShippingFeeCents));
  const finalShippingCents = Math.max(0, pickMoneyCentsOrNull(info, ["final_shipping_fee"]));
  const estimatedShippingCents = Math.max(0, pickMoneyCentsOrNull(info, ["estimated_shipping_fee"]) ?? toNumberOrZero(order.estimatedShippingFeeCents));
  const thirdPartyShippingDiscountCents = pickMoneyCents(info, ["shipping_fee_discount_from_3pl"]);
  const sellerShippingDiscountCents = pickMoneyCents(info, ["seller_shipping_discount"]);
  const shopeeShippingRebateCents = pickMoneyCents(info, ["shopee_shipping_rebate"]);
  const reverseShippingCents = sumMoneyCents(info, ["reverse_shipping_fee", "final_return_to_seller_shipping_fee"]);
  const shippingProtectionFeesCents = sumMoneyCents(info, ["shipping_seller_protection_fee_amount", "delivery_seller_protection_fee_premium_amount"]);
  const shippingProtectionClaimsCents = sumMoneyCents(info, ["rsf_seller_protection_fee_claim_amount", "fsf_seller_protection_fee_claim_amount"]);

  let sellerShippingBaseCents = 0;
  let source = "unavailable";
  if (actualShippingCents > 0) {
    sellerShippingBaseCents = actualShippingCents;
    source = "actual";
  } else if (finalShippingCents > buyerPaidShippingCents) {
    sellerShippingBaseCents = finalShippingCents;
    source = "final";
  } else if (estimatedShippingCents > 0) {
    sellerShippingBaseCents = estimatedShippingCents;
    source = "estimated";
  } else if (finalShippingCents > 0) {
    sellerShippingBaseCents = finalShippingCents;
    source = "final";
  }

  const netMainShippingCents = Math.max(
    0,
    sellerShippingBaseCents - buyerPaidShippingCents - thirdPartyShippingDiscountCents,
  ) + Math.max(0, sellerShippingDiscountCents);
  const netReverseShippingCents = Math.max(
    0,
    reverseShippingCents + shippingProtectionFeesCents - shippingProtectionClaimsCents,
  );
  // The Shopee freight rebate is a credit in the escrow settlement. It offsets
  // the carrier charge economically, while reconciliation keeps the gross charge.
  const netMainShippingAfterRebateCents = Math.max(
    0,
    netMainShippingCents - shopeeShippingRebateCents,
  );
  const totalCents = netMainShippingAfterRebateCents + netReverseShippingCents;
  const reconciliationCents = netMainShippingCents + netReverseShippingCents;
  const isProvisional = source === "estimated";

  return {
    totalCents,
    reconciliationCents: isProvisional ? netReverseShippingCents : reconciliationCents,
    source,
    isProvisional,
    buyerPaidShippingCents,
    actualShippingCents,
    estimatedShippingCents,
    finalShippingCents,
    shopeeShippingRebateCents,
  };
}

function getShippingCostCents(order) {
  return getShippingCostDetailsCents(order).totalCents;
}

function getReturnsCostDetailsCents(order) {
  const info = getIncomeInfo(order);
  if (Object.keys(info).length) {
    const refundedItemsCents = Math.max(
      0,
      getMoneyByPathCents(info, "original_cost_of_goods_sold") -
        getMoneyByPathCents(info, "cost_of_goods_sold"),
    );
    const sellerReturnRefundCents = toAbsCents(
      getMoneyByPathCents(info, "seller_return_refund"),
    );
    const productRefundCents = Math.max(
      refundedItemsCents,
      sellerReturnRefundCents,
    );
    const disputeAdjustmentCents = toAbsCents(
      getMoneyByPathCents(info, "drc_adjustable_refund"),
    );
    const sellerLostCompensationCents = toAbsCents(
      getMoneyByPathCents(info, "seller_lost_compensation"),
    );

    return {
      productRefundCents,
      disputeAdjustmentCents,
      sellerLostCompensationCents,
      totalCents: productRefundCents + disputeAdjustmentCents + sellerLostCompensationCents,
    };
  }

  const reverseShippingCents = RETURNED_ORDER_STATUSES.has(
    String(order?.orderStatus || "").toUpperCase(),
  ) ? toAbsCents(order.reverseShippingFee) : 0;
  return {
    productRefundCents: 0,
    disputeAdjustmentCents: 0,
    sellerLostCompensationCents: 0,
    totalCents: reverseShippingCents,
  };
}

function getReturnsCostCents(order) {
  return getReturnsCostDetailsCents(order).totalCents;
}

function getOrderTaxesCostCents(order) {
  const info = getIncomeInfo(order);
  if (Object.keys(info).length) {
    return [
      "escrow_tax", "sales_tax_on_lvg", "withholding_tax",
      "withholding_vat_tax", "withholding_pit_tax", "final_product_vat_tax",
      "final_shipping_vat_tax", "final_escrow_product_gst",
      "final_escrow_shipping_gst", "vat_on_imported_goods", "th_import_duty",
    ].reduce(
      (total, field) => total + Math.abs(getMoneyByPathCents(info, field)),
      0,
    );
  }
  return 0;
}

function getConfiguredTaxCents(taxRate, totalPaidCents) {
  if (taxRate <= 0 || totalPaidCents <= 0) return 0;
  return Math.round(totalPaidCents * (taxRate / 100));
}

function getNetReceivedCents(order) {
  const info = getIncomeInfo(order);
  const escrowCents = pickMoneyCentsOrNull(info, [
    "escrow_amount_after_adjustment", "escrow_amount",
  ]);
  if (escrowCents != null) return escrowCents;
  if (hasIncomeBreakdown(order) && order?.incomeNetCents != null) {
    return toNumberOrZero(order.incomeNetCents);
  }
  if (hasIncomeBreakdown(order) && order?.escrowAmountCents != null) {
    return toNumberOrZero(order.escrowAmountCents);
  }
  return null;
}

function resolveTaxRate(requestedTaxRate, storedTaxRate) {
  const raw = requestedTaxRate == null || requestedTaxRate === ""
    ? storedTaxRate
    : requestedTaxRate;
  const taxRate = Number(raw || 0);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
    throw new Error("A aliquota deve estar entre 0 e 100%.");
  }
  return taxRate;
}

function resolveMarginTaxBase(value) {
  const normalized = String(value || "products").trim().toLowerCase();
  if (normalized === "products" || normalized === "full_order") {
    return normalized;
  }
  throw new Error("A base do imposto deve ser produtos ou pedido completo.");
}

function getItemsRevenueCents(order) {
  const info = getIncomeInfo(order);
  const buyerPaymentInfo = getBuyerPaymentInfo(order);
  const totalRevenue = getOrderRevenueCents(order);
  const buyerPaidShippingCents =
    pickMoneyCentsOrNull(info, ["buyer_paid_shipping_fee"]) ??
    pickMoneyCentsOrNull(buyerPaymentInfo, ["shipping_fee"]);

  // buyer_total_amount already reflects checkout vouchers. When available,
  // remove only the buyer-paid freight to get the amount effectively paid for products.
  if (totalRevenue > 0 && buyerPaidShippingCents != null) {
    return Math.max(0, totalRevenue - Math.max(0, buyerPaidShippingCents));
  }

  const paidItemsCents =
    pickMoneyCentsOrNull(info, [
      "cost_of_goods_sold",
      "order_discounted_price",
      "order_selling_price",
      "order_original_price",
    ]) ??
    pickMoneyCentsOrNull(buyerPaymentInfo, ["merchant_subtotal"]);

  if (paidItemsCents != null && paidItemsCents > 0) {
    return paidItemsCents;
  }

  if (toNumberOrZero(order?.itemsSubtotalCents) > 0) {
    return toNumberOrZero(order.itemsSubtotalCents);
  }

  const paidShippingCents =
    pickMoneyCentsOrNull(info, ["buyer_paid_shipping_fee"]) ??
    pickMoneyCentsOrNull(buyerPaymentInfo, ["shipping_fee"]) ??
    (toNumberOrZero(order?.shippingCents) > 0
      ? toNumberOrZero(order.shippingCents)
      : null);

  if (paidShippingCents != null && paidShippingCents >= 0) {
    return Math.max(0, totalRevenue - paidShippingCents);
  }

  const shippingEstimate = toNumberOrZero(
    order?.shippingCents ?? order?.estimatedShippingFeeCents,
  );
  return Math.max(0, totalRevenue - shippingEstimate);
}

function getFreightSettlementCents({
  rawShippingCost,
  isOwnLogistics,
  fallbackShippingRevenueCents = 0,
}) {
  const buyerPaid = rawShippingCost.buyerPaidShippingCents ||
    Math.max(0, fallbackShippingRevenueCents);
  const rebate = rawShippingCost.shopeeShippingRebateCents;

  // Seller logistics receives freight in the escrow and repasses it outside Shopee.
  if (isOwnLogistics) return buyerPaid + rebate;

  const carrierCharge = rawShippingCost.actualShippingCents ||
    rawShippingCost.estimatedShippingCents || rawShippingCost.finalShippingCents;

  // Shopee-managed freight affects escrow only by its net settlement value.
  return buyerPaid - carrierCharge + rebate;
}

function isReturnedOrder(order) {
  return RETURNED_ORDER_STATUSES.has(String(order?.orderStatus || "").toUpperCase());
}

async function loadMarginOrders(shopId, start, end) {
  return listMarginOrdersWithItems(shopId, start, end, MARGIN_EXCLUDED_STATUSES);
}

function getCurrentMonthRange(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start, end: now };
}

function calculateAccountTacos(spendCents, gmvCents) {
  if (gmvCents <= 0) return null;
  return Number(((spendCents / gmvCents) * 100).toFixed(2));
}

function calculateMarginTacos(accountTacos, productRevenueCents) {
  const gmvCents = Math.max(0, toNumberOrZero(productRevenueCents));
  return {
    ...accountTacos,
    gmvCents,
    tacosPct: calculateAccountTacos(accountTacos?.spendCents || 0, gmvCents),
  };
}
async function getPeriodTacos({ shop, start, end, dateFrom, dateTo }) {
  const report = await collectRoasMetricsForRange({
    shop,
    shopDbId: shop.id,
    start,
    end,
    dateFrom,
    dateTo,
  });
  return {
    start,
    end,
    dateFrom,
    dateTo,
    spendCents: report.metrics.spendCents,
    gmvCents: report.metrics.storeGmvCents,
    tacosPct: report.metrics.tacosPct,
    source: report.sourceAdsTotals,
  };
}

async function getCurrentMonthTacos(shop, now = new Date()) {
  const { start, end } = getCurrentMonthRange(now);
  const dateFrom = start.toISOString().slice(0, 10);
  const dateTo = end.toISOString().slice(0, 10);
  return getPeriodTacos({ shop, start, end, dateFrom, dateTo });
}

function serializeAccountTacos(tacos) {
  return {
    periodStart: tacos.dateFrom || tacos.start.toISOString().slice(0, 10),
    periodEnd: tacos.dateTo || tacos.end.toISOString().slice(0, 10),
    spend: toCurrencyValue(tacos.spendCents),
    gmv: toCurrencyValue(tacos.gmvCents),
    percent: tacos.tacosPct == null ? null : Number(tacos.tacosPct.toFixed(2)),
    source: tacos.source || "database_fallback",
  };
}

async function hydrateMissingMarginFinancials({
  shopInternalId,
  shopeeShopId,
  orders,
}) {
  const missingOrderSns = orders
    .filter(
      (order) =>
        order?.orderSn &&
        (!hasDetailedFinancialData(order) || !hasRichEscrowPayload(order)),
    )
    .map((order) => String(order.orderSn));

  if (!missingOrderSns.length) {
    return { attempted: 0, hydrated: 0, failed: 0 };
  }

  let hydrated = 0;
  let failed = 0;

  for (const batch of chunk(missingOrderSns, 5)) {
    const results = await Promise.allSettled(
      batch.map((orderSn) =>
        syncOrderIncome(shopInternalId, String(shopeeShopId), orderSn),
      ),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value !== false) {
        hydrated += 1;
        continue;
      }

      failed += 1;
      console.error(
        "[margin] failed to hydrate escrow detail:",
        result.reason?.message || result.reason,
      );
    }
  }

  return {
    attempted: missingOrderSns.length,
    hydrated,
    failed,
  };
}

async function loadMarginContext({ shopInternalId, shopeeShopId, start, end }) {
  let orders = await loadMarginOrders(shopInternalId, start, end);
  const shop = await findShopTaxRateById(shopInternalId);

  const hydration = await hydrateMissingMarginFinancials({
    shopInternalId,
    shopeeShopId,
    orders,
  });

  if (hydration.hydrated > 0) {
    orders = await loadMarginOrders(shopInternalId, start, end);
  }

  const [monthlyAdsCost, productCostMap] = await Promise.all([
    buildMonthlyAdsCostIndex({ shopId: shopInternalId, start, end }),
    loadProductCostFallbackMap(shopInternalId, orders),
  ]);

  return {
    orders,
    shop,
    monthlyAdsCost,
    productCostMap,
    hydration,
  };
}

async function loadProductCostFallbackMap(shopId, orders) {
  const itemIdsToFetch = new Set();

  for (const order of orders) {
    for (const item of order.items) {
      if (!item.product && item.itemId) {
        itemIdsToFetch.add(item.itemId);
      }
    }
  }

  if (!itemIdsToFetch.size) return new Map();

  const products = await listProductsByShopAndItemIds(
    shopId,
    Array.from(itemIdsToFetch),
  );

  return new Map(
    products.map((product) => [
      String(product.itemId),
      {
        cost: product.costCents || 0,
        title: product.title || null,
      },
    ]),
  );
}

function getProductCostCents(order, productCostMap) {
  let total = 0;

  for (const item of order.items) {
    const qty = Number(item.quantity || 0);
    let cost = item.product?.costCents;

    if (cost == null && item.itemId) {
      cost = productCostMap.get(String(item.itemId))?.cost || 0;
    }

    total += toNumberOrZero(cost) * qty;
  }

  return total;
}


function mapOrderItems(order, productCostMap) {
  return (order.items || []).map((item) => {
    const fallback = item.itemId ? productCostMap.get(String(item.itemId)) : null;
    const configuredCostCents = toNumberOrZero(
      item.product?.costCents ?? fallback?.cost,
    );
    const hasConfiguredCost = configuredCostCents > 0;
    const unitCostCents = hasConfiguredCost ? configuredCostCents : 0;
    const quantity = toNumberOrZero(item.quantity);
    const unitPriceCents = item.dealPrice != null
      ? parseMoneyToCents(item.dealPrice)
      : item.variationPrice != null
        ? parseMoneyToCents(item.variationPrice)
        : quantity > 0
          ? Math.round(toNumberOrZero(item.orderPrice) / quantity)
          : toNumberOrZero(item.orderPrice);
    return {
      itemId: item.itemId == null ? null : String(item.itemId),
      modelId: item.modelId == null ? null : String(item.modelId),
      sku: item.modelSku || item.itemSku || null,
      name: item.itemName || item.product?.title || fallback?.title || null,
      variation: item.modelName || null,
      quantity,
      unitPriceCents,
      unitCostCents,
      totalCostCents: unitCostCents * quantity,
      hasConfiguredCost,
    };
  });
}

function normalizeCarrierName(value) {
  return String(value || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

function isShopeeXpressCarrier(value) {
  const carrier = normalizeCarrierName(value);

  return /\bSPX\b/.test(carrier) ||
    /\bSHOPEE\s+XPRESS\b/.test(carrier) ||
    /^EXPRESSO AEREO\b/.test(carrier);
}
function isExplicitSellerManagedCarrier(value) {
  return normalizeCarrierName(value).includes("LOGISTICA DO VENDEDOR");
}

function isShopeeManagedCarrier(value) {
  const carrier = normalizeCarrierName(value);
  return isShopeeXpressCarrier(carrier) || carrier.includes("ENTREGA DE ITEM GRANDE/PESADO");
}
function mapOrderMargin({ order, taxRate, taxBase = "products", monthlyAdsCost, productCostMap }) {
  const financialDetailsCents = getFinancialBreakdownCents(order);
  const rawFinancialFieldsCents = listRawFinancialFields(order);
  const revenueCents = getOrderRevenueCents(order);
  const itemsRevenueCents = getItemsRevenueCents(order);
  const productCostCents = getProductCostCents(order, productCostMap);
  const commissionsCents = getCommissionCostCents(order);
  const rawShippingCost = getShippingCostDetailsCents(order);
  const shippingRevenueCents = rawShippingCost.buyerPaidShippingCents ||
    Math.max(0, revenueCents - itemsRevenueCents);
  const isSellerLogistics = isExplicitSellerManagedCarrier(order.shippingCarrier);
  const isOwnLogistics = !isShopeeManagedCarrier(order.shippingCarrier);
  const shippingCost = isSellerLogistics
    ? { ...rawShippingCost, totalCents: 0, reconciliationCents: 0, source: "seller_logistics_reserve", isProvisional: true }
    : rawShippingCost;
  const shippingCostCents = shippingCost.totalCents;
  const voucherCostCents = getVoucherCostCents(order);
  const shopeeRebatesCents = getShopeeRebatesCents(order);
  const returnsCost = getReturnsCostDetailsCents(order);
  const returnsCents = returnsCost.totalCents;
  const orderTaxesCents = getOrderTaxesCostCents(order);
  const configuredTaxBaseCents = taxBase === "full_order"
    ? revenueCents
    : itemsRevenueCents;
  const configuredTaxCents = getConfiguredTaxCents(taxRate, configuredTaxBaseCents);
  const adsCostCents = getAllocatedAdsCostForItems(order.items, monthlyAdsCost.byItemId);

  const isSpx = isShopeeXpressCarrier(order.shippingCarrier);
  const settledSellerFreightCents = Math.max(0,
    rawShippingCost.buyerPaidShippingCents + rawShippingCost.shopeeShippingRebateCents,
  );
  const freightPassThroughCents = isSellerLogistics
    ? (settledSellerFreightCents || shippingRevenueCents)
    : isOwnLogistics
      ? shippingRevenueCents
      : 0;
  const ownLogisticsShippingCents = isOwnLogistics ? freightPassThroughCents : 0;
  const shippingDeductionCents = shippingCostCents + freightPassThroughCents;
  const spxReferenceCents = isSpx
    ? Math.max(0, toNumberOrZero(order.actualShippingFeeCents || order.estimatedShippingFeeCents || 0))
    : 0;
  const knownNetReceivedCents = revenueCents - commissionsCents -
    shippingCost.reconciliationCents - voucherCostCents - returnsCents - orderTaxesCents +
    shopeeRebatesCents;
  const shopeeNetReceivedCents = getNetReceivedCents(order);
  const netReceivedCents = shopeeNetReceivedCents ?? knownNetReceivedCents;
  // Freight rebates are settlement credits for logistics, not product revenue.
  // Keep them visible in the freight reconciliation but outside contribution margin.
  const freightRebateExcludedCents = rawShippingCost.shopeeShippingRebateCents;
  const freightSettlementCents = getFreightSettlementCents({
    rawShippingCost,
    isOwnLogistics,
    fallbackShippingRevenueCents: shippingRevenueCents,
  });
  const productNetReceivedCents = netReceivedCents - freightSettlementCents;
  const otherShopeeAdjustmentsCents = netReceivedCents - knownNetReceivedCents;
  const contributionMarginCents = productNetReceivedCents - productCostCents -
    configuredTaxCents - adsCostCents;
  const financialReview = assessFinancialReview({
    gmvCents: revenueCents,
    payoutCents: netReceivedCents,
    itemsRevenueCents,
    buyerShippingCents: financialDetailsCents.shipping.buyerPaid,
    actualShippingCents: financialDetailsCents.shipping.actual,
    payoutReconciliationDeltaCents: otherShopeeAdjustmentsCents,
  });
  const totalCostsCents = itemsRevenueCents - contributionMarginCents;
  const contributionMarginPercent = itemsRevenueCents > 0
    ? (contributionMarginCents / itemsRevenueCents) * 100
    : 0;

  return {
    id: order.id,
    orderSn: order.orderSn,
    orderStatus: order.orderStatus,
    shopeeCreateTime: order.shopeeCreateTime || order.createdAt,
    revenueCents,
    itemsRevenueCents,
    taxBase,
    configuredTaxBaseCents,
    shippingRevenueCents,
    freightRebateExcludedCents,
    freightSettlementCents,
    productNetReceivedCents,
    freightPassThroughCents,
    ownLogisticsShippingCents,
    netReceivedCents,
    netReceivedSource: shopeeNetReceivedCents == null ? "calculated" : "shopee",
    otherShopeeAdjustmentsCents,
    financialReview,
    shippingCost,
    returnsCost,
    reconciliationCents: {
      expectedPayout: knownNetReceivedCents,
      payout: netReceivedCents,
      adjustment: otherShopeeAdjustmentsCents,
      commissions: commissionsCents,
      shipping: shippingCost.reconciliationCents,
      sellerVoucher: voucherCostCents,
      returns: returnsCents,
      orderTaxes: orderTaxesCents,
      shopeeRebates: shopeeRebatesCents,
    },
    costsCents: {
      products: productCostCents,
      commissions: commissionsCents,
      shipping: shippingDeductionCents,
      channelShipping: shippingCostCents,
      shippingPassThrough: freightPassThroughCents,
      freightSettlement: freightSettlementCents,
      ownLogisticsShipping: ownLogisticsShippingCents,
      voucher: voucherCostCents,
      ads: adsCostCents,
      orderTaxes: orderTaxesCents,
      configuredTaxes: configuredTaxCents,
      taxes: orderTaxesCents + configuredTaxCents,
      returns: returnsCents,
      total: totalCostsCents,
    },
    creditsCents: { shopeeRebates: shopeeRebatesCents, total: shopeeRebatesCents },
    profitCents: contributionMarginCents,
    profitMargin: Number(contributionMarginPercent.toFixed(2)),
    isSpx,
    isOwnLogistics,
    spxReferenceCents,
    isReturned: isReturnedOrder(order),
    items: mapOrderItems(order, productCostMap),
    financialDetailsCents,
    rawFinancialFieldsCents,
  };
}

function summarizeMarginOrders({ mappedOrders = [], actualAdsSpendCents = 0 } = {}) {
  const totals = {
    revenueCents: 0, itemsRevenueCents: 0, netReceivedCents: 0, productNetReceivedCents: 0, productsCents: 0, commissionsCents: 0,
    returnsCents: 0, shippingCents: 0, ownLogisticsShippingCents: 0, freightPassThroughCents: 0, voucherCents: 0, rebatesCents: 0,
    freightRebateExcludedCents: 0,
    orderTaxesCents: 0, configuredTaxesCents: 0, allocatedAdsCents: 0,
    adsCents: 0, otherShopeeAdjustmentsCents: 0, contributionMarginCents: 0,
    spxCents: 0, spxCount: 0, missingCostOrders: 0, missingCostItems: 0,
    returnProductRefundCents: 0, returnDisputeAdjustmentCents: 0,
    returnSellerLostCompensationCents: 0,
  };

  for (const mapped of mappedOrders) {
    totals.revenueCents += mapped.revenueCents;
    totals.itemsRevenueCents += mapped.itemsRevenueCents;
    totals.netReceivedCents += mapped.netReceivedCents;
    totals.productNetReceivedCents += mapped.productNetReceivedCents;
    totals.productsCents += mapped.costsCents.products;
    totals.commissionsCents += mapped.costsCents.commissions;
    totals.returnsCents += mapped.costsCents.returns;
    totals.shippingCents += mapped.costsCents.shipping;
    totals.freightPassThroughCents += mapped.costsCents.shippingPassThrough || 0;
    totals.ownLogisticsShippingCents += mapped.costsCents.ownLogisticsShipping || 0;
    totals.voucherCents += mapped.costsCents.voucher;
    totals.freightRebateExcludedCents += mapped.freightRebateExcludedCents || 0;
    totals.rebatesCents += Math.max(
      0,
      mapped.creditsCents.shopeeRebates - (mapped.freightRebateExcludedCents || 0),
    );
    totals.orderTaxesCents += mapped.costsCents.orderTaxes;
    totals.configuredTaxesCents += mapped.costsCents.configuredTaxes;
    totals.allocatedAdsCents += mapped.costsCents.ads;
    totals.otherShopeeAdjustmentsCents += mapped.otherShopeeAdjustmentsCents;
    totals.contributionMarginCents += mapped.profitCents;
    totals.returnProductRefundCents += mapped.returnsCost?.productRefundCents || 0;
    totals.returnDisputeAdjustmentCents += mapped.returnsCost?.disputeAdjustmentCents || 0;
    totals.returnSellerLostCompensationCents += mapped.returnsCost?.sellerLostCompensationCents || 0;
    const missingItems = mapped.items.filter((item) => !item.hasConfiguredCost).length;
    totals.missingCostItems += missingItems;
    if (missingItems > 0) totals.missingCostOrders += 1;
    if (mapped.isSpx) {
      totals.spxCents += mapped.spxReferenceCents;
      totals.spxCount += 1;
    }
  }

  totals.adsCents = Math.max(0, toNumberOrZero(actualAdsSpendCents));
  totals.unallocatedAdsCents = totals.adsCents - totals.allocatedAdsCents;
  totals.contributionMarginCents += totals.allocatedAdsCents - totals.adsCents;
  return totals;
}

async function getMarginData(req, res) {
  const shop = await resolveShop(req, "active");
  const { dateFrom, dateTo, start, end } = parseMarginDateRange(
    req.query?.dateFrom,
    req.query?.dateTo,
  );
  const { orders, shop: shopMeta, monthlyAdsCost, productCostMap, hydration } =
    await loadMarginContext({
      shopInternalId: shop.id, shopeeShopId: shop.shopId, start, end,
    });
  const [taxRate, accountTacos] = await Promise.all([
    resolveTaxRate(req.query.taxRate, shopMeta?.taxRate),
    getPeriodTacos({ shop, start, end, dateFrom, dateTo }),
  ]);
  const taxBase = resolveMarginTaxBase(req.query.taxBase);
  const mappedOrders = orders.map((order) => mapOrderMargin({
    order, taxRate, taxBase, monthlyAdsCost, productCostMap,
  }));
  const totals = summarizeMarginOrders({
    mappedOrders,
    actualAdsSpendCents: accountTacos.spendCents,
  });

  const totalCostsCents = totals.itemsRevenueCents - totals.contributionMarginCents;
  const profitMargin = totals.itemsRevenueCents > 0
    ? (totals.contributionMarginCents / totals.itemsRevenueCents) * 100
    : 0;
  const marginTacos = calculateMarginTacos(accountTacos, totals.itemsRevenueCents);
  res.json({
    revenue: toCurrencyValue(totals.revenueCents),
    productRevenue: toCurrencyValue(totals.itemsRevenueCents),
    netReceived: toCurrencyValue(totals.netReceivedCents),
    productNetReceived: toCurrencyValue(totals.productNetReceivedCents),
    costs: {
      total: toCurrencyValue(totalCostsCents),
      commissions: toCurrencyValue(totals.commissionsCents),
      products: toCurrencyValue(totals.productsCents),
      returns: toCurrencyValue(totals.returnsCents),
      taxes: toCurrencyValue(totals.orderTaxesCents + totals.configuredTaxesCents),
      orderTaxes: toCurrencyValue(totals.orderTaxesCents),
      configuredTaxes: toCurrencyValue(totals.configuredTaxesCents),
      ads: toCurrencyValue(totals.adsCents),
      shipping: toCurrencyValue(totals.shippingCents),
      shippingPassThrough: toCurrencyValue(totals.freightPassThroughCents),
      ownLogisticsShipping: toCurrencyValue(totals.ownLogisticsShippingCents),
      vouchers: toCurrencyValue(totals.voucherCents),
    },
    credits: {
      shopeeRebates: toCurrencyValue(totals.rebatesCents),
      total: toCurrencyValue(totals.rebatesCents),
      freightRebateExcluded: toCurrencyValue(totals.freightRebateExcludedCents),
    },
    ads: {
      total: toCurrencyValue(totals.adsCents),
      allocatedToOrders: toCurrencyValue(totals.allocatedAdsCents),
      notAllocatedToOrders: toCurrencyValue(totals.unallocatedAdsCents),
    },
    returns: {
      total: toCurrencyValue(totals.returnsCents),
      productRefunds: toCurrencyValue(totals.returnProductRefundCents),
      disputeAdjustments: toCurrencyValue(totals.returnDisputeAdjustmentCents),
      sellerLossCompensations: toCurrencyValue(totals.returnSellerLostCompensationCents),
    },
    spx: { totalCents: toCurrencyValue(totals.spxCents), count: totals.spxCount },
    profit: toCurrencyValue(totals.contributionMarginCents),
    profitMargin: toNumberOrZero(profitMargin),
    taxRate,
    taxBase,
    accountTacos: serializeAccountTacos(marginTacos),
    reconciliation: {
      otherShopeeAdjustments: toCurrencyValue(totals.otherShopeeAdjustmentsCents),
    },
    missingCosts: {
      orders: totals.missingCostOrders,
      items: totals.missingCostItems,
    },
    hydration,
  });
}

async function getMarginOrderDetails(req, res) {
  const shop = await resolveShop(req, "active");
  const { dateFrom, dateTo, start, end } = parseMarginDateRange(
    req.query?.dateFrom,
    req.query?.dateTo,
  );
  const { orders, shop: shopMeta, monthlyAdsCost, productCostMap, hydration } =
    await loadMarginContext({
      shopInternalId: shop.id, shopeeShopId: shop.shopId, start, end,
    });
  const [taxRate, accountTacos] = await Promise.all([
    resolveTaxRate(req.query.taxRate, shopMeta?.taxRate),
    getPeriodTacos({ shop, start, end, dateFrom, dateTo }),
  ]);
  const taxBase = resolveMarginTaxBase(req.query.taxBase);
  const mappedOrders = orders.map((order) => mapOrderMargin({
    order, taxRate, taxBase, monthlyAdsCost, productCostMap,
  }));
  const orderDetails = mappedOrders.map((mapped, index) => {
    const order = orders[index];
    return {
      id: mapped.id,
      orderSn: mapped.orderSn,
      orderStatus: mapped.orderStatus,
      shopeeCreateTime: mapped.shopeeCreateTime,
      itemsRevenue: toCurrencyValue(mapped.itemsRevenueCents),
      taxBase: mapped.taxBase,
      configuredTaxBase: toCurrencyValue(mapped.configuredTaxBaseCents),
      shippingRevenue: toCurrencyValue(mapped.shippingRevenueCents),
      freightRebateExcluded: toCurrencyValue(mapped.freightRebateExcludedCents),
      freightSettlement: toCurrencyValue(mapped.freightSettlementCents),
      productNetReceived: toCurrencyValue(mapped.productNetReceivedCents),
      freightPassThrough: toCurrencyValue(mapped.freightPassThroughCents),
      ownLogisticsShipping: toCurrencyValue(mapped.ownLogisticsShippingCents),
      revenue: toCurrencyValue(mapped.revenueCents),
      netReceived: toCurrencyValue(mapped.netReceivedCents),
      netReceivedSource: mapped.netReceivedSource,
      otherShopeeAdjustments: toCurrencyValue(mapped.otherShopeeAdjustmentsCents),
      financialReview: {
        requiresReview: mapped.financialReview.requiresReview,
        reasons: mapped.financialReview.reasons,
        logisticsUnsettled: mapped.financialReview.logisticsUnsettled,
        payoutUnreconciled: mapped.financialReview.payoutUnreconciled,
        buyerShipping: toCurrencyValue(mapped.financialReview.buyerShippingCents),
        actualShipping: toCurrencyValue(mapped.financialReview.actualShippingCents),
        payoutReconciliationDelta: toCurrencyValue(mapped.financialReview.payoutReconciliationDeltaCents),
        reconciliationTolerance: toCurrencyValue(mapped.financialReview.reconciliationToleranceCents),
      },
      shippingCost: {
        source: mapped.shippingCost.source,
        isProvisional: mapped.shippingCost.isProvisional,
        buyerPaid: toCurrencyValue(mapped.shippingCost.buyerPaidShippingCents),
        estimated: toCurrencyValue(mapped.shippingCost.estimatedShippingCents),
        actual: toCurrencyValue(mapped.shippingCost.actualShippingCents),
        shopeeRebate: toCurrencyValue(mapped.shippingCost.shopeeShippingRebateCents),
        ownLogisticsRevenueDeduction: toCurrencyValue(mapped.ownLogisticsShippingCents),
        freightPassThrough: toCurrencyValue(mapped.freightPassThroughCents),
        total: toCurrencyValue(mapped.costsCents.shipping),
      },
      returnsCost: {
        productRefunds: toCurrencyValue(mapped.returnsCost.productRefundCents),
        disputeAdjustments: toCurrencyValue(mapped.returnsCost.disputeAdjustmentCents),
        sellerLossCompensations: toCurrencyValue(mapped.returnsCost.sellerLostCompensationCents),
        total: toCurrencyValue(mapped.returnsCost.totalCents),
      },
      reconciliation: {
        expectedPayout: toCurrencyValue(mapped.reconciliationCents.expectedPayout),
        payout: toCurrencyValue(mapped.reconciliationCents.payout),
        adjustment: toCurrencyValue(mapped.reconciliationCents.adjustment),
        commissions: toCurrencyValue(mapped.reconciliationCents.commissions),
        shipping: toCurrencyValue(mapped.reconciliationCents.shipping),
        sellerVoucher: toCurrencyValue(mapped.reconciliationCents.sellerVoucher),
        returns: toCurrencyValue(mapped.reconciliationCents.returns),
        orderTaxes: toCurrencyValue(mapped.reconciliationCents.orderTaxes),
        shopeeRebates: toCurrencyValue(mapped.reconciliationCents.shopeeRebates),
      },
      costs: {
        products: toCurrencyValue(mapped.costsCents.products),
        commissions: toCurrencyValue(mapped.costsCents.commissions),
        shipping: toCurrencyValue(mapped.costsCents.shipping),
        shippingPassThrough: toCurrencyValue(mapped.costsCents.shippingPassThrough),
        ownLogisticsShipping: toCurrencyValue(mapped.costsCents.ownLogisticsShipping),
        voucher: toCurrencyValue(mapped.costsCents.voucher),
        ads: toCurrencyValue(mapped.costsCents.ads),
        taxes: toCurrencyValue(mapped.costsCents.taxes),
        orderTaxes: toCurrencyValue(mapped.costsCents.orderTaxes),
        configuredTaxes: toCurrencyValue(mapped.costsCents.configuredTaxes),
        returns: toCurrencyValue(mapped.costsCents.returns),
        total: toCurrencyValue(mapped.costsCents.total),
      },
      credits: {
        shopeeRebates: toCurrencyValue(mapped.creditsCents.shopeeRebates),
        total: toCurrencyValue(mapped.creditsCents.total),
      },
      rebatesShopee: toCurrencyValue(mapped.creditsCents.shopeeRebates),
      profit: toCurrencyValue(mapped.profitCents),
      profitMargin: mapped.profitMargin,
      isSpx: mapped.isSpx,
      isOwnLogistics: mapped.isOwnLogistics,
      shippingCarrier: order.shippingCarrier || null,
      isReturned: mapped.isReturned,
      voucherCount: order.voucherFromSellerCents != null ? 1 : 0,
      items: mapped.items.map((item) => ({
        ...item,
        unitPrice: toCurrencyValue(item.unitPriceCents),
        unitCost: toCurrencyValue(item.unitCostCents),
        totalCost: toCurrencyValue(item.totalCostCents),
      })),
      missingCostItems: mapped.items.filter((item) => !item.hasConfiguredCost).length,
      financialDetails: financialBreakdownToCurrency(
        mapped.financialDetailsCents,
      ),
      rawFinancialFields: mapped.rawFinancialFieldsCents.map((row) => ({
        field: row.field,
        value: toCurrencyValue(row.valueCents),
      })),
    };
  });
  const totals = summarizeMarginOrders({
    mappedOrders,
    actualAdsSpendCents: accountTacos.spendCents,
  });
  const marginTacos = calculateMarginTacos(accountTacos, totals.itemsRevenueCents);
  res.json({
    orders: orderDetails,
    taxRate,
    taxBase,
    accountTacos: serializeAccountTacos(marginTacos),
    hydration,
  });
}

function getOrderFinancialBreakdownForCalibration(order, taxRate) {
  return mapOrderMargin({
    order,
    taxRate: Math.max(0, Number(taxRate || 0)) * 100,
    monthlyAdsCost: { byItemId: new Map() },
    productCostMap: new Map(),
  });
}
module.exports = {
  getMarginData: asyncHandler(getMarginData),
  getMarginOrderDetails: asyncHandler(getMarginOrderDetails),
  getOrderFinancialBreakdownForCalibration,
  _test: {
    getConfiguredTaxCents,
    calculateAccountTacos,
    getCurrentMonthRange,
    getCurrentMonthTacos,
    getPeriodTacos,
    getReturnsCostDetailsCents,
    summarizeMarginOrders,
    getFinancialBreakdownCents,
    getShippingCostDetailsCents,
    getNetReceivedCents,
    mapOrderMargin,
    isShopeeXpressCarrier,
    isShopeeManagedCarrier,
    parseMarginDateRange,
    resolveMarginTaxBase,
    resolveTaxRate,
  },
};
