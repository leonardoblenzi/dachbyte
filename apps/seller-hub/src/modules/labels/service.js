// @ts-check
"use strict";

const MAX_ORDERS = 200;
const CHANNEL_SLUG = /** @type {Record<string, string>} */ ({ mercadolivre: "ml", magalu: "magalu", shopee: "shopee" });

/** @param {string} message @param {number} status @param {string} code */
function fail(message, status, code) { return Object.assign(new Error(message), { status, code }); }
/** @param {unknown} error */
const msg = (error) => String(/** @type {any} */ (error)?.message || error || "erro").slice(0, 300);

/**
 * Etiquetas de envio em lote (Fase 3 / P4). Agrupa por conta, pede ao canal, guarda um arquivo por conta
 * (o canal devolve o próprio PDF/ZPL), grava o rastreio e registra na linha do tempo.
 * Pedido Full, cancelado ou já enviado não pede etiqueta.
 * @param {{
 *   repository: ReturnType<typeof import("./repository").createLabelsRepository>,
 *   connectors: ReturnType<typeof import("../../connectors/registry").createConnectors>,
 *   tokens: { getAccessToken: (accountId: number) => Promise<{ accessToken: string, externalAccountId: string }> },
 * }} deps
 */
function createLabelsService({ repository, connectors, tokens }) {
  return {
    /** @param {{ identity: { tenantId: string, userId?: string | null }, orderIds: number[], format?: string }} input */
    async print({ identity, orderIds, format = "pdf" }) {
      const fmt = format === "zpl" ? "zpl" : "pdf";
      const ids = [...new Set((orderIds || []).map(Number).filter(Boolean))];
      if (!ids.length || ids.length > MAX_ORDERS) throw fail(`Escolha de 1 a ${MAX_ORDERS} pedidos.`, 400, "invalid_selection");
      const rows = await repository.refsForOrders(identity.tenantId, ids);
      /** @type {Array<{ id: number, orderId: string, error: string }>} */
      const failures = [];
      for (const id of ids) if (!rows.some((/** @type {any} */ r) => Number(r.id) === id)) failures.push({ id, orderId: String(id), error: "Pedido não encontrado ou conta desconectada." });
      /** @type {Map<number, any[]>} */
      const byAccount = new Map();
      for (const r of rows) {
        const reason = r.fulfillment ? "Pedido Full: a etiqueta é do marketplace." : r.status !== "open" ? "Pedido cancelado." : ["shipped", "delivered", "returned"].includes(r.stage) ? "Pedido já enviado." : null;
        if (reason) { failures.push({ id: Number(r.id), orderId: r.orderId, error: reason }); continue; }
        byAccount.set(Number(r.accountId), [...(byAccount.get(Number(r.accountId)) || []), r]);
      }
      const batch = await repository.createBatch({ tenantId: identity.tenantId, format: fmt, orders: ids.length, userId: identity.userId || null });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      /** @type {Array<{ id: number, trackingCode?: string | null }>} */
      const printed = [];
      for (const [accountId, list] of byAccount) {
        const channel = list[0].channel;
        try {
          if (!connectors.has(channel) || !connectors.definition(channel).capabilities.labels) throw new Error("Este canal não gera etiqueta pelo Hub.");
          const { accessToken, externalAccountId } = await tokens.getAccessToken(accountId);
          const { files, results } = await connectors.get(channel).fetchLabels({ id: accountId, accessToken, externalAccountId },
            list.map((r) => ({ ref: Number(r.id), orderId: r.orderId, shipmentId: r.shipmentId, trackingCode: r.trackingCode, refs: r.refs || {} })), { format: fmt });
          let part = 0;
          for (const f of files) {
            part += 1;
            await repository.addFile({
              batchId: Number(batch.id), tenantId: identity.tenantId, accountId, channel, contentType: f.contentType, content: f.buffer, orders: f.orders,
              filename: `etiquetas-${CHANNEL_SLUG[channel] || channel}-${accountId}-${stamp}${files.length > 1 ? `-${part}` : ""}.${f.extension}`,
            });
          }
          for (const res of results) {
            const row = list.find((r) => Number(r.id) === Number(res.ref));
            if (res.ok) printed.push({ id: Number(res.ref), trackingCode: res.trackingCode || null });
            else failures.push({ id: Number(res.ref), orderId: row?.orderId || String(res.ref), error: res.error || "erro" });
          }
        } catch (error) {
          for (const r of list) failures.push({ id: Number(r.id), orderId: r.orderId, error: msg(error) });
        }
      }
      await repository.markPrinted(printed, `Etiqueta ${fmt === "zpl" ? "térmica" : "PDF"} gerada (lote de etiquetas #${batch.id}, ${identity.userId || "?"}).`);
      await repository.setFailures(Number(batch.id), failures);
      return repository.getBatch(identity.tenantId, Number(batch.id));
    },

    listBatches: (/** @type {string} */ tenantId) => repository.listBatches(tenantId),

    /** @param {string} tenantId @param {number} fileId */
    async file(tenantId, fileId) {
      const f = await repository.getFile(tenantId, fileId);
      if (!f) throw fail("Arquivo de etiqueta não encontrado (ficam guardados por 7 dias).", 404, "label_not_found");
      return f;
    },

    cleanup: () => repository.cleanup(),
  };
}

module.exports = { createLabelsService, MAX_ORDERS };
