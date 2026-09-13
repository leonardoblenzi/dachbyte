const crypto = require("crypto");
const {
  createOrderAddressSnapshot,
  createOrderGeoAddress,
  createOrderItems,
  deleteOrderByShopAndOrderSn,
  deleteOrderItemsByShopAndOrder,
  findLatestOrderAddressSnapshot,
  listExistingOrdersByShopAndOrderSns,
  findOrderGeoAddressSummary,
  findShopByShopeeShopId,
  listLocalProductsByItemIds,
  resolvePendingOrderAddressAlerts,
  updateExistingOrderCoreByShopAndOrderSn,
  updateOrderAddressSnapshotHash,
  updateOrderGeoAddressByOrderId,
  updateOrderIncomeByOrderSn,
  upsertOrderAddressChangeAlert,
  upsertOrderByShopAndOrderSn,
} = require("../repositories/orderSyncSqlRepository");
const { requestShopeeAuthed } = require("./ShopeeAuthedHttp");
const {
  notifyPendingAddressAlertsForShop,
} = require("./addressAlertNotificationService");
const { isChannelLogisticsCarrier } = require("../utils/orderFilters");
const ORDER_DETAIL_FIELDS_FULL =
  "order_id,recipient_address,order_status,create_time,update_time,days_to_ship,ship_by_date,currency,total_amount,region,booking_sn,cod,advance_package,hot_listing_order,is_buyer_shop_collection,message_to_seller,reverse_shipping_fee,item_list,estimated_shipping_fee,actual_shipping_fee,shipping_carrier,payment_method,package_list";
const ORDER_DETAIL_FIELDS_LIGHT =
  "order_id,recipient_address,order_status,update_time,days_to_ship,ship_by_date,shipping_carrier,package_list";

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function parseRangeDays(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 7;
  const x = Math.floor(n);
  return Math.min(Math.max(x, 1), 180);
}

