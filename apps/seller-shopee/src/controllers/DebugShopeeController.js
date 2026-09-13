const { findShopByDbIdAndAccountId } = require("../repositories/operationsSqlRepository");
const ShopeeOrderService = require("../services/ShopeeOrderService");

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

  const shop = await findShopByDbIdAndAccountId(shopDbId, req.auth.accountId);

  if (!shop) {
    res.status(404).json({ error: "shop_not_found" });
    return null;
  }

  return shop;
}

function responseHasMaskedStars(obj) {
  // Não loga conteúdo, só detecta padrão "***"
  try {
    const s = JSON.stringify(obj);
    return s.includes('"***"') || s.includes("***");
  } catch (_) {
    return false;
  }
}

async function testShopeeOrderDetailMask(req, res, next) {
  try {
    const shopeeShopId = String(req.params.shopId || "").trim();
    const orderSn = String(req.params.orderSn || "").trim();
    if (!shopeeShopId)
      return res.status(400).json({ error: "shopId_required" });
    if (!orderSn) return res.status(400).json({ error: "orderSn_required" });

    const responseOptionalFields = String(
      req.query.fields || "recipient_address,total_amount,pay_time",
    );

    const raw = await ShopeeOrderService.getOrderDetail({
      shopId: shopeeShopId,
      orderSnList: [orderSn],
      responseOptionalFields,
    });

    const masked = responseHasMaskedStars(raw);

    return res.json({
      ok: true,
      shop_id: shopeeShopId,
      order_sn: orderSn,
      masked,
      fields: responseOptionalFields,
    });
  } catch (e) {
    return next(e);
  }
}

async function debugOrderTotals(req, res, next) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const orderSn = String(req.params.orderSn || "").trim();
    if (!orderSn) return res.status(400).json({ error: "orderSn_required" });

    const responseOptionalFields = String(
      req.query.fields || "total_amount,pay_time,currency",
    );

    const raw = await ShopeeOrderService.getOrderDetail({
      shopId: String(shop.shopId), // ✅ Shopee shop_id real
      orderSnList: [orderSn],
      responseOptionalFields,
    });

    const masked = responseHasMaskedStars(raw);

    const first = raw?.response?.order_list?.[0] || null;

    return res.json({
      ok: true,
      masked,
      fields: responseOptionalFields,
      order_sn: first?.order_sn || orderSn,
      order_id: first?.order_id || null,
      order_number: first?.order_number || null,
      portal_order_ref:
        first?.order_id ||
        first?.order_number ||
        first?.platform_order_id ||
        first?.order_sn ||
        orderSn,
      currency: first?.currency || null,
      total_amount: first?.total_amount ?? null,
      pay_time: first?.pay_time ?? null,
    });
  } catch (e) {
    return next(e);
  }
}

module.exports = {
  testShopeeOrderDetailMask,
  debugOrderTotals,
};
