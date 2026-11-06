// @ts-check
"use strict";

const { requestJson } = require("../../platform/http");
const { classifyWriteError, unauthorized, mergeLines } = require("../writeResult");

const API = "https://api.mercadolibre.com";
/** Status do ML que desfazem a venda. Os demais (confirmed, payment_required, paid...) contam como venda. */
const CANCELLED = new Set(["cancelled", "canceled", "invalid"]);
const ORDER_PAGE = 50;
/** O ML não deixa paginar a busca de pedidos além de 10 mil. */
const MAX_OFFSET = 10_000;

/**
 * Pedido do ML → formato comum. Venda Full pelo logistic_type quando vier no pedido
 * (o Hub também considera Full pelo cadastro do anúncio).
 * @param {any} order @returns {import("../../modules/orders/repository").ChannelOrder | null}
 */
function mapOrder(order) {
  if (!order || order.id == null) return null;
  const status = String(order.status || "").toLowerCase();
  const logistic = String(order.shipping?.logistic_type || order.logistic_type || "").toLowerCase();
  return {
    orderId: String(order.id),
    status: CANCELLED.has(status) ? "cancelled" : "open",
    channelStatus: status || null,
    fulfillment: logistic === "fulfillment",
    total: order.total_amount == null ? null : Number(order.total_amount),
    orderedAt: order.date_created || null,
    updatedAt: order.date_last_updated || null,
    lines: mergeLines((Array.isArray(order.order_items) ? order.order_items : []).map((/** @type {any} */ row) => {
      const item = row?.item || {};
      const variation = item.variation_id == null ? "" : String(item.variation_id);
      return {
        lineKey: `${item.id}:${variation}`,
        listingId: String(item.id || ""),
        variationId: variation,
        channelSku: item.seller_sku || item.seller_custom_field || null,
        title: item.title || null,
        quantity: Number(row?.quantity) || 0,
        unitPrice: row?.unit_price == null ? null : Number(row.unit_price),
      };
    }).filter((l) => l.listingId)),
  };
}

/**
 * Métodos de pedidos, notificações e estoque do conector do ML (misturados na classe pelo conector).
 * Padrões copiados do DACH ML (EstoqueAtualizacaoService): PUT /items/{id} só com as variações que mudam,
 * bloqueio de conta multi-origem e de anúncio Full, conferência relendo o anúncio.
 */
