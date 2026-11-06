// @ts-check
"use strict";

/**
 * @typedef {{ mode: "same" | "fixed" | "percent", value?: number, cap?: number | null, minLock?: number, safetyReserve?: number }} StockRule
 */

/** @type {StockRule} */
const DEFAULT_RULE = { mode: "same", value: 0, cap: null, minLock: 0, safetyReserve: 0 };

/**
 * Disponível de um kit: o menor (disponível do componente / quantidade usada).
 * @param {Array<{ available: number, quantity: number }>} components
 */
function kitAvailable(components) {
  if (!components.length) return 0;
  let min = Infinity;
  for (const component of components) {
    if (!(component.quantity > 0)) return 0;
    min = Math.min(min, Math.floor(Math.max(0, component.available) / component.quantity));
  }
  return Number.isFinite(min) ? min : 0;
}

/**
 * Quanto enviar para um anúncio. Ordem: regra (igual/fixo/%) → reserva de
 * segurança → trava mínima → teto. Anúncio Full/Fulfillment nunca recebe escrita.
 * @param {{ available: number, rule?: Partial<StockRule> | null, fulfillment?: boolean }} input
 * @returns {number | null} null = não escrever neste anúncio
 */
function quantityForListing({ available, rule, fulfillment = false }) {
  if (fulfillment) return null;
  const r = { ...DEFAULT_RULE, ...(rule || {}) };
  const base = Math.max(0, Math.floor(Number(available) || 0));
  if (base <= Math.max(0, Number(r.minLock) || 0)) return 0;
  let qty;
  if (r.mode === "fixed") qty = Math.max(0, Math.floor(Number(r.value) || 0));
  else if (r.mode === "percent") qty = Math.floor(base * Math.min(100, Math.max(0, Number(r.value) || 0)) / 100);
  else qty = base;
  qty = Math.max(0, qty - Math.max(0, Math.floor(Number(r.safetyReserve) || 0)));
  if (r.cap != null && Number.isFinite(Number(r.cap))) qty = Math.min(qty, Math.max(0, Math.floor(Number(r.cap))));
  return qty;
}

/**
 * Regra efetiva: a do anúncio vence a da conta; sem nenhuma, "igual ao estoque".
 * @param {Partial<StockRule> | null | undefined} accountRule
 * @param {Partial<StockRule> | null | undefined} listingRule
 */
function effectiveRule(accountRule, listingRule) {
  return { ...DEFAULT_RULE, ...(accountRule || {}), ...(listingRule || {}) };
}

module.exports = { quantityForListing, kitAvailable, effectiveRule, DEFAULT_RULE };
