// @ts-check
"use strict";

const { requestJson } = require("../../platform/http");
const { hmacSha256Hex } = require("../../platform/crypto");
const { classifyWriteError, safeEqualHex, unauthorized, mergeLines } = require("../writeResult");
const { stockFrom } = require("./mapper");

const API_BASE = "https://api.magalu.com";
const CANCELLED = new Set(["cancelled", "canceled"]);
const ORDER_PAGE = 100;
/** A lista de pedidos do Magalu não filtra por atualização: relê os comprados nos últimos dias (pega cancelamentos recentes). */
const ORDER_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SKEW_SECONDS = 300;
/** Tópicos assinados por seller ao conectar a conta. */
const WEBHOOK_TOPICS = ["orders_order"];

/** Valor em centavos com normalizer → reais. @param {any} money */
function money(money) {
  const node = money && typeof money === "object" ? money : { value: money };
  const value = Number(node.value ?? node.total ?? node.amount);
  if (!Number.isFinite(value)) return null;
  const normalizer = Number(node.normalizer);
  return Number.isFinite(normalizer) && normalizer > 0 ? value / normalizer : value;
}

/** Situação do Magalu (pedido/entrega) → situação padronizada. */
const MAGALU_STAGES = /** @type {Record<string, import("../../modules/orders/repository").OrderStage>} */ ({
  new: "new", approved: "paid", frozen: "paid", invoiced: "invoiced", shipped: "shipped", delivered: "delivered", finished: "delivered",
  cancelled: "cancelled", canceled: "cancelled",
});

/**
 * Pedido do Magalu → formato comum. Os itens vêm por entrega (deliveries[].items); o código do anúncio no Hub é o SKU.
 * Prazo de envio, transportadora e rastreio vêm da primeira entrega (mesmos campos do DACH Magalu).
 * @param {any} order @returns {import("../../modules/orders/repository").ChannelOrder | null}
 */
function mapOrder(order) {
  const code = order?.code ?? order?.order?.code ?? order?.order_code ?? order?.id;
  if (code == null) return null;
  const status = String(order.status || "").toLowerCase();
  const deliveries = Array.isArray(order.deliveries) ? order.deliveries : [];
  const first = deliveries[0] || {};
  const deliveryStatus = String(first.status || "").toLowerCase();
  const sumMoney = (/** @type {(d: any) => any} */ pick) => {
    const values = deliveries.map((d) => money(pick(d))).filter((v) => v != null);
    return values.length ? Math.round(values.reduce((s, v) => s + Number(v), 0) * 100) / 100 : null;
  };
  const rawItems = deliveries.length ? deliveries.flatMap((/** @type {any} */ d) => (Array.isArray(d?.items) ? d.items : [])) : (Array.isArray(order.items) ? order.items : []);
  return {
    orderId: String(code),
    status: CANCELLED.has(status) ? "cancelled" : "open",
    stage: CANCELLED.has(status) ? "cancelled" : (MAGALU_STAGES[deliveryStatus] || MAGALU_STAGES[status] || "paid"),
    channelStatus: [status, deliveryStatus && deliveryStatus !== status ? deliveryStatus : ""].filter(Boolean).join(" / ") || null,
    fulfillment: deliveries.some((/** @type {any} */ d) => d?.shipping?.provider?.extras?.is_fulfillment === true),
    total: money(order.amounts?.total),
    shippingPaid: sumMoney((d) => d?.amounts?.freight?.total),
    discountTotal: sumMoney((d) => d?.amounts?.discount?.total),
    orderedAt: order.purchased_at || order.created_at || null,
    updatedAt: order.updated_at || null,
    shipBy: first.handling_time?.limit_date || first.shipping?.handling_time?.limit_date || null,
    shippedAt: first.posting_at || first.posting_date || first.shipping?.posting_date || null,
    carrier: first.shipping?.provider?.name || first.shipping?.provider?.description || null,
    trackingCode: first.shipping?.tracking?.code || null,
    shipmentId: first.id != null ? String(first.id) : null,
    channelRefs: { channelId: order.channel?.id != null ? String(order.channel.id) : null, deliveryIds: deliveries.map((/** @type {any} */ d) => d?.id).filter((/** @type {any} */ v) => v != null).map(String) },
    logisticType: first.shipping?.provider?.extras?.shipping_type || null,
    lines: mergeLines(rawItems.map((/** @type {any} */ item) => {
      const sku = String(item?.sku ?? item?.info?.sku ?? "").trim();
      return { lineKey: sku, listingId: sku, variationId: "", channelSku: sku || null, title: item?.name || item?.info?.name || null, quantity: Number(item?.quantity) || 0, unitPrice: money(item?.unit_price) };
    }).filter((/** @type {any} */ l) => l.listingId)),
  };
}

