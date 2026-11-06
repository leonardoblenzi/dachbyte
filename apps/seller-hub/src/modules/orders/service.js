// @ts-check
"use strict";

/** Leitura periódica: começa um pouco antes da última leitura (pedidos atualizados no meio do caminho). */
const POLL_OVERLAP_MS = 30 * 60 * 1000;
const FIRST_POLL_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_POLL_PAGES = 50;

/** @param {unknown} error */
const errorText = (error) => String(/** @type {any} */ (error)?.message || error || "Erro desconhecido.").slice(0, 500);

/**
 * Pedidos: baixa na venda, devolução no cancelamento, venda sem vínculo pendente até vincular.
 * Venda de anúncio Full não mexe no estoque central (o estoque está no canal).
 * Devolução física (produto voltou) continua sendo ajuste manual: pode voltar avariado.
 * @param {{
 *   repository: ReturnType<typeof import("./repository").createOrdersRepository>,
 *   stockRepository: { applyEntries: ReturnType<typeof import("../stock/repository").createStockRepository>["applyEntries"] },
 *   connectors?: ReturnType<typeof import("../../connectors/registry").createConnectors>,
 *   tokens?: { getAccessToken: (accountId: number) => Promise<{ accessToken: string, externalAccountId: string }> },
 *   onItemsChanged?: (tenantId: string, itemIds: number[], reason: string) => Promise<unknown>,
 *   now?: () => Date,
 * }} deps
 */
