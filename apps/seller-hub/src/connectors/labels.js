// @ts-check
"use strict";

/**
 * Etiquetas de envio por canal (Fase 3 / P4). Cada conector devolve os arquivos do canal (PDF ou ZPL)
 * e o resultado por pedido. Mesmo contrato para os três:
 *   fetchLabels(account, refs, { format }) → { files: LabelFile[], results: LabelResult[] }
 * Lote recusado pelo canal é refeito pedido a pedido, para separar quem tem problema de quem não tem.
 *
 * Documentação conferida em 06/11/2026:
 * - ML: GET /shipment_labels?shipment_ids=…&response_type=pdf|zpl2 (até 50; envio ready_to_ship / ready_to_print).
 * - Magalu: POST /seller/v1/logistics/shipping-labels { channel, deliveries[], label: { format, type } } → label.signed_url.
 * - Shopee: get_tracking_number → create_shipping_document → get_shipping_document_result (READY) → download_shipping_document.
 */

const { requestBinary, requestJson, extensionFor } = require("../platform/http");

/**
 * @typedef {{ contentType: string, buffer: Buffer, extension: string, orders: number }} LabelFile
 * @typedef {{ ref: number, ok: boolean, error?: string, trackingCode?: string | null }} LabelResult
 * @typedef {{ ref: number, orderId: string, shipmentId?: string | null, trackingCode?: string | null, refs?: any }} LabelRef
 */

const ML_API = "https://api.mercadolibre.com";
const MAGALU_API = "https://api.magalu.com";
const BATCH = 50;

/** @template T @param {T[]} list @param {number} size */
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));
/** @param {unknown} error */
const msg = (error) => String(/** @type {any} */ (error)?.message || error || "erro").slice(0, 300);

/**
 * Tenta o lote; se o canal recusar, tenta um a um para isolar o problema.
 * @param {LabelRef[]} refs @param {(group: LabelRef[]) => Promise<{ file: LabelFile, tracking?: Map<number, string> }>} fetchGroup
 */
async function withFallback(refs, fetchGroup) {
  /** @type {LabelFile[]} */
  const files = [];
  /** @type {LabelResult[]} */
  const results = [];
  for (const group of chunks(refs, BATCH)) {
    try {
      const { file, tracking } = await fetchGroup(group);
      files.push(file);
      for (const r of group) results.push({ ref: r.ref, ok: true, trackingCode: tracking?.get(r.ref) || null });
    } catch (error) {
      if (group.length === 1) { results.push({ ref: group[0].ref, ok: false, error: msg(error) }); continue; }
      for (const one of group) {
        try {
          const { file, tracking } = await fetchGroup([one]);
          files.push(file);
          results.push({ ref: one.ref, ok: true, trackingCode: tracking?.get(one.ref) || null });
        } catch (err) { results.push({ ref: one.ref, ok: false, error: msg(err) }); }
      }
    }
  }
  return { files, results };
}

const mercadoLivreLabels = {
  /** @this {any} @param {{ accessToken: string }} account @param {LabelRef[]} refs @param {{ format: "pdf" | "zpl" }} options */
  async fetchLabels(account, refs, { format }) {
    const missing = refs.filter((r) => !r.shipmentId).map((r) => ({ ref: r.ref, ok: false, error: "Pedido sem envio do Mercado Envios (etiqueta é do vendedor)." }));
    const ready = refs.filter((r) => r.shipmentId);
    const out = await withFallback(ready, async (group) => {
      const url = `${ML_API}/shipment_labels?shipment_ids=${group.map((r) => encodeURIComponent(String(r.shipmentId))).join(",")}&response_type=${format === "zpl" ? "zpl2" : "pdf"}`;
      const { contentType, buffer } = await requestBinary(url, { headers: { authorization: `Bearer ${account.accessToken}` }, fetchImpl: this.fetchImpl });
      return { file: { contentType, buffer, extension: extensionFor(contentType, format === "zpl" ? "zip" : "pdf"), orders: group.length } };
    });
    return { files: out.files, results: [...missing, ...out.results] };
  },
};

