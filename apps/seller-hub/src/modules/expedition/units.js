// @ts-check
"use strict";

const { skuKey, eanKey } = require("../catalog/normalize");

/**
 * Unidade física a separar/conferir. Kit vira os componentes (é o que vai para a caixa).
 * Item sem vínculo entra pelo SKU do canal (só dá para confirmar sem código ou pelo SKU do canal).
 * @typedef {{ key: string, itemId: number | null, sku: string, name: string | null, ean: string | null, quantity: number,
 *             fromKit: string | null, codes: string[] }} PackUnit
 */

/**
 * @param {Array<{ id: number, quantity: number, itemId: number | null, sku: string | null, name: string | null, ean: string | null,
 *   kind: string | null, channelSku: string | null, title: string | null,
 *   components?: Array<{ itemId: number, sku: string, name: string | null, ean: string | null, quantity: number }> }>} lines
 * @returns {PackUnit[]}
 */
function expandUnits(lines) {
  /** @type {Map<string, PackUnit>} */
  const units = new Map();
  /** @param {Omit<PackUnit, "quantity" | "codes"> & { quantity: number }} u */
  const add = (u) => {
    const cur = units.get(u.key);
    if (cur) { cur.quantity += u.quantity; return; }
    // Sem SKU de verdade não há código para bipar: só "sem código".
    const codes = [u.sku === "(sem SKU)" ? null : skuKey(u.sku), eanKey(u.ean)].filter((c) => Boolean(c));
    units.set(u.key, { ...u, codes: /** @type {string[]} */ (codes) });
  };
  for (const line of lines) {
    const qty = Number(line.quantity) || 0;
    if (!qty) continue;
    if (line.itemId && line.kind === "kit" && line.components?.length) {
      for (const c of line.components) {
        add({ key: `item:${c.itemId}`, itemId: Number(c.itemId), sku: c.sku, name: c.name, ean: c.ean, quantity: qty * Number(c.quantity), fromKit: line.sku });
      }
    } else if (line.itemId) {
      add({ key: `item:${line.itemId}`, itemId: Number(line.itemId), sku: String(line.sku), name: line.name, ean: line.ean, quantity: qty, fromKit: null });
    } else {
      add({ key: `line:${line.id}`, itemId: null, sku: line.channelSku || "(sem SKU)", name: line.title, ean: null, quantity: qty, fromKit: null });
    }
  }
  return [...units.values()];
}

/**
 * Qual unidade o código bipado representa (EAN ou SKU, normalizados como no catálogo).
 * @param {PackUnit[]} units @param {string} code @returns {PackUnit | null}
 */
function matchCode(units, code) {
  const keys = [skuKey(code), eanKey(code)].filter(Boolean);
  if (!keys.length) return null;
  return units.find((u) => u.codes.some((c) => keys.includes(c))) || null;
}

/**
 * Confere a contagem enviada pela tela contra o esperado. Devolve o problema ou null.
 * @param {PackUnit[]} units @param {Array<{ key: string, scanned?: number, manual?: number }>} checks
 */
function checkCounts(units, checks) {
  const byKey = new Map(checks.map((c) => [String(c.key), c]));
  for (const u of units) {
    const c = byKey.get(u.key);
    const done = (Number(c?.scanned) || 0) + (Number(c?.manual) || 0);
    if (done !== u.quantity) return `${u.sku}: conferido ${done} de ${u.quantity}.`;
  }
  const unknown = checks.find((c) => !units.some((u) => u.key === String(c.key)));
  if (unknown) return "Conferência com item que não é deste pedido.";
  return null;
}

/**
 * Lista de separação de um lote: soma por item físico, com quantos pedidos usam cada um.
 * @param {Array<{ orderId: number, units: PackUnit[] }>} orders
 */
function pickingList(orders) {
  /** @type {Map<string, PackUnit & { orders: number }>} */
  const rows = new Map();
  for (const o of orders) {
    for (const u of o.units) {
      const cur = rows.get(u.key);
      if (cur) { cur.quantity += u.quantity; cur.orders += 1; }
      else rows.set(u.key, { ...u, orders: 1 });
    }
  }
  return [...rows.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}

module.exports = { expandUnits, matchCode, checkCounts, pickingList };
