// @ts-check
"use strict";

const { requestJson, requestBinary } = require("../../platform/http");
const { hmacSha256Hex } = require("../../platform/crypto");
const { classifyWriteError, safeEqualHex, unauthorized, mergeLines } = require("../writeResult");

/** Na Shopee só CANCELLED desfaz a venda (IN_CANCEL ainda pode ser recusado; UNPAID já reserva estoque). */
const CANCELLED = new Set(["CANCELLED"]);
const ORDER_PAGE = 50;
/** get_order_list aceita no máximo 15 dias por consulta. */
const MAX_WINDOW_S = 14 * 24 * 60 * 60;
/** Erros da Shopee que são limite/instabilidade (pode tentar de novo). */
const RETRYABLE_CODES = new Set(["error_busy", "error_rate_limit", "error_server", "error_inner"]);
const ORDER_PUSH_CODE = 3;

/** Situação da Shopee → situação padronizada (devolução continua como venda no estoque; sai da cobrança). */
const SHOPEE_STAGES = /** @type {Record<string, import("../../modules/orders/repository").OrderStage>} */ ({
  UNPAID: "new", READY_TO_SHIP: "paid", IN_CANCEL: "paid", PROCESSED: "ready_to_ship", RETRY_SHIP: "ready_to_ship",
  SHIPPED: "shipped", TO_CONFIRM_RECEIVE: "shipped", COMPLETED: "delivered", CANCELLED: "cancelled",
  TO_RETURN: "returned", REQUESTED_RETURN: "returned", RETURNED: "returned",
});

/** Texto mascarado pela Shopee ("***") não serve. @param {unknown} v */
const unmasked = (v) => { const t = String(v ?? "").trim(); return t && !t.includes("*") ? t : null; };
/** Unix (s) → ISO. @param {unknown} v */
const unix = (v) => (Number(v) > 0 ? new Date(Number(v) * 1000).toISOString() : null);

/** @param {any} order @returns {import("../../modules/orders/repository").ChannelOrder | null} */
function mapOrder(order) {
  if (!order?.order_sn) return null;
  const status = String(order.order_status || "").toUpperCase();
  const items = Array.isArray(order.item_list) ? order.item_list : [];
  const subtotal = items.reduce((/** @type {number} */ s, /** @type {any} */ i) => s + (Number(i?.model_discounted_price ?? i?.item_price ?? 0) * (Number(i?.model_quantity_purchased ?? i?.quantity) || 0)), 0);
  const total = order.total_amount == null ? null : Number(order.total_amount);
  const pack = (Array.isArray(order.package_list) ? order.package_list : [])[0] || {};
  const tracking = String(pack.tracking_number || "").trim();
  return {
    orderId: String(order.order_sn),
    status: CANCELLED.has(status) ? "cancelled" : "open",
    stage: SHOPEE_STAGES[status] || "paid",
    channelStatus: status || null,
    fulfillment: false,
    total,
    productsTotal: items.length ? Math.round(subtotal * 100) / 100 : null,
    shippingPaid: total != null && items.length && total - subtotal > 0 ? Math.round((total - subtotal) * 100) / 100 : null,
    shipBy: unix(order.ship_by_date),
    shippedAt: unix(order.pickup_done_time),
    carrier: order.shipping_carrier || null,
    trackingCode: tracking && tracking !== "-" ? tracking : null,
    shipmentId: pack.package_number || null,
    channelRefs: { packageNumbers: (Array.isArray(order.package_list) ? order.package_list : []).map((/** @type {any} */ p) => p?.package_number).filter(Boolean).map(String) },
    buyer: { name: null, city: unmasked(order.recipient_address?.city), state: unmasked(order.recipient_address?.state) },
    orderedAt: order.create_time ? new Date(Number(order.create_time) * 1000).toISOString() : null,
    updatedAt: order.update_time ? new Date(Number(order.update_time) * 1000).toISOString() : null,
    lines: mergeLines((Array.isArray(order.item_list) ? order.item_list : []).map((/** @type {any} */ item) => {
      const model = Number(item?.model_id) ? String(item.model_id) : "";
      return {
        lineKey: `${item?.item_id}:${model}`,
        listingId: String(item?.item_id ?? ""),
        variationId: model,
        channelSku: item?.model_sku || item?.item_sku || null,
        title: item?.item_name || null,
        quantity: Number(item?.model_quantity_purchased ?? item?.quantity) || 0,
        unitPrice: item?.model_discounted_price == null ? null : Number(item.model_discounted_price),
      };
    }).filter((/** @type {any} */ l) => l.listingId)),
  };
}