const magaluLabels = {
  /**
   * Gera por canal de venda (o Magalu exige o id do canal) e baixa o arquivo pelo link temporário.
   * @this {any} @param {{ accessToken: string }} account @param {LabelRef[]} refs @param {{ format: "pdf" | "zpl" }} options
   */
  async fetchLabels(account, refs, { format }) {
    const missing = refs.filter((r) => !r.refs?.channelId || !(r.refs?.deliveryIds || []).length)
      .map((r) => ({ ref: r.ref, ok: false, error: "Pedido sem entrega do Magalu Entregas (leia o pedido de novo ou confira no painel do Magalu)." }));
    /** @type {Map<string, LabelRef[]>} */
    const byChannel = new Map();
    for (const r of refs) if (r.refs?.channelId && (r.refs?.deliveryIds || []).length) byChannel.set(String(r.refs.channelId), [...(byChannel.get(String(r.refs.channelId)) || []), r]);
    /** @type {LabelFile[]} */
    const files = [];
    /** @type {LabelResult[]} */
    const results = [...missing];
    for (const [channelId, list] of byChannel) {
      const out = await withFallback(list, async (group) => {
        const deliveries = group.flatMap((r) => r.refs.deliveryIds.map((/** @type {string} */ id) => ({ id: String(id) })));
        const res = await requestJson(`${MAGALU_API}/seller/v1/logistics/shipping-labels`, {
          method: "POST", fetchImpl: this.fetchImpl,
          headers: { authorization: `Bearer ${account.accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ channel: { id: channelId }, deliveries, label: { format: format === "zpl" ? "zpl" : "pdf", type: "full" } }),
        });
        const url = res?.label?.signed_url;
        if (!url) throw new Error("O Magalu não devolveu o link da etiqueta.");
        const { contentType, buffer } = await requestBinary(url, { fetchImpl: this.fetchImpl });
        /** @type {Map<number, string>} */
        const tracking = new Map();
        for (const d of Array.isArray(res.deliveries) ? res.deliveries : []) {
          const owner = group.find((r) => r.refs.deliveryIds.map(String).includes(String(d?.id)));
          // Pedido com várias entregas: guarda o rastreio da primeira (o pedido tem um campo de rastreio).
          if (owner && d?.tracking?.code && !tracking.has(owner.ref)) tracking.set(owner.ref, String(d.tracking.code));
        }
        return { file: { contentType, buffer, extension: extensionFor(contentType, format), orders: group.length }, tracking };
      });
      files.push(...out.files);
      results.push(...out.results);
    }
    return { files, results };
  },
};

const shopeeLabels = {
  /**
   * Fluxo da Shopee: rastreio (envio já programado) → criar documento → aguardar READY → baixar.
   * Sem ZPL na Shopee: "térmica" vira a etiqueta térmica em PDF (A6).
   * @this {any} @param {{ accessToken: string, externalAccountId: string }} account @param {LabelRef[]} refs @param {{ format: "pdf" | "zpl" }} options
   */
  async fetchLabels(account, refs, { format }) {
    const type = format === "zpl" ? "THERMAL_AIR_WAYBILL" : "NORMAL_AIR_WAYBILL";
    const sleep = this.sleep || ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
    /** @type {LabelResult[]} */
    const failures = [];
    /** @type {Array<LabelRef & { pkg: string | null, tracking: string }>} */
    const ready = [];
    for (const r of refs) {
      const pkg = (r.refs?.packageNumbers || [])[0] || null;
      let tracking = r.trackingCode || "";
      if (!tracking) {
        try {
          const res = await this.shopGet(account, "/api/v2/logistics/get_tracking_number", { order_sn: r.orderId, ...(pkg ? { package_number: pkg } : {}) });
          tracking = String(res.tracking_number || "");
        } catch (error) { failures.push({ ref: r.ref, ok: false, error: msg(error) }); continue; }
      }
      if (!tracking) { failures.push({ ref: r.ref, ok: false, error: "Envio ainda não programado na Shopee: programe a coleta ou postagem antes de imprimir." }); continue; }
      ready.push({ ...r, pkg, tracking });
    }
    const out = await withFallback(ready, async (group) => {
      const orderList = group.map((r) => ({ order_sn: r.orderId, ...(/** @type {any} */ (r).pkg ? { package_number: /** @type {any} */ (r).pkg } : {}) }));
      const created = await this.shopPost(account, "/api/v2/logistics/create_shipping_document", {
        order_list: group.map((r) => ({ ...orderList.find((o) => o.order_sn === r.orderId), tracking_number: /** @type {any} */ (r).tracking, shipping_document_type: type })),
      });
      const failed = (Array.isArray(created.result_list) ? created.result_list : []).filter((/** @type {any} */ x) => x.fail_error);
      if (failed.length) throw new Error(failed.map((/** @type {any} */ f) => `${f.order_sn}: ${f.fail_message || f.fail_error}`).join("; "));
      let status = "PROCESSING";
      for (let attempt = 0; attempt < 10 && status === "PROCESSING"; attempt += 1) {
        await sleep(attempt ? 1500 : 500);
        const result = await this.shopPost(account, "/api/v2/logistics/get_shipping_document_result", { order_list: orderList.map((o) => ({ ...o, shipping_document_type: type })) });
        const statuses = (Array.isArray(result.result_list) ? result.result_list : []).map((/** @type {any} */ x) => String(x.status || ""));
        status = statuses.includes("FAILED") ? "FAILED" : statuses.length && statuses.every((s) => s === "READY") ? "READY" : "PROCESSING";
      }
      if (status !== "READY") throw new Error(status === "FAILED" ? "A Shopee não conseguiu gerar a etiqueta." : "A Shopee demorou para gerar a etiqueta; tente de novo.");
      const { contentType, buffer } = await this.shopPostBinary(account, "/api/v2/logistics/download_shipping_document", { shipping_document_type: type, order_list: orderList });
      return { file: { contentType, buffer, extension: extensionFor(contentType, "pdf"), orders: group.length }, tracking: new Map(group.map((r) => [r.ref, /** @type {any} */ (r).tracking])) };
    });
    return { files: out.files, results: [...failures, ...out.results] };
  },
};

module.exports = { mercadoLivreLabels, magaluLabels, shopeeLabels, withFallback };
