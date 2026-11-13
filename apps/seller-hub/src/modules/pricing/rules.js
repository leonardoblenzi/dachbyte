// @ts-check
"use strict";

/**
 * Regra de preço de uma conta ou de um anúncio.
 * base: de onde parte o preço (venda, promocional se houver, custo).
 * adjust/value: % (negativo = desconto), R$ (negativo = desconto) ou preço fixo.
 * rounding: arredonda para cima até o final ,90 ou ,99.
 * showFrom: "sale" manda o preço "de" (riscado) quando a promoção é usada.
 * minPrice: o preço enviado nunca fica abaixo dele.
 * @typedef {{
 *   base: "sale" | "promo_or_sale" | "cost",
 *   adjust: "pct" | "amount" | "fixed",
 *   value: number,
 *   rounding: "none" | "90" | "99",
 *   showFrom: "sale" | "none",
 *   minPrice: number | null,
 * }} PriceRule
 */

/** Sem regra: o anúncio recebe o preço de venda do cadastro, sem ajuste. @type {PriceRule} */
const DEFAULT_PRICE_RULE = Object.freeze({ base: "sale", adjust: "pct", value: 0, rounding: "none", showFrom: "sale", minPrice: null });

const BASES = Object.freeze(["sale", "promo_or_sale", "cost"]);
const ADJUSTS = Object.freeze(["pct", "amount", "fixed"]);
const ROUNDINGS = Object.freeze(["none", "90", "99"]);
const SHOW_FROM = Object.freeze(["sale", "none"]);

/** Número vindo da tela (aceita vírgula decimal). Vazio = null. @param {unknown} value */
function toNumber(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  const text = String(value).trim().replace(/\s|R\$|%/g, "");
  if (!text) return null;
  const normalized = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
  return Number(normalized);
}

/** @param {number} value @returns {number} centavos */
const toCents = (value) => Math.round(value * 100);

/**
 * Arredonda para cima até o final escolhido (,90 ou ,99), em centavos.
 * @param {number} cents @param {PriceRule["rounding"]} rounding
 */
function roundEnding(cents, rounding) {
  if (rounding === "none") return cents;
  const ending = rounding === "90" ? 90 : 99;
  let rounded = Math.floor(cents / 100) * 100 + ending;
  if (rounded < cents) rounded += 100;
  return rounded;
}

/**
 * Valida a regra vinda da tela. Devolve a regra limpa ou a mensagem do primeiro problema.
 * @param {any} input @returns {{ rule: PriceRule, error: null } | { rule: null, error: string }}
 */
function normalizePriceRule(input) {
  const base = String(input?.base || "sale");
  const adjust = String(input?.adjust || "pct");
  const rounding = String(input?.rounding || "none");
  const showFrom = String(input?.showFrom || "sale");
  if (!BASES.includes(base)) return { rule: null, error: "Preço de partida inválido." };
  if (!ADJUSTS.includes(adjust)) return { rule: null, error: "Tipo de ajuste inválido." };
  if (!ROUNDINGS.includes(rounding)) return { rule: null, error: "Arredondamento inválido." };
  if (!SHOW_FROM.includes(showFrom)) return { rule: null, error: "Opção de preço \"de\" inválida." };
  const value = toNumber(input?.value) ?? 0;
  if (!Number.isFinite(value)) return { rule: null, error: "Informe um valor numérico para o ajuste." };
  if (adjust === "pct" && (value <= -100 || value > 1000)) return { rule: null, error: "O percentual vai de -99,99% (desconto) a 1.000%." };
  if (adjust === "amount" && Math.abs(value) > 1_000_000) return { rule: null, error: "Valor do ajuste grande demais." };
  if (adjust === "fixed" && !(value > 0)) return { rule: null, error: "Informe o preço fixo, maior que zero." };
  const minPrice = toNumber(input?.minPrice);
  if (minPrice != null && (!Number.isFinite(minPrice) || minPrice < 0)) return { rule: null, error: "O preço mínimo precisa ser maior ou igual a zero." };
  return {
    rule: {
      base: /** @type {PriceRule["base"]} */ (base),
      adjust: /** @type {PriceRule["adjust"]} */ (adjust),
      value: adjust === "pct" ? Math.round(value * 10000) / 10000 : toCents(value) / 100,
      rounding: /** @type {PriceRule["rounding"]} */ (rounding),
      showFrom: /** @type {PriceRule["showFrom"]} */ (showFrom),
      minPrice: minPrice == null || minPrice === 0 ? null : toCents(minPrice) / 100,
    },
    error: null,
  };
}

/** Linha do banco (hub.price_rules) → regra. @param {any} row @returns {PriceRule | null} */
function priceRuleFromRow(row) {
  if (!row) return null;
  /** @param {unknown} v */
  const n = (v) => (v == null ? null : Number(v));
  return {
    base: row.base, adjust: row.adjust, value: n(row.value) ?? 0, rounding: row.rounding,
    showFrom: row.show_from ?? row.showFrom ?? "sale", minPrice: n(row.min_price ?? row.minPrice),
  };
}

