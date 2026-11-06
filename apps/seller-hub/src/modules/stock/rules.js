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

const RULE_MODES = Object.freeze(["same", "fixed", "percent"]);

/**
 * Valida a regra vinda da tela. Devolve a regra limpa ou a mensagem do primeiro problema.
 * @param {any} input @returns {{ rule: StockRule, error: null } | { rule: null, error: string }}
 */
function normalizeRule(input) {
  const mode = String(input?.mode || "same");
  if (!RULE_MODES.includes(mode)) return { rule: null, error: "Modo de regra inválido." };
  /** @param {unknown} v */
  const num = (v) => (v === "" || v == null ? null : Number(v));
  const value = num(input?.value) ?? 0, cap = num(input?.cap), minLock = num(input?.minLock) ?? 0, safetyReserve = num(input?.safetyReserve) ?? 0;
  for (const [label, v] of /** @type {Array<[string, number | null]>} */ ([["valor", value], ["teto", cap], ["trava mínima", minLock], ["reserva", safetyReserve]])) {
    if (v != null && (!Number.isFinite(v) || v < 0)) return { rule: null, error: `O campo ${label} precisa ser um número maior ou igual a zero.` };
  }
  if (mode === "percent" && value > 100) return { rule: null, error: "O percentual vai de 0 a 100." };
  return { rule: { mode: /** @type {StockRule["mode"]} */ (mode), value: mode === "same" ? 0 : value, cap, minLock, safetyReserve }, error: null };
}

/** Linha do banco (hub.stock_rules) → regra. @param {any} row @returns {StockRule | null} */
function ruleFromRow(row) {
  if (!row) return null;
  /** @param {unknown} v */
  const n = (v) => (v == null ? null : Number(v));
  return { mode: row.mode, value: n(row.value) ?? 0, cap: n(row.cap), minLock: n(row.min_lock ?? row.minLock) ?? 0, safetyReserve: n(row.safety_reserve ?? row.safetyReserve) ?? 0 };
}

module.exports = { quantityForListing, kitAvailable, effectiveRule, normalizeRule, ruleFromRow, DEFAULT_RULE, RULE_MODES };
