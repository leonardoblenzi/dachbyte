const { findShopForAccountById } = require("../repositories/runtimeSqlRepository");
const {
  findAddressAlertSummaryByIdAndShopId,
  findOrderByShopIdAndOrderSn,
  listOpenAddressAlertsByOrderId,
  listOpenAddressAlertsForShop,
  resolveAddressAlertById,
} = require("../repositories/orderAlertsSqlRepository");

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

// GET /shops/active/orders/address-alerts
// Popup: lista alertas abertos (SEM PII)
async function listOpen(req, res, next) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const limit = Math.min(Number(req.query.limit || 200), 500);

    const alerts = await listOpenAddressAlertsForShop(shop.id, limit);

    res.json({
      items: alerts.map((a) => ({
        id: a.id,
        createdAt: a.createdAt,
        orderSn: a.order.orderSn,
        orderStatus: a.order.orderStatus,
        shopeeUpdateTime: a.order.shopeeUpdateTime,
        shipByDate: a.order.shipByDate,
      })),
    });
  } catch (e) {
    next(e);
  }
}

// GET /shops/active/orders/:orderSn/address-alerts
// Modal do card: retorna antigo vs novo (COM PII, pois usuário autenticado na loja)
async function getOpenByOrderSn(req, res, next) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const orderSn = String(req.params.orderSn || "").trim();
    if (!orderSn) return res.status(400).json({ error: "invalid_orderSn" });

    const order = await findOrderByShopIdAndOrderSn(shop.id, orderSn);

    if (!order) return res.status(404).json({ error: "order_not_found" });

    const alerts = await listOpenAddressAlertsByOrderId(order.id, 10);

    res.json({ items: alerts });
  } catch (e) {
    next(e);
  }
}

// PATCH /shops/active/orders/address-alerts/:id/resolve
async function resolve(req, res, next) {
  try {
    const shop = await getActiveShopOrFail(req, res);
    if (!shop) return;

    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: "invalid_id" });

    // garante que o alerta pertence à loja ativa
    const existing = await findAddressAlertSummaryByIdAndShopId(id, shop.id);

    if (!existing) return res.status(404).json({ error: "alert_not_found" });

    await resolveAddressAlertById(id);

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
}

module.exports = { listOpen, getOpenByOrderSn, resolve };