/**
 * Regra que vale para o anúncio: a do anúncio vence a da conta; sem nenhuma, o preço de venda.
 * A regra do anúncio é completa (não mistura campos com a da conta).
 * @param {PriceRule | null | undefined} accountRule @param {PriceRule | null | undefined} listingRule
 * @returns {{ rule: PriceRule, source: "listing" | "account" | "default" }}
 */
function effectivePriceRule(accountRule, listingRule) {
  if (listingRule) return { rule: listingRule, source: "listing" };
  if (accountRule) return { rule: accountRule, source: "account" };
  return { rule: { ...DEFAULT_PRICE_RULE }, source: "default" };
}

/**
 * Preço que o anúncio receberia. Função pura, em centavos para não errar arredondamento.
 * price = null quando falta o preço de partida no cadastro ou o resultado não é positivo.
 * @param {{ salePrice?: number | null, promoPrice?: number | null, cost?: number | null, rule?: PriceRule | null }} input
 * @returns {{ price: number | null, fromPrice: number | null, baseUsed: "sale" | "promo" | "cost" | null,
 *             reason: null | "no_sale_price" | "no_cost" | "non_positive", minApplied: boolean }}
 */
function computePrice({ salePrice = null, promoPrice = null, cost = null, rule = null }) {
  const r = { ...DEFAULT_PRICE_RULE, ...(rule || {}) };
  const positive = (/** @type {unknown} */ v) => (v != null && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const sale = positive(salePrice), promo = positive(promoPrice), costValue = positive(cost);
  /** @param {number} baseCents */
  const apply = (baseCents) => {
    if (r.adjust === "fixed") return toCents(r.value);
    if (r.adjust === "amount") return baseCents + toCents(r.value);
    return Math.round(baseCents * (1 + r.value / 100));
  };
  const minCents = r.minPrice != null ? toCents(r.minPrice) : null;
  /** @param {number} cents */
  const finish = (cents) => roundEnding(cents, r.rounding);

  /** @type {"sale" | "promo" | "cost" | null} */
  let baseUsed = null;
  let baseCents = 0;
  if (r.adjust !== "fixed") {
    if (r.base === "cost") {
      if (!costValue) return { price: null, fromPrice: null, baseUsed: null, reason: "no_cost", minApplied: false };
      baseUsed = "cost"; baseCents = toCents(costValue);
    } else if (r.base === "promo_or_sale" && promo && (!sale || promo < sale)) {
      baseUsed = "promo"; baseCents = toCents(promo);
    } else {
      if (!sale) return { price: null, fromPrice: null, baseUsed: null, reason: "no_sale_price", minApplied: false };
      baseUsed = "sale"; baseCents = toCents(sale);
    }
  }
  let cents = apply(baseCents);
  if (cents <= 0) return { price: null, fromPrice: null, baseUsed, reason: "non_positive", minApplied: false };
  cents = finish(cents);
  let minApplied = false;
  if (minCents != null && cents < minCents) { cents = minCents; minApplied = true; }
  // Preço "de": só quando a promoção foi usada; é o preço de venda com o mesmo ajuste.
  let fromCents = null;
  if (r.showFrom === "sale" && baseUsed === "promo" && sale) {
    const candidate = finish(apply(toCents(sale)));
    if (candidate > cents) fromCents = candidate;
  }
  return { price: cents / 100, fromPrice: fromCents == null ? null : fromCents / 100, baseUsed, reason: null, minApplied };
}

/** R$ 1.234,56 (sem espaço especial, para texto e testes). @param {number} value */
function brl(value) {
  const [int, dec] = Math.abs(value).toFixed(2).split(".");
  return `${value < 0 ? "-" : ""}R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

/** @param {number} value */
const pctText = (value) => `${String(Math.abs(value)).replace(".", ",")}%`;

const BASE_LABELS = Object.freeze({ sale: "Preço de venda", promo_or_sale: "Preço promocional (se houver)", cost: "Preço de custo" });

/** Texto curto da regra, para listas e tabelas. @param {PriceRule | null | undefined} rule */
function describePriceRule(rule) {
  const r = { ...DEFAULT_PRICE_RULE, ...(rule || {}) };
  const parts = [];
  if (r.adjust === "fixed") parts.push(`Preço fixo ${brl(r.value)}`);
  else {
    const base = BASE_LABELS[r.base];
    if (!r.value) parts.push(base);
    else if (r.adjust === "pct") parts.push(`${base} ${r.value > 0 ? "+" : "−"} ${pctText(r.value)}`);
    else parts.push(`${base} ${r.value > 0 ? "+" : "−"} ${brl(Math.abs(r.value))}`);
  }
  if (r.rounding !== "none") parts.push(`final ,${r.rounding}`);
  if (r.minPrice != null) parts.push(`mínimo ${brl(r.minPrice)}`);
  return parts.join(" · ");
}

module.exports = {
  DEFAULT_PRICE_RULE, BASES, ADJUSTS, ROUNDINGS, SHOW_FROM,
  normalizePriceRule, priceRuleFromRow, effectivePriceRule, computePrice, describePriceRule, brl, toNumber, _test: { roundEnding },
};