/** @param {any} payload */
function rowsOf(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.orders)) return payload.orders;
  return [];
}

/**
 * Pedidos, notificações e estoque do Magalu (padrões do DACH Magalu: write_operations e webhook assinado).
 */
const magaluOrders = {
  /**
   * Assina os avisos de pedido da conta (PUT /v1/onboarding/signup, com o token do seller).
   * Cada assinatura tem o próprio segredo (whsec_*), devolvido só nesta resposta; chamar de novo gera outro
   * (o anterior vale por mais 1 hora). @this {any} @param {{ accessToken: string }} account @param {{ url: string }} options
   * @returns {Promise<{ secrets: string[], topics: string[] }>}
   */
  async subscribeWebhooks(account, { url }) {
    /** @type {string[]} */
    const secrets = [];
    for (const topic of WEBHOOK_TOPICS) {
      const res = await requestJson(`${API_BASE}/v1/onboarding/signup`, {
        method: "PUT", fetchImpl: this.fetchImpl,
        headers: { authorization: `Bearer ${account.accessToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ topic_id: topic, webhook: url, filter_by: {} }),
      });
      const subs = Array.isArray(res?.subscriptions) ? res.subscriptions : [];
      const secret = subs.map((/** @type {any} */ s) => s?.parameters?.secret).find(Boolean);
      if (!secret) {
        const reason = subs.map((/** @type {any} */ s) => s?.message || s?.error || s?.reason).find(Boolean);
        throw Object.assign(new Error(`O Magalu não confirmou a assinatura de avisos (${topic})${reason ? `: ${reason}` : "."}`), { status: 502 });
      }
      secrets.push(String(secret));
    }
    return { secrets, topics: WEBHOOK_TOPICS };
  },

  /** Conta (tenant do Magalu) a que o aviso se refere, para buscar o segredo dela. @param {Buffer} rawBody */
  webhookAccountId(rawBody) {
    try { return String(JSON.parse(rawBody.toString("utf8"))?.tenant_id || "") || null; } catch (_error) { return null; }
  },

  /**
   * Webhook do Magalu: X-Signature-256 = HMAC-SHA256(segredo da conta, "<X-Timestamp>.<corpo bruto>"), com tolerância de 5 min.
   * Na troca de segredo o Magalu manda duas assinaturas separadas por vírgula; basta uma bater.
   * Conta sem segredo (desconhecida, desconectada ou sem assinatura): aviso ignorado; a leitura periódica cobre.
   * @this {any} @param {{ headers: Record<string, any>, rawBody: Buffer, secrets?: string[] }} input
   */
  parseWebhook({ headers, rawBody, secrets = [] }) {
    if (!secrets.length) return { events: [] };
    const timestamp = String(headers["x-timestamp"] || "");
    const signatures = String(headers["x-signature-256"] || "").split(",").map((s) => s.trim().replace(/^sha256=/i, "")).filter(Boolean);
    if (!/^\d+$/.test(timestamp) || !signatures.length) throw unauthorized("Assinatura ausente.");
    if (Math.abs(Math.floor(this.now() / 1000) - Number(timestamp)) > MAX_SKEW_SECONDS) throw unauthorized("Notificação expirada.");
    const signed = `${timestamp}.${rawBody.toString("utf8")}`;
    const valid = secrets.some((secret) => { const expected = hmacSha256Hex(secret, signed); return signatures.some((s) => safeEqualHex(expected, s)); });
    if (!valid) throw unauthorized("Assinatura inválida.");
    let body;
    try { body = JSON.parse(rawBody.toString("utf8")); } catch (_error) { throw unauthorized("Corpo inválido."); }
    if (String(body?.topic || "") !== "orders_order") return { events: [] };
    const id = String(body?.data?.params?.id || String(body?.data?.resource || "").split("/").filter(Boolean).pop() || "");
    if (!id || !body?.tenant_id) return { events: [] };
    return { events: [{ externalAccountId: String(body.tenant_id), topic: "order", resourceId: id, dedupeKey: `magalu:${hmacSha256Hex("dedupe", `${timestamp}.${rawBody.toString("utf8")}`)}`, payload: body }] };
  },

  /** @this {any} @param {{ accessToken: string }} account @param {string} code */
  async getOrder(account, code) {
    try {
      return mapOrder(await this.get(account.accessToken, `/seller/v1/orders/${encodeURIComponent(code)}`));
    } catch (error) {
      if (Number(/** @type {any} */ (error)?.status) === 404) return null;
      throw error;
    }
  },

  /**
   * Pedidos mais recentes primeiro, até passar da janela (comprados desde updatedFrom − 7 dias).
   * @this {any} @param {{ accessToken: string }} account @param {{ updatedFrom: Date, cursor?: string | null }} options
   */
  async listOrders(account, { updatedFrom, cursor = null }) {
    const offset = Number(cursor) || 0;
    const params = new URLSearchParams({ _offset: String(offset), _limit: String(ORDER_PAGE), _sort: "purchased_at:desc" });
    const rows = rowsOf(await this.get(account.accessToken, `/seller/v1/orders?${params}`));
    const limit = updatedFrom.getTime() - ORDER_LOOKBACK_MS;
    const orders = rows.map(mapOrder).filter(Boolean);
    const last = rows[rows.length - 1];
    const lastAt = Date.parse(last?.purchased_at || last?.created_at || "");
    const more = rows.length === ORDER_PAGE && Number.isFinite(lastAt) && lastAt >= limit;
    return { orders, nextCursor: more ? String(offset + ORDER_PAGE) : null };
  },

  /**
   * Grava estoque SKU a SKU: PATCH quando já existe, POST quando o Magalu ainda não tem estoque do SKU.
   * Cada envio leva X-Request-ID próprio (rastreio do lado do Magalu).
   * @this {any} @param {{ accessToken: string }} account @param {Array<{ ref: number, listingId: string, quantity: number }>} writes
   */
  async writeStock(account, writes) {
    /** @type {any[]} */
    const results = [];
    for (const w of writes) {
      const path = `/seller/v1/portfolios/stocks/${encodeURIComponent(w.listingId)}`;
      const headers = { authorization: `Bearer ${account.accessToken}`, "content-type": "application/json", "x-request-id": `dach-hub-push-${w.ref}` };
      try {
        let method = "PATCH";
        try { await this.get(account.accessToken, path); } catch (error) {
          if (Number(/** @type {any} */ (error)?.status) === 404) method = "POST"; else throw error;
        }
        await requestJson(`${API_BASE}${path}`, { method, headers, body: JSON.stringify({ quantity: Math.max(0, Math.floor(w.quantity)) }), fetchImpl: this.fetchImpl });
        results.push({ ref: w.ref, ok: true });
      } catch (error) {
        results.push({ ref: w.ref, ...classifyWriteError(error) });
      }
    }
    return results;
  },

  /** Relê o disponível (soma dos AVAILABLE). @this {any} @param {{ accessToken: string }} account @param {Array<{ ref: number, listingId: string }>} refs */
  async readStock(account, refs) {
    /** @type {any[]} */
    const out = [];
    for (const r of refs) {
      try { out.push({ ref: r.ref, stock: stockFrom(await this.get(account.accessToken, `/seller/v1/portfolios/stocks/${encodeURIComponent(r.listingId)}`)) }); }
      catch (_error) { out.push({ ref: r.ref, stock: null }); }
    }
    return out;
  },
};

module.exports = { magaluOrders, mapOrder };