/** Estoque do vendedor (o que o Hub grava). Cai para o disponível total se seller_stock não vier. @param {any} node */
function sellerStock(node) {
  const list = node?.stock_info_v2?.seller_stock;
  if (Array.isArray(list) && list.length) return list.reduce((sum, s) => sum + (Number(s?.stock) || 0), 0);
  const total = node?.stock_info_v2?.summary_info?.total_available_stock;
  return total == null ? null : Number(total);
}

/**
 * Pedidos, notificações e estoque da Shopee.
 * Diferente do módulo DACH Shopee: usa o formato atual (seller_stock), confere relendo e valida a assinatura
 * oficial do push (Authorization = HMAC-SHA256(partner_key, url_de_retorno + "|" + corpo_bruto)).
 */
const shopeeOrders = {
  /** @this {any} @param {{ headers: Record<string, any>, rawBody: Buffer, url: string }} input */
  parseWebhook({ headers, rawBody, url }) {
    const expected = hmacSha256Hex(this.partnerKey, `${url}|${rawBody.toString("utf8")}`);
    if (!safeEqualHex(expected, String(headers.authorization || ""))) throw unauthorized("Assinatura inválida.");
    let body;
    try { body = JSON.parse(rawBody.toString("utf8")); } catch (_error) { throw unauthorized("Corpo inválido."); }
    const sn = body?.data?.ordersn || body?.data?.order_sn;
    const shop = body?.shop_id ?? body?.data?.shop_id;
    if (Number(body?.code) !== ORDER_PUSH_CODE || !sn || shop == null) return { events: [] };
    return {
      events: [{
        externalAccountId: String(shop), topic: "order", resourceId: String(sn),
        dedupeKey: `shopee:${sn}:${body.data.status || ""}:${body.data.update_time || body.timestamp || ""}`, payload: body,
      }],
    };
  },

  /** @this {any} @param {{ accessToken: string, externalAccountId: string }} account @param {string[]} sns */
  async orderDetails(account, sns) {
    if (!sns.length) return [];
    const res = await this.shopGet(account, "/api/v2/order/get_order_detail", { order_sn_list: sns.join(","), response_optional_fields: "item_list,total_amount,ship_by_date,shipping_carrier,package_list,recipient_address,pickup_done_time" });
    return (Array.isArray(res.order_list) ? res.order_list : []).map(mapOrder).filter(Boolean);
  },

  /** @this {any} @param {{ accessToken: string, externalAccountId: string }} account @param {string} sn */
  async getOrder(account, sn) {
    return (await this.orderDetails(account, [sn]))[0] || null;
  },

  /**
   * Pedidos atualizados na janela (até 14 dias), 50 por página, com detalhes.
   * @this {any} @param {{ accessToken: string, externalAccountId: string }} account @param {{ updatedFrom: Date, cursor?: string | null }} options
   */
  async listOrders(account, { updatedFrom, cursor = null }) {
    const state = cursor ? JSON.parse(cursor) : null;
    const to = state?.to ?? this.now();
    const from = state?.from ?? Math.max(Math.floor(updatedFrom.getTime() / 1000), to - MAX_WINDOW_S);
    const page = await this.shopGet(account, "/api/v2/order/get_order_list", {
      time_range_field: "update_time", time_from: from, time_to: to, page_size: ORDER_PAGE, cursor: state?.c || "",
    });
    const sns = (Array.isArray(page.order_list) ? page.order_list : []).map((/** @type {any} */ o) => String(o.order_sn)).filter(Boolean);
    const orders = await this.orderDetails(account, sns);
    return { orders, nextCursor: page.more && page.next_cursor ? JSON.stringify({ c: page.next_cursor, from, to }) : null };
  },

  /**
   * Grava estoque por item: update_stock com seller_stock; failure_list aponta o modelo que falhou.
   * @this {any} @param {{ accessToken: string, externalAccountId: string }} account
   * @param {Array<{ ref: number, listingId: string, variationId: string, quantity: number }>} writes
   */
  async writeStock(account, writes) {
    /** @type {Map<string, typeof writes>} */
    const byItem = new Map();
    for (const w of writes) byItem.set(w.listingId, [...(byItem.get(w.listingId) || []), w]);
    /** @type {any[]} */
    const results = [];
    for (const [itemId, rows] of byItem) {
      try {
        const res = await this.shopPost(account, "/api/v2/product/update_stock", {
          item_id: Number(itemId),
          stock_list: rows.map((r) => ({ model_id: Number(r.variationId) || 0, seller_stock: [{ stock: Math.max(0, Math.floor(r.quantity)) }] })),
        });
        const failed = new Map((Array.isArray(res.failure_list) ? res.failure_list : []).map((/** @type {any} */ f) => [String(Number(f.model_id) || 0), String(f.failed_reason || "recusado pela Shopee")]));
        for (const r of rows) {
          const reason = failed.get(String(Number(r.variationId) || 0));
          results.push(reason ? { ref: r.ref, ok: false, retryable: false, error: reason } : { ref: r.ref, ok: true });
        }
      } catch (error) {
        const code = String(/** @type {any} */ (error)?.code || "");
        const outcome = RETRYABLE_CODES.has(code) ? { ok: false, retryable: true, uncertain: false, error: `Shopee ocupada (${code})` } : classifyWriteError(error);
        for (const r of rows) results.push({ ref: r.ref, ...outcome });
      }
    }
    return results;
  },

  /** @this {any} @param {{ accessToken: string, externalAccountId: string }} account @param {Array<{ ref: number, listingId: string, variationId: string }>} refs */
  async readStock(account, refs) {
    /** @type {Map<string, number | null>} */
    const stock = new Map();
    const withModel = [...new Set(refs.filter((r) => Number(r.variationId)).map((r) => r.listingId))];
    const plain = [...new Set(refs.filter((r) => !Number(r.variationId)).map((r) => r.listingId))];
    for (const itemId of withModel) {
      const res = await this.shopGet(account, "/api/v2/product/get_model_list", { item_id: itemId });
      for (const m of Array.isArray(res.model) ? res.model : []) stock.set(`${itemId}:${Number(m.model_id)}`, sellerStock(m));
    }
    for (let i = 0; i < plain.length; i += 50) {
      const res = await this.shopGet(account, "/api/v2/product/get_item_base_info", { item_id_list: plain.slice(i, i + 50).join(",") });
      for (const item of Array.isArray(res.item_list) ? res.item_list : []) stock.set(`${item.item_id}:0`, sellerStock(item));
    }
    return refs.map((r) => ({ ref: r.ref, stock: stock.get(`${r.listingId}:${Number(r.variationId) || 0}`) ?? null }));
  },
};

