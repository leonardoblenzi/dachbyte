// @ts-check
"use strict";

const { kitAvailable, quantityForListing, effectiveRule } = require("./rules");

/**
 * @typedef {{ id: number, kind: "simple" | "kit" }} ItemRef
 * @typedef {{ itemId: number, onHand: number, reserved: number }} BalanceRow
 * @typedef {{ kitItemId: number, componentItemId: number, quantity: number }} KitComponentRow
 * @typedef {{ available: number, onHand: number, reserved: number, hasStock: boolean }} Availability
 */

/**
 * Disponível de cada item: físico − reservado, somando os locais.
 * Kit não tem estoque próprio: vale o menor componente. "hasStock" = estoque já informado
 * (para o kit, todos os componentes informados); sem isso o Hub não planeja nada para o item.
 * @param {{ items: ItemRef[], balances: BalanceRow[], components: KitComponentRow[] }} input
 * @returns {Map<number, Availability>}
 */
function computeAvailability({ items, balances, components }) {
  /** @type {Map<number, Availability>} */
  const simple = new Map();
  for (const b of balances) {
    const id = Number(b.itemId);
    const cur = simple.get(id) || { available: 0, onHand: 0, reserved: 0, hasStock: true };
    cur.onHand += Number(b.onHand) || 0;
    cur.reserved += Number(b.reserved) || 0;
    cur.available = cur.onHand - cur.reserved;
    simple.set(id, cur);
  }
  /** @type {Map<number, KitComponentRow[]>} */
  const byKit = new Map();
  for (const c of components) {
    const list = byKit.get(Number(c.kitItemId)) || [];
    list.push(c);
    byKit.set(Number(c.kitItemId), list);
  }
  /** @type {Map<number, Availability>} */
  const out = new Map();
  for (const item of items) {
    const id = Number(item.id);
    if (item.kind !== "kit") {
      out.set(id, simple.get(id) || { available: 0, onHand: 0, reserved: 0, hasStock: false });
      continue;
    }
    const parts = byKit.get(id) || [];
    const hasStock = parts.length > 0 && parts.every((p) => simple.has(Number(p.componentItemId)));
    const available = kitAvailable(parts.map((p) => ({ available: simple.get(Number(p.componentItemId))?.available ?? 0, quantity: Number(p.quantity) })));
    out.set(id, { available, onHand: available, reserved: 0, hasStock });
  }
  return out;
}

/**
 * @typedef {{
 *   id: number, accountId: number, channel: string, accountLabel: string | null, accountMode: "off" | "observe" | "active",
 *   listingId: string, variationId: string, title: string | null, fulfillment: boolean, channelStock: number | null,
 *   syncEnabled: boolean, itemId: number, sku: string, itemName: string | null,
 *   accountRule: import("./rules").StockRule | null, listingRule: import("./rules").StockRule | null,
 * }} PlanListing
 *
 * Situação do anúncio no plano:
 * - increase / decrease / same: o Hub enviaria `desired` (ou já está igual);
 * - fulfillment: estoque do canal (Full), só leitura;
 * - sync_off: sincronização desligada no anúncio;
 * - account_off: conta com estoque desligado;
 * - no_stock: produto ainda sem estoque informado (o Hub não zera anúncio por falta de dado).
 * @typedef {"increase" | "decrease" | "same" | "fulfillment" | "sync_off" | "account_off" | "no_stock"} PlanState
 */

/**
 * "O que mudaria": para cada anúncio vinculado, quanto o Hub enviaria e a diferença para o canal.
 * Função pura; não escreve em lugar nenhum.
 * @param {{ listings: PlanListing[], availability: Map<number, Availability> }} input
 */
function planListings({ listings, availability }) {
  const summary = { total: 0, increase: 0, decrease: 0, same: 0, zeroed: 0, skipped: 0 };
  const rows = listings.map((l) => {
    const stock = availability.get(Number(l.itemId)) || { available: 0, onHand: 0, reserved: 0, hasStock: false };
    const rule = effectiveRule(l.accountRule, l.listingRule);
    const channelStock = l.channelStock == null ? null : Number(l.channelStock);
    /** @type {PlanState} */
    let state;
    /** @type {number | null} */
    let desired = null;
    if (l.fulfillment) state = "fulfillment";
    else if (l.accountMode === "off") state = "account_off";
    else if (!l.syncEnabled) state = "sync_off";
    else if (!stock.hasStock) state = "no_stock";
    else {
      desired = quantityForListing({ available: stock.available, rule, fulfillment: false });
      const current = channelStock ?? 0;
      state = desired == null || desired === current ? "same" : desired > current ? "increase" : "decrease";
    }
    summary.total += 1;
    if (state === "increase" || state === "decrease" || state === "same") summary[state] += 1;
    else summary.skipped += 1;
    if (desired === 0 && (channelStock ?? 0) > 0) summary.zeroed += 1;
    return {
      ...l,
      available: stock.hasStock ? stock.available : null,
      rule,
      ruleSource: l.listingRule ? "listing" : l.accountRule ? "account" : "default",
      desired,
      diff: desired == null ? null : desired - (channelStock ?? 0),
      state,
    };
  });
  return { rows, summary };
}

module.exports = { computeAvailability, planListings };