function normalizeStr(v) {
  return String(v || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeZipcode(v) {
  return String(v || "").replace(/\D+/g, "");
}

function normalizeOrderSn(v) {
  const orderSn = String(v || "").trim();
  if (!orderSn) return null;

  const lower = orderSn.toLowerCase();
  if (lower === "null" || lower === "undefined") {
    return null;
  }

  return orderSn;
}

function looksMasked(v) {
  const s = String(v || "").trim();
  if (!s) return false;
  const low = s.toLowerCase();
  return s.includes("*") || low.includes("xxx") || low.includes("masked");
}

function addressKeyFromShopee(addr) {
  const fullAddr = addr?.full_address || "";
  return [
    normalizeZipcode(addr?.zipcode),
    normalizeStr(addr?.state),
    normalizeStr(addr?.city),
    looksMasked(fullAddr) ? "" : normalizeStr(fullAddr),
  ].join("|");
}

function addressKeyFromSnapshot(snap) {
  const fullAddr = snap?.fullAddress || "";
  return [
    normalizeZipcode(snap?.zipcode),
    normalizeStr(snap?.state),
    normalizeStr(snap?.city),
    looksMasked(fullAddr) ? "" : normalizeStr(fullAddr),
  ].join("|");
}

async function persistOrderGeoAddressOnce({ shopInternalId, order, addr }) {
  const stateRaw = String(addr?.state || "").trim();
  const cityRaw = String(addr?.city || "").trim();

  if (!stateRaw || looksMasked(stateRaw)) {
    return;
  }

  const payload = {
    shopId: shopInternalId,
    orderId: order.id,
    orderSn: order.orderSn,
    state: stateRaw,
    stateNorm: normalizeStr(stateRaw),
    city: cityRaw && !looksMasked(cityRaw) ? cityRaw : null,
    cityNorm: cityRaw && !looksMasked(cityRaw) ? normalizeStr(cityRaw) : null,
    zipcode: addr?.zipcode ? String(addr.zipcode) : null,
    fullAddress:
      addr?.full_address && !looksMasked(addr.full_address)
        ? String(addr.full_address)
        : null,
    shopeeCreateTime:
      order.shopeeCreateTime || order.shopeeUpdateTime || new Date(),
    shopeeUpdateTime: order.shopeeUpdateTime || null,
  };

  const existing = await findOrderGeoAddressSummary(order.id);
  if (!existing) {
    try {
      await createOrderGeoAddress(payload);
      return;
    } catch (error) {
      if (String(error?.message || "").includes("duplicate")) {
        return;
      }
      console.error("persistOrderGeoAddressOnce failed:", error);
      return;
    }
  }

  const shouldUpdate =
    (!existing.city && payload.city) ||
    (!existing.fullAddress && payload.fullAddress);

  if (shouldUpdate) {
    await updateOrderGeoAddressByOrderId(order.id, payload);
  }
}

function addressHash(addr) {
  const key = addressKeyFromShopee(addr);
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

function calcLateAndRisk(orderStatus, shipByDate) {
  if (!shipByDate) return { late: false, atRisk: false };

  const now = Date.now();
  const msLeft = shipByDate.getTime() - now;
  const active = orderStatus === "READY_TO_SHIP";

  return {
    late: active && msLeft < 0,
    atRisk: active && msLeft >= 0 && msLeft <= 24 * 60 * 60 * 1000,
  };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isOrderClosed(orderStatus) {
  const s = String(orderStatus || "").toUpperCase();
  return ["COMPLETED", "CANCELLED", "RETURNED"].includes(s);
}

function shouldSyncIncome(orderStatus) {
  const s = String(orderStatus || "").toUpperCase();
  return Boolean(s) && !["UNPAID", "CANCELLED", "IN_CANCEL"].includes(s);
}

function shouldTrackAddressAlerts(orderStatus) {
  return String(orderStatus || "").toUpperCase() === "READY_TO_SHIP";
}

function extractGmvCents(detail) {
  let value = detail?.total_amount;
  if (value == null) return null;
  if (typeof value === "string") value = Number(value.replace(",", "."));
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function num(v) {
  if (v == null) return 0;
  if (typeof v === "string") v = Number(v.replace(",", "."));
  return Number.isFinite(v) ? Number(v) : 0;
}

function extractItemsSubtotalCents(detail) {
  const items = Array.isArray(detail?.item_list) ? detail.item_list : [];
  if (!items.length) return null;

  let sum = 0;
  for (const item of items) {
    const qty = Math.max(
      0,
      Number(item?.model_quantity_purchased ?? item?.quantity ?? 0) || 0,
    );
    const unit =
      num(item?.model_discounted_price) ||
      num(item?.item_price) ||
      num(item?.original_price) ||
      num(item?.model_original_price) ||
      0;

    if (qty <= 0 || unit <= 0) continue;
    sum += Math.round(unit * 100) * qty;
  }

  return sum > 0 ? sum : null;
}

function parseMoneyToCents(v) {
  if (v == null) return 0;
  if (typeof v === "string") v = Number(v.replace(",", "."));
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100);
}

function timestampToDate(value) {
  if (value == null || value === "" || Number(value) === 0) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const ms = numeric > 100000000000 ? numeric : numeric * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

function firstTimestampDate(source, fieldNames = []) {
  for (const fieldName of fieldNames) {
    const value = String(fieldName || "")
      .split(".")
      .filter(Boolean)
      .reduce((acc, key) => (acc == null ? undefined : acc[key]), source);
    const date = timestampToDate(value);
    if (date) return date;
  }
  return null;
}

function extractPackageNumbers(detail) {
  const numbers = [];
  const push = (value) => {
    const normalized = String(value || "").trim();
    if (normalized) numbers.push(normalized);
  };

  push(detail?.package_number);
  push(detail?.packageNumber);
  if (Array.isArray(detail?.package_number_list)) {
    detail.package_number_list.forEach(push);
  }
  if (Array.isArray(detail?.package_list)) {
    detail.package_list.forEach((pkg) => push(pkg?.package_number || pkg?.packageNumber));
  }
  return Array.from(new Set(numbers));
}

function normalizePackageDetailForOrder(pkg) {
  if (!pkg || typeof pkg !== "object") return {};

  const driverInfo =
    pkg.driver_info && typeof pkg.driver_info === "object"
      ? pkg.driver_info
      : {};
  const estimatedDeliveryStartTime = firstTimestampDate(pkg, [
    "estimated_delivery_start_time",
    "delivery_start_time",
    "earliest_delivery_time",
    "buyer_eta_start_time",
  ]);
  const estimatedDeliveryEndTime = firstTimestampDate(pkg, [
    "estimated_delivery_end_time",
    "delivery_end_time",
    "latest_delivery_time",
    "buyer_eta_end_time",
  ]);
  const estimatedDeliveryTime =
    firstTimestampDate(pkg, [
      "estimated_delivery_time",
      "estimated_delivery_date",
      "expected_delivery_time",
      "expected_delivery_date",
      "delivery_time",
      "delivery_date",
      "buyer_eta_time",
      "estimated_arrival_time",
      "eta_delivery_time",
    ]) ||
    estimatedDeliveryEndTime ||
    estimatedDeliveryStartTime;

  return {
    packageNumber: pkg.package_number || null,
    packageFulfillmentStatus:
      pkg.fulfillment_status || pkg.logistics_status || null,
    packageLogisticsChannelId:
      pkg.logistics_channel_id == null ? null : Number(pkg.logistics_channel_id),
    packageTrackingNumber:
      pkg.tracking_number && pkg.tracking_number !== "-"
        ? String(pkg.tracking_number)
        : null,
    packageShipByDate: timestampToDate(pkg.ship_by_date),
    packagePickupDoneTime: timestampToDate(pkg.pickup_done_time),
    estimatedDeliveryTime,
    estimatedDeliveryStartTime,
    estimatedDeliveryEndTime,
    preparationEndTime: timestampToDate(pkg.preparation_end_time),
    driverEtaStartTime: timestampToDate(driverInfo.eta_start_time),
    driverEtaEndTime: timestampToDate(driverInfo.eta_end_time),
    packageDetailRaw: pkg,
  };
}

async function fetchPackageDetailsByOrderSn({ shopeeShopId, details = [] }) {
  const packageEntries = [];
  for (const detail of Array.isArray(details) ? details : []) {
    const orderSn = normalizeOrderSn(detail?.order_sn);
    if (!orderSn) continue;
    for (const packageNumber of extractPackageNumbers(detail)) {
      packageEntries.push({ orderSn, packageNumber });
    }
  }

  const packageNumbers = Array.from(
    new Set(packageEntries.map((entry) => entry.packageNumber).filter(Boolean)),
  );
  if (!packageNumbers.length) return new Map();

  const orderByPackage = new Map(
    packageEntries.map((entry) => [entry.packageNumber, entry.orderSn]),
  );
  const byOrderSn = new Map();

  for (const batch of chunk(packageNumbers, 50)) {
    try {
      const payload = await requestShopeeAuthed({
        method: "get",
        path: "/api/v2/order/get_package_detail",
        shopId: String(shopeeShopId),
        query: {
          package_number_list: batch.join(","),
        },
      });

      if (payload?.error) {
        console.warn("[OrderSyncService] get_package_detail failed", {
          shopId: String(shopeeShopId),
          error: payload.error,
          message: payload.message || "",
        });
        continue;
      }

      const packages = Array.isArray(payload?.response?.package_list)
        ? payload.response.package_list
        : [];
      for (const pkg of packages) {
        const orderSn =
          normalizeOrderSn(pkg?.order_sn) ||
          orderByPackage.get(String(pkg?.package_number || ""));
        if (!orderSn) continue;
        byOrderSn.set(orderSn, normalizePackageDetailForOrder(pkg));
      }
    } catch (error) {
      console.warn("[OrderSyncService] get_package_detail exception", {
        shopId: String(shopeeShopId),
        error: String(error?.message || error),
      });
    }
  }

  return byOrderSn;
}

async function persistOrderItems({ shopInternalId, order, detail }) {
  const items = Array.isArray(detail?.item_list) ? detail.item_list : [];

  await deleteOrderItemsByShopAndOrder(shopInternalId, order.id);
  if (!items.length) return;

  const itemIds = items
    .map((item) => (item.item_id ? BigInt(item.item_id) : null))
    .filter(Boolean);

  const localProducts = await listLocalProductsByItemIds(
    shopInternalId,
    itemIds,
  );
  const productMap = new Map();
  for (const product of localProducts) {
    productMap.set(String(product.itemId), product.id);
  }

  const weights = items.map((item) => {
    const quantity = Math.max(
      0,
      Number(item?.model_quantity_purchased ?? item?.quantity ?? 0) || 0,
    );
    const priceBase =
      num(item?.model_discounted_price) ||
      num(item?.item_price) ||
      num(item?.original_price) ||
      num(item?.model_original_price) ||
      0;
    return { item, quantity, weight: priceBase * quantity };
  });

  const totalWeight = weights.reduce((sum, entry) => sum + entry.weight, 0);
  const orderBaseCents = Number(
    order.itemsSubtotalCents ?? order.gmvCents ?? 0,
  );
  let remaining = orderBaseCents;

  const rows = weights.map((entry, index) => {
    const itemId =
      entry.item?.item_id != null ? BigInt(String(entry.item.item_id)) : null;
    const modelId =
      entry.item?.model_id != null ? BigInt(String(entry.item.model_id)) : null;
    const productId = productMap.get(String(itemId)) || null;
    const sku =
      entry.item?.item_sku || entry.item?.model_sku || entry.item?.sku || null;
    const itemName = entry.item?.item_name || entry.item?.name || null;

    let orderPrice = 0;
    if (totalWeight > 0) {
      if (index === weights.length - 1) {
        orderPrice = remaining;
      } else {
        orderPrice = Math.round((orderBaseCents * entry.weight) / totalWeight);
        remaining -= orderPrice;
      }
    }

    return {
      shopId: shopInternalId,
      orderId: order.id,
      productId,
      itemId,
      modelId,
      itemSku: sku,
      itemName,
      quantity: entry.quantity,
      orderPrice,
    };
  });

  await createOrderItems(rows);
}

async function removeChannelLogisticsOrder(shopInternalId, orderSn) {
  await deleteOrderByShopAndOrderSn(shopInternalId, orderSn);
}

async function trackOrderAddressAndAlerts(order, addr) {
  let addressChanged = false;
  if (
    isOrderClosed(order.orderStatus) ||
    !shouldTrackAddressAlerts(order.orderStatus)
  ) {
    await resolvePendingOrderAddressAlerts(order.id);
    return { addressChanged: false };
  }

  if (!addr) return { addressChanged: false };

  const currentKey = addressKeyFromShopee(addr);
  const currentHash = addressHash(addr);
  const last = await findLatestOrderAddressSnapshot(order.id);
  const lastKey = last ? addressKeyFromSnapshot(last) : null;
  const changedNow = !last ? true : currentKey !== lastKey;

  if (last && !changedNow && last.addressHash !== currentHash) {
    await updateOrderAddressSnapshotHash(last.id, currentHash);
  }

  if (changedNow) {
    const newSnap = await createOrderAddressSnapshot({
      orderId: order.id,
      name: addr.name || null,
      phone: addr.phone || null,
      town: addr.town || null,
      district: addr.district || null,
      city: addr.city || null,
      state: addr.state || null,
      region: addr.region || null,
      zipcode: addr.zipcode || null,
      fullAddress: addr.full_address || null,
      addressHash: currentHash,
    });

    if (last) {
      addressChanged = true;
      await upsertOrderAddressChangeAlert(order.id, currentHash, {
        oldSnapshotId: last.id,
        newSnapshotId: newSnap.id,
        oldHash: last.addressHash,
      });
    }
  }

  return { addressChanged };
}

async function upsertOrderAndSnapshot(shopInternalId, detail, packageDetail = null) {
  const orderSn = normalizeOrderSn(detail?.order_sn);
  if (!orderSn) {
    return {
      skipped: true,
      skippedReason: "missing_order_sn",
      addressChanged: false,
      late: false,
      atRisk: false,
      orderSn: "-",
    };
  }

  if (isChannelLogisticsCarrier(detail.shipping_carrier)) {
    await removeChannelLogisticsOrder(shopInternalId, orderSn);
    return {
      skipped: true,
      skippedReason: "channel_logistics",
      addressChanged: false,
      late: false,
      atRisk: false,
      orderSn,
    };
  }

  const gmvCandidate = extractGmvCents(detail);
  const itemsSubtotalCents = extractItemsSubtotalCents(detail);
  const shippingCents =
    itemsSubtotalCents != null && gmvCandidate != null
      ? Math.max(0, gmvCandidate - itemsSubtotalCents)
      : null;
  const shipByDate = detail.ship_by_date
    ? new Date(Number(detail.ship_by_date) * 1000)
    : null;

  const order = await upsertOrderByShopAndOrderSn(shopInternalId, orderSn, {
    orderId: detail.order_id ?? null,
    gmvCents: gmvCandidate ?? 0,
    totalAmountCents: gmvCandidate ?? 0,
    orderStatus: detail.order_status || null,
    region: detail.region || null,
    currency: detail.currency || null,
    daysToShip: detail.days_to_ship ?? null,
    shipByDate,
    shopeeCreateTime: detail.create_time
      ? new Date(Number(detail.create_time) * 1000)
      : null,
    shopeeUpdateTime: detail.update_time
      ? new Date(Number(detail.update_time) * 1000)
      : null,
    bookingSn: detail.booking_sn || null,
    cod: detail.cod ?? null,
    advancePackage: detail.advance_package ?? null,
    hotListingOrder: detail.hot_listing_order ?? null,
    isBuyerShopCollection: detail.is_buyer_shop_collection ?? null,
    messageToSeller: detail.message_to_seller || null,
    reverseShippingFee:
      detail.reverse_shipping_fee != null
        ? parseMoneyToCents(detail.reverse_shipping_fee)
        : null,
    itemsSubtotalCents,
    shippingCents,
    estimatedShippingFeeCents:
      detail.estimated_shipping_fee != null
        ? parseMoneyToCents(detail.estimated_shipping_fee)
        : 0,
    actualShippingFeeCents:
      detail.actual_shipping_fee != null
        ? parseMoneyToCents(detail.actual_shipping_fee)
        : 0,
    shippingCarrier: detail.shipping_carrier || null,
    paymentMethod: detail.payment_method || null,
    ...(packageDetail || {}),
  });

  await persistOrderItems({ shopInternalId, order, detail });

  const addr = detail.recipient_address || null;
  if (addr) {
    await persistOrderGeoAddressOnce({ shopInternalId, order, addr });
  }

  const { addressChanged } = await trackOrderAddressAndAlerts(order, addr);

  const { late, atRisk } = calcLateAndRisk(order.orderStatus, order.shipByDate);
  return { addressChanged, late, atRisk, orderSn: order.orderSn };
}

async function syncExistingOrderMinimal(
  shopInternalId,
  existingOrder,
  detail,
  packageDetail = null,
) {
  const orderSn = normalizeOrderSn(detail?.order_sn || existingOrder?.orderSn);
  if (!orderSn) {
    return {
      skipped: true,
      skippedReason: "missing_order_sn",
      addressChanged: false,
      late: false,
      atRisk: false,
      orderSn: "-",
    };
  }

  if (isChannelLogisticsCarrier(detail?.shipping_carrier)) {
    await removeChannelLogisticsOrder(shopInternalId, orderSn);
    return {
      skipped: true,
      skippedReason: "channel_logistics",
      addressChanged: false,
      late: false,
      atRisk: false,
      orderSn,
    };
  }

  const shipByDate = detail?.ship_by_date
    ? new Date(Number(detail.ship_by_date) * 1000)
    : null;

  const updatedOrder = await updateExistingOrderCoreByShopAndOrderSn(
    shopInternalId,
    orderSn,
    {
      orderId: detail?.order_id ?? null,
      orderStatus: detail?.order_status || null,
      daysToShip: detail?.days_to_ship ?? null,
      shipByDate,
      shopeeUpdateTime: detail?.update_time
        ? new Date(Number(detail.update_time) * 1000)
        : null,
      shippingCarrier: detail?.shipping_carrier || null,
      ...(packageDetail || {}),
    },
  );

  const order = updatedOrder || existingOrder;
  const addr = detail?.recipient_address || null;
  if (addr && order?.id) {
    await persistOrderGeoAddressOnce({ shopInternalId, order, addr });
  }

  const { addressChanged } =
    order?.id != null
      ? await trackOrderAddressAndAlerts(order, addr)
      : { addressChanged: false };
  const { late, atRisk } = calcLateAndRisk(order?.orderStatus, order?.shipByDate);

  return {
    skipped: false,
    skippedReason: null,
    addressChanged,
    late,
    atRisk,
    orderSn,
  };
}

async function fetchOrderDetails({
  shopeeShopId,
  orderSns,
  responseOptionalFields,
}) {
  if (!Array.isArray(orderSns) || !orderSns.length) return [];

  const details = await requestShopeeAuthed({
    method: "get",
    path: "/api/v2/order/get_order_detail",
    shopId: String(shopeeShopId),
    query: {
      order_sn_list: orderSns.join(","),
      response_optional_fields: responseOptionalFields,
    },
  });

  if (details?.error) {
    if (String(responseOptionalFields || "").includes("package_list")) {
      const fallbackFields = String(responseOptionalFields || "")
        .split(",")
        .map((field) => field.trim())
        .filter((field) => field && field !== "package_list")
        .join(",");
      const fallback = await requestShopeeAuthed({
        method: "get",
        path: "/api/v2/order/get_order_detail",
        shopId: String(shopeeShopId),
        query: {
          order_sn_list: orderSns.join(","),
          response_optional_fields: fallbackFields,
        },
      });

      if (!fallback?.error) {
        return Array.isArray(fallback?.response?.order_list)
          ? fallback.response.order_list
          : [];
      }
    }

    throw new Error(
      `Shopee get_order_detail failed: ${details.error} ${details.message || ""}`,
    );
  }

  return Array.isArray(details?.response?.order_list)
    ? details.response.order_list
    : [];
}

function sumBreakdown(items, nameKey) {
  if (!Array.isArray(items)) return 0;
  const keys = Array.isArray(nameKey) ? nameKey : [nameKey];
  let total = 0;
  for (const item of items) {
    if (keys.includes(item.name)) {
      total += item.amount || 0;
    }
  }
  return Math.round(total * 100);
}

function firstMoneyField(info, fieldNames = []) {
  for (const fieldName of fieldNames) {
    if (info?.[fieldName] != null) {
      return parseMoneyToCents(info[fieldName]);
    }
  }
  return 0;
}

function parseIncomeBreakdown(info) {
  if (!info?.seller_income_breakdown && !info?.order_sn) {
    return {};
  }

  let allItems = [];
  if (Array.isArray(info.seller_income_breakdown)) {
    for (const group of info.seller_income_breakdown) {
      if (Array.isArray(group.items)) {
        allItems.push(...group.items);
      }
    }
  }

  if (!allItems.length) {
    return {
      finCommissionCents: firstMoneyField(info, [
        "net_commission_fee",
        "commission_fee",
      ]),
      finServiceFeeCents: firstMoneyField(info, [
        "net_service_fee",
        "service_fee",
      ]),
      finTransactionFeeCents: firstMoneyField(info, [
        "seller_transaction_fee",
        "transaction_fee",
        "credit_card_transaction_fee",
        "seller_order_processing_fee",
      ]),
      finShippingFeeCents: firstMoneyField(info, [
        "final_shipping_fee",
        "actual_shipping_fee",
      ]),
      finVoucherSellerCents: firstMoneyField(info, ["voucher_from_seller"]),
      finVoucherShopeeCents: firstMoneyField(info, ["voucher_from_shopee"]),
      finShopeeDiscountCents: firstMoneyField(info, [
        "shopee_discount",
        "original_shopee_discount",
      ]),
      finDiscountFromCoinCents: firstMoneyField(info, [
        "coins",
        "discount_from_coin",
      ]),
      finDiscountVoucherShopeeCents: firstMoneyField(info, [
        "prorated_shopee_voucher_offset_return_items",
      ]),
      finDiscountVoucherSellerCents: firstMoneyField(info, [
        "prorated_seller_voucher_offset_return_items",
      ]),
    };
  }

  return {
    finCommissionCents: sumBreakdown(allItems, "COMMISSION_FEE"),
    finServiceFeeCents: sumBreakdown(allItems, "SERVICE_FEE"),
    finTransactionFeeCents: sumBreakdown(allItems, "TRANSACTION_FEE"),
    finShippingFeeCents: sumBreakdown(allItems, [
      "SHIPPING_FEE",
      "SHIPPING_FEE_DISCOUNT_FROM_3PL",
    ]),
    finVoucherSellerCents: sumBreakdown(allItems, "VOUCHER_FROM_SELLER"),
    finVoucherShopeeCents: sumBreakdown(allItems, "VOUCHER_FROM_SHOPEE"),
    finShopeeDiscountCents: sumBreakdown(allItems, "SHOPEE_DISCOUNT"),
    finDiscountFromCoinCents: sumBreakdown(allItems, "COIN"),
    finDiscountVoucherShopeeCents: sumBreakdown(
      allItems,
      "VOUCHER_FROM_SHOPEE",
    ),
    finDiscountVoucherSellerCents: sumBreakdown(
      allItems,
      "VOUCHER_FROM_SELLER",
    ),
  };
}

async function syncOrderIncome(shopInternalId, shopeeShopId, orderSn) {
  try {
    const escrow = await requestShopeeAuthed({
      method: "get",
      path: "/api/v2/payment/get_escrow_detail",
      shopId: String(shopeeShopId),
      query: { order_sn: orderSn },
    });

    if (escrow?.error) {
      return false;
    }

    const info = escrow?.response?.order_income;
    if (!info) return false;

    await updateOrderIncomeByOrderSn(shopInternalId, orderSn, {
      incomeSyncedAt: new Date(),
      incomeStatus: info.status || "UNKNOWN",
      incomeNetCents: parseMoneyToCents(info.escrow_amount),
      incomeDetailRaw:
        escrow?.response &&
        typeof escrow.response === "object" &&
        !Array.isArray(escrow.response)
          ? escrow.response
          : { order_income: info },
      ...parseIncomeBreakdown(info),
    });

    return true;
  } catch (error) {
    console.error(`[Income] Error syncing ${orderSn}:`, error.message);
    return false;
  }
}

async function syncOrderIncomeBatch(shopInternalId, shopeeShopId, orderSns) {
  if (!orderSns.length) return;

  try {
    const batchRes = await requestShopeeAuthed({
      method: "get",
      path: "/api/v2/payment/get_escrow_detail_batch",
      shopId: String(shopeeShopId),
      query: { order_sn_list: orderSns.join(",") },
    });

    const list = batchRes?.response?.order_income_list || [];
    if (!list.length && !batchRes?.error) {
      return;
    }

    for (const info of list) {
      const orderSn = info.order_sn;
      if (!orderSn) continue;

      await updateOrderIncomeByOrderSn(shopInternalId, orderSn, {
        incomeSyncedAt: new Date(),
        incomeStatus: info.status || "UNKNOWN",
        incomeNetCents: parseMoneyToCents(info.escrow_amount),
        incomeDetailRaw: { order_income: info },
        ...parseIncomeBreakdown(info),
      });
    }
  } catch (error) {
    console.error("[IncomeBatch] Error:", error.message);
  }
}

async function syncOrdersForShop({ shopeeShopId, rangeDays, pageSize = 50 }) {
  const shopRow = await findShopByShopeeShopId(shopeeShopId);

  if (!shopRow) {
    const err = new Error("Shop nao cadastrado no banco");
    err.statusCode = 400;
    throw err;
  }

  const timeTo = nowTs();
  const timeFrom = timeTo - rangeDays * 24 * 60 * 60;
  const WINDOW_DAYS = 14;
  const windowSec = WINDOW_DAYS * 24 * 60 * 60;

  let processed = 0;
  let skippedChannelLogistics = 0;
  let addressChangedCount = 0;
  let lateCount = 0;
  let atRiskCount = 0;

  for (let windowTo = timeTo; windowTo > timeFrom; windowTo -= windowSec) {
    const windowFrom = Math.max(timeFrom, windowTo - windowSec);
    let cursor = "";
    let more = true;

    while (more) {
      const list = await requestShopeeAuthed({
        method: "get",
        path: "/api/v2/order/get_order_list",
        shopId: String(shopeeShopId),
        query: {
          time_range_field: "update_time",
          time_from: windowFrom,
          time_to: windowTo,
          page_size: pageSize,
          cursor,
        },
      });

      if (list?.error) {
        throw new Error(
          `Shopee get_order_list failed: ${list.error} ${list.message || ""}`,
        );
      }

      const listOrders = list?.response?.order_list || [];
      const orderSns = listOrders
        .map((order) => order.order_sn)
        .filter(Boolean);

      for (const batch of chunk(orderSns, 20)) {
        if (!batch.length) continue;
        const existingOrders = await listExistingOrdersByShopAndOrderSns(
          shopRow.id,
          batch,
        );
        const existingByOrderSn = new Map(
          existingOrders.map((order) => [String(order.orderSn), order]),
        );

        let orderList = [];
        if (existingByOrderSn.size === 0) {
          orderList = await fetchOrderDetails({
            shopeeShopId,
            orderSns: batch,
            responseOptionalFields: ORDER_DETAIL_FIELDS_FULL,
          });
        } else {
          const lightDetails = await fetchOrderDetails({
            shopeeShopId,
            orderSns: batch,
            responseOptionalFields: ORDER_DETAIL_FIELDS_LIGHT,
          });
          const lightPackageDetailsByOrderSn = await fetchPackageDetailsByOrderSn({
            shopeeShopId,
            details: lightDetails,
          });

          const lightByOrderSn = new Map(
            lightDetails
              .map((detail) => [String(detail?.order_sn || ""), detail])
              .filter((entry) => entry[0]),
          );

          for (const detail of lightDetails) {
            const key = String(detail?.order_sn || "");
            if (!key || !existingByOrderSn.has(key)) continue;

            const {
              skipped,
              skippedReason,
              addressChanged,
              late,
              atRisk,
            } = await syncExistingOrderMinimal(
              shopRow.id,
              existingByOrderSn.get(key),
              detail,
              lightPackageDetailsByOrderSn.get(key) || null,
            );

            if (skipped) {
              if (skippedReason === "channel_logistics") {
                skippedChannelLogistics += 1;
              }
              continue;
            }

            processed += 1;
            if (addressChanged) addressChangedCount += 1;
            if (late) lateCount += 1;
            if (atRisk) atRiskCount += 1;
          }

          const newOrderSns = batch.filter((orderSn) => {
            if (existingByOrderSn.has(String(orderSn))) return false;
            const detail = lightByOrderSn.get(String(orderSn));
            if (!detail) return false;
            return !isChannelLogisticsCarrier(detail?.shipping_carrier);
          });

          if (!newOrderSns.length) {
            continue;
          }

          orderList = await fetchOrderDetails({
            shopeeShopId,
            orderSns: newOrderSns,
            responseOptionalFields: ORDER_DETAIL_FIELDS_FULL,
          });
        }

        const packageDetailsByOrderSn = await fetchPackageDetailsByOrderSn({
          shopeeShopId,
          details: orderList,
        });
        const incomeSyncCandidates = [];
        for (const detail of orderList) {
          const orderSnForPackage = normalizeOrderSn(detail?.order_sn);
          const {
            skipped,
            skippedReason,
            addressChanged,
            late,
            atRisk,
            orderSn,
          } = await upsertOrderAndSnapshot(
            shopRow.id,
            detail,
            orderSnForPackage ? packageDetailsByOrderSn.get(orderSnForPackage) || null : null,
          );

          if (skipped) {
            if (skippedReason === "channel_logistics") {
              skippedChannelLogistics += 1;
            }
            continue;
          }

          processed += 1;
          if (addressChanged) addressChangedCount += 1;
          if (late) lateCount += 1;
          if (atRisk) atRiskCount += 1;

          if (shouldSyncIncome(detail.order_status)) {
            incomeSyncCandidates.push(orderSn);
          }
        }

        if (incomeSyncCandidates.length > 0) {
          await syncOrderIncomeBatch(
            shopRow.id,
            String(shopeeShopId),
            incomeSyncCandidates,
          );
        }
      }

      more = Boolean(list?.response?.more);
      cursor = String(list?.response?.next_cursor || "");
    }
  }

  let addressAlertNotification = null;
  try {
    addressAlertNotification = await notifyPendingAddressAlertsForShop({
      shopId: shopRow.id,
    });
  } catch (error) {
    console.error("[OrderSyncService] address alert notification failed", {
      shopIdInternal: shopRow.id,
      shopeeShopId: String(shopeeShopId),
      error: String(error?.message || error),
    });

    addressAlertNotification = {
      ok: false,
      error: String(error?.message || error),
    };
  }

  return {
    status: "ok",
    shop_id: String(shopeeShopId),
    rangeDays,
    summary: {
      processed,
      skippedChannelLogistics,
      addressChanged: addressChangedCount,
      late: lateCount,
      atRisk: atRiskCount,
    },
    notifications: {
      addressAlerts: addressAlertNotification,
    },
    warning:
      processed === 0
        ? "Nenhum pedido retornado pela Shopee no periodo. Verifique shop_id, permissoes do token e filtros do get_order_list."
        : null,
  };
}

module.exports = {
  parseRangeDays,
  syncOrdersForShop,
  syncOrderIncome,
  syncOrderIncomeBatch,
  isOrderClosed,
  shouldSyncIncome,
};