const mercadoLivreOrders = {
  /**
   * Notificação do ML: sem assinatura, então confere o application_id (nosso app), o usuário e o recurso.
   * @this {any} @param {{ rawBody: Buffer }} input
   */
  parseWebhook({ rawBody }) {
    let body;
    try { body = JSON.parse(rawBody.toString("utf8")); } catch (_error) { throw unauthorized("Corpo inválido."); }
    if (body?.application_id != null && String(body.application_id) !== String(this.clientId)) throw unauthorized("Notificação de outro aplicativo.");
    if (!/^\d+$/.test(String(body?.user_id || ""))) throw unauthorized("Usuário inválido.");
    const topic = String(body?.topic || "").toLowerCase();
    const match = /^\/orders\/(\d+)$/.exec(String(body?.resource || ""));
    if (!["orders_v2", "orders"].includes(topic) || !match) return { events: [] };
    return {
      events: [{
        externalAccountId: String(body.user_id), topic: "order", resourceId: match[1],
        dedupeKey: `mercadolivre:${body._id || `${match[1]}:${body.sent || ""}`}`, payload: body,
      }],
    };
  },

  /** @this {any} @param {{ accessToken: string }} account @param {string} orderId */
  async getOrder(account, orderId) {
    try {
      return mapOrder(await requestJson(`${API}/orders/${encodeURIComponent(orderId)}`, { headers: { authorization: `Bearer ${account.accessToken}` }, fetchImpl: this.fetchImpl }));
    } catch (error) {
      if (Number(/** @type {any} */ (error)?.status) === 404) return null;
      throw error;
    }
  },

  /**
   * Pedidos atualizados desde `updatedFrom` (mais antigos primeiro), 50 por página.
   * @this {any} @param {{ accessToken: string, externalAccountId: string }} account @param {{ updatedFrom: Date, cursor?: string | null }} options
   */
  async listOrders(account, { updatedFrom, cursor = null }) {
    const offset = Number(cursor) || 0;
    const url = new URL(`${API}/orders/search`);
    url.searchParams.set("seller", account.externalAccountId);
    url.searchParams.set("order.date_last_updated.from", updatedFrom.toISOString());
    url.searchParams.set("sort", "date_asc");
    url.searchParams.set("limit", String(ORDER_PAGE));
    url.searchParams.set("offset", String(offset));
    const page = await requestJson(url.toString(), { headers: { authorization: `Bearer ${account.accessToken}` }, fetchImpl: this.fetchImpl });
    const results = Array.isArray(page?.results) ? page.results : [];
    const next = offset + ORDER_PAGE;
    const total = Number(page?.paging?.total) || 0;
    return { orders: results.map(mapOrder).filter(Boolean), nextCursor: results.length && next < total && next < MAX_OFFSET ? String(next) : null };
  },

  /**
   * Grava estoque. Uma chamada por anúncio, com as variações que mudam.
   * @this {any} @param {{ accessToken: string, externalAccountId: string }} account
   * @param {Array<{ ref: number, listingId: string, variationId: string, quantity: number }>} writes
   */
  async writeStock(account, writes) {
    const headers = { authorization: `Bearer ${account.accessToken}` };
    /** @type {any[]} */
    const results = [];
    const user = await requestJson(`${API}/users/${encodeURIComponent(account.externalAccountId)}`, { headers, fetchImpl: this.fetchImpl });
    if ((Array.isArray(user?.tags) ? user.tags : []).includes("warehouse_management")) {
      return writes.map((w) => ({ ref: w.ref, ok: false, retryable: false, error: "conta com estoque em vários depósitos (multi-origem): escrita bloqueada" }));
    }
    /** @type {Map<string, typeof writes>} */
    const byItem = new Map();
    for (const w of writes) byItem.set(w.listingId, [...(byItem.get(w.listingId) || []), w]);
    for (const [itemId, rows] of byItem) {
      try {
        const item = await requestJson(`${API}/items/${encodeURIComponent(itemId)}?attributes=id,status,seller_id,shipping,variations`, { headers, fetchImpl: this.fetchImpl });
        const blocked = String(item?.shipping?.logistic_type || "") === "fulfillment" ? "anúncio Full: estoque do canal"
          : String(item?.seller_id || account.externalAccountId) !== String(account.externalAccountId) ? "anúncio de outro vendedor"
            : !["active", "paused"].includes(String(item?.status || "")) ? `anúncio ${item?.status || "indisponível"}` : null;
        if (blocked) { for (const r of rows) results.push({ ref: r.ref, ok: false, retryable: false, error: blocked }); continue; }
        const withVariation = rows.filter((r) => r.variationId);
        const body = withVariation.length
          ? { variations: withVariation.map((r) => ({ id: Number.isSafeInteger(Number(r.variationId)) ? Number(r.variationId) : r.variationId, available_quantity: r.quantity })) }
          : { available_quantity: rows[rows.length - 1].quantity };
        await requestJson(`${API}/items/${encodeURIComponent(itemId)}`, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), fetchImpl: this.fetchImpl });
        for (const r of rows) results.push({ ref: r.ref, ok: true });
      } catch (error) {
        const outcome = classifyWriteError(error);
        for (const r of rows) results.push({ ref: r.ref, ...outcome });
      }
    }
    return results;
  },

  /**
   * Relê o estoque (multiget de até 20 anúncios).
   * @this {any} @param {{ accessToken: string }} account @param {Array<{ ref: number, listingId: string, variationId: string }>} refs
   */
  async readStock(account, refs) {
    const ids = [...new Set(refs.map((r) => r.listingId))];
    /** @type {Map<string, any>} */
    const items = new Map();
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      const rows = await requestJson(`${API}/items?ids=${batch.map(encodeURIComponent).join(",")}&attributes=id,available_quantity,variations`, { headers: { authorization: `Bearer ${account.accessToken}` }, fetchImpl: this.fetchImpl });
      for (const row of Array.isArray(rows) ? rows : []) if (row?.body?.id) items.set(String(row.body.id), row.body);
    }
    return refs.map((r) => {
      const item = items.get(r.listingId);
      if (!item) return { ref: r.ref, stock: null };
      if (!r.variationId) return { ref: r.ref, stock: item.available_quantity == null ? null : Number(item.available_quantity) };
      const variation = (Array.isArray(item.variations) ? item.variations : []).find((/** @type {any} */ v) => String(v.id) === String(r.variationId));
      return { ref: r.ref, stock: variation?.available_quantity == null ? null : Number(variation.available_quantity) };
    });
  },
};

module.exports = { mercadoLivreOrders, mapOrder, CANCELLED };