/** POST assinado de loja (mesma assinatura do GET). */
const shopeePost = {
  /** @this {any} @param {{ accessToken: string, externalAccountId: string }} account @param {string} path @param {any} body */
  async shopPost(account, path, body) {
    const timestamp = this.now();
    const sign = hmacSha256Hex(this.partnerKey, `${this.partnerId}${path}${timestamp}${account.accessToken}${account.externalAccountId}`);
    const params = new URLSearchParams({ partner_id: this.partnerId, timestamp: String(timestamp), access_token: account.accessToken, shop_id: String(account.externalAccountId), sign });
    const payload = await requestJson(`${this.apiBase}${path}?${params}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), fetchImpl: this.fetchImpl });
    // Erro de negócio respondido pela Shopee (HTTP 200 com "error"): resposta clara, não é incerta.
    if (payload?.error) throw Object.assign(new Error(payload.message || payload.error), { status: 422, code: payload.error, payload });
    return payload?.response || {};
  },
};

/** POST assinado que devolve arquivo (ex.: download_shipping_document). */
shopeePost.shopPostBinary = /** @this {any} @param {{ accessToken: string, externalAccountId: string }} account @param {string} path @param {any} body */
  async function shopPostBinary(account, path, body) {
    const timestamp = this.now();
    const sign = hmacSha256Hex(this.partnerKey, `${this.partnerId}${path}${timestamp}${account.accessToken}${account.externalAccountId}`);
    const params = new URLSearchParams({ partner_id: this.partnerId, timestamp: String(timestamp), access_token: account.accessToken, shop_id: String(account.externalAccountId), sign });
    return requestBinary(`${this.apiBase}${path}?${params}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), fetchImpl: this.fetchImpl });
  };

module.exports = { shopeeOrders, shopeePost, mapOrder, sellerStock };