function createOrdersService({ repository, stockRepository, connectors, tokens, onItemsChanged = async () => {}, now = () => new Date() }) {
  /**
   * Aplica a baixa/devolução que falta no pedido. Idempotente: cada movimento tem chave por item do pedido.
   * @param {string} tenantId @param {number} accountId
   * @param {{ orderId: string, status: "open" | "cancelled", fulfillment?: boolean, lines: any[] }} order
   */
  async function applyOrder(tenantId, accountId, order) {
    const itemIds = [...new Set(order.lines.map((l) => Number(l.itemId)).filter(Boolean))];
    const items = new Map((itemIds.length ? await repository.itemsWithComponents(tenantId, itemIds) : []).map((/** @type {any} */ i) => [Number(i.id), i]));
    /** Venda de kit baixa os componentes. @param {number} itemId @param {number} qty */
    const expand = (itemId, qty) => {
      const item = items.get(itemId);
      if (!item) return [];
      if (item.kind !== "kit") return [{ itemId, quantity: qty }];
      return (item.components || []).map((/** @type {any} */ c) => ({ itemId: Number(c.itemId), quantity: qty * Number(c.quantity) }));
    };
    /** @type {import("../stock/repository").StockEntry[]} */
    const entries = [];
    const sold = [], returned = [], pending = [], clearPending = [];
    for (const line of order.lines) {
      const full = Boolean(order.fulfillment || line.listingFulfillment);
      if (order.status === "open") {
        if (line.saleApplied || full) continue;
        const parts = line.itemId ? expand(Number(line.itemId), Number(line.quantity)) : [];
        if (!parts.length) { if (!line.pendingLink) pending.push(Number(line.id)); continue; }
        for (const p of parts) {
          entries.push({ itemId: p.itemId, op: "add", quantity: -p.quantity, kind: "sale", sourceType: "order", sourceId: String(order.orderId),
            idempotencyKey: `sale:${line.id}:${p.itemId}`, channelAccountId: accountId });
        }
        sold.push(Number(line.id));
      } else {
        if (line.pendingLink) clearPending.push(Number(line.id));
        if (!line.saleApplied || line.cancelApplied) continue;
        for (const p of expand(Number(line.itemId), Number(line.quantity))) {
          entries.push({ itemId: p.itemId, op: "add", quantity: p.quantity, kind: "cancellation", sourceType: "order", sourceId: String(order.orderId),
            idempotencyKey: `cancel:${line.id}:${p.itemId}`, channelAccountId: accountId });
        }
        returned.push(Number(line.id));
      }
    }
    // Venda pode deixar o estoque negativo (vendeu o que não tinha): o número fica visível para correção.
    if (entries.length) await stockRepository.applyEntries(tenantId, entries, { allowNegative: true });
    await repository.markLines(sold, { saleApplied: true, pendingLink: false });
    await repository.markLines(returned, { cancelApplied: true });
    await repository.markLines(pending, { pendingLink: true });
    await repository.markLines(clearPending, { pendingLink: false });
    const affected = [...new Set(entries.map((e) => Number(e.itemId)))];
    if (affected.length) await onItemsChanged(tenantId, affected, `pedido ${order.orderId}`);
    return { movements: entries.length, sold: sold.length, returned: returned.length, pending: pending.length };
  }

  /** @param {{ id: number, tenantId: string }} account @param {import("./repository").ChannelOrder} order */
  async function ingest(account, order) {
    const saved = await repository.upsertOrder(Number(account.id), order);
    return applyOrder(account.tenantId, Number(account.id), { orderId: order.orderId, status: order.status, fulfillment: order.fulfillment, lines: saved.lines });
  }

  /** @param {string} channel */
  function connectorFor(channel) {
    if (!connectors || !tokens) throw new Error("Conectores indisponíveis neste processo.");
    return connectors.get(channel);
  }

  return {
    ingest,
    applyOrder,

    /** Ao vincular um anúncio, aplica as vendas que estavam esperando por ele. @param {string} tenantId @param {number} listingDbId */
    async applyPendingForListing(tenantId, listingDbId) {
      const orderIds = await repository.claimPendingForListing(tenantId, listingDbId);
      let movements = 0;
      for (const id of orderIds) {
        const order = await repository.getOrderWithLines(id);
        if (order) movements += (await applyOrder(order.tenantId, Number(order.accountId), order)).movements;
      }
      return { orders: orderIds.length, movements };
    },

    /**
     * Recebe a notificação do canal: valida (assinatura/origem), guarda e devolve os ids para processar.
     * @param {{ channel: string, headers: Record<string, any>, rawBody: Buffer, url: string }} input
     */
    async receiveWebhook({ channel, headers, rawBody, url }) {
      const connector = connectorFor(channel);
      const { events } = connector.parseWebhook({ headers, rawBody, url });
      /** @type {number[]} */
      const ids = [];
      for (const event of events) {
        const saved = await repository.insertWebhook({ channel, ...event });
        if (saved) ids.push(Number(saved.id));
      }
      return { received: events.length, ids };
    },

    /** Processa uma notificação guardada: busca o pedido atualizado no canal e aplica. @param {number} eventId */
    async processWebhook(eventId) {
      const event = await repository.getWebhook(eventId);
      if (!event || event.status === "processed" || event.status === "ignored") return { skipped: true };
      try {
        const account = event.externalAccountId ? await repository.findAccountByExternal(event.channel, event.externalAccountId) : null;
        if (!account || event.topic !== "order") { await repository.markWebhook(eventId, "ignored", account ? "tópico sem processamento" : "conta não conectada ao Hub"); return { ignored: true }; }
        const connector = connectorFor(event.channel);
        const { accessToken, externalAccountId } = await /** @type {any} */ (tokens).getAccessToken(Number(account.id));
        const order = await connector.getOrder({ id: Number(account.id), accessToken, externalAccountId }, event.resourceId);
        if (!order) { await repository.markWebhook(eventId, "ignored", "pedido não encontrado no canal"); return { ignored: true }; }
        const result = await ingest(account, order);
        await repository.markWebhook(eventId, "processed");
        return result;
      } catch (error) {
        await repository.markWebhook(eventId, "failed", errorText(error));
        throw error;
      }
    },

    /**
     * Leitura de segurança dos pedidos atualizados desde a última vez (pega o que o webhook perdeu).
     * @param {number} accountId
     */
    async pollAccount(accountId) {
      const account = await repository.getAccount(accountId);
      if (!account || account.status !== "connected") return { skipped: true };
      const connector = connectorFor(account.channel);
      const startedAt = now();
      const last = account.ordersSyncedAt ? new Date(account.ordersSyncedAt).getTime() : startedAt.getTime() - FIRST_POLL_LOOKBACK_MS;
      const updatedFrom = new Date(last - POLL_OVERLAP_MS);
      /** @type {string | null} */
      let cursor = null;
      let pages = 0, orders = 0;
      do {
        const { accessToken, externalAccountId } = await /** @type {any} */ (tokens).getAccessToken(accountId);
        const page = await connector.listOrders({ id: accountId, accessToken, externalAccountId }, { updatedFrom, cursor });
        for (const order of page.orders) { await ingest(account, order); orders += 1; }
        cursor = page.nextCursor || null;
        pages += 1;
      } while (cursor && pages < MAX_POLL_PAGES);
      if (!cursor) await repository.setOrdersSyncedAt(accountId, startedAt);
      return { pages, orders, complete: !cursor };
    },

    /** @param {string} tenantId @param {{ pendingOnly?: boolean, limit?: number, offset?: number }} [options] */
    listOrders: (tenantId, options) => repository.listOrders(tenantId, options),
  };
}

module.exports = { createOrdersService, POLL_OVERLAP_MS };
