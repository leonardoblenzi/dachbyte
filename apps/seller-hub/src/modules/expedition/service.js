// @ts-check
"use strict";

const { skuKey, eanKey } = require("../catalog/normalize");
const { expandUnits, matchCode, checkCounts, pickingList } = require("./units");

const MAX_PHOTO_BYTES = 3_000_000;

/** @param {string} message @param {number} status @param {string} code */
function fail(message, status, code) { return Object.assign(new Error(message), { status, code }); }

/**
 * Foto enviada pela tela (base64). Aceita só JPEG/PNG/WebP de verdade (pelos primeiros bytes), até 3 MB.
 * @param {string | null | undefined} base64 @returns {{ mime: string, content: Buffer } | null}
 */
function decodePhoto(base64) {
  if (!base64) return null;
  const content = Buffer.from(String(base64).replace(/^data:[^,]*,/, ""), "base64");
  if (!content.length) return null;
  if (content.length > MAX_PHOTO_BYTES) throw fail("Foto grande demais (máx. 3 MB).", 400, "photo_too_large");
  const mime = content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff ? "image/jpeg"
    : content.subarray(0, 4).toString("hex") === "89504e47" ? "image/png"
      : content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : null;
  if (!mime) throw fail("Formato de foto não aceito (use JPEG, PNG ou WebP).", 400, "photo_invalid");
  return { mime, content };
}

/**
 * Expedição (Fase 3 / P3): separação em lote, conferência com bipagem e foto, coletas.
 * @param {{
 *   repository: ReturnType<typeof import("./repository").createExpeditionRepository>,
 *   onOrderPacked?: (event: { tenantId: string, orderId: number, packedAt: string }) => Promise<unknown>,
 * }} deps
 */
function createExpeditionService({ repository, onOrderPacked = async () => {} }) {
  /** Unidades a conferir de cada pedido. @param {string} tenantId @param {number[]} orderIds */
  async function unitsByOrder(tenantId, orderIds) {
    const lines = await repository.orderLines(tenantId, orderIds);
    /** @type {Map<number, any[]>} */
    const grouped = new Map();
    for (const l of lines) grouped.set(Number(l.orderId), [...(grouped.get(Number(l.orderId)) || []), l]);
    return new Map(orderIds.map((id) => [id, expandUnits(grouped.get(id) || [])]));
  }

  /** Pedido + unidades (tela de conferência). @param {string} tenantId @param {number} orderId */
  async function forCheckout(tenantId, orderId) {
    const order = await repository.getOrder(tenantId, orderId);
    if (!order) throw fail("Pedido não encontrado.", 404, "order_not_found");
    const units = (await unitsByOrder(tenantId, [orderId])).get(orderId) || [];
    const photos = await repository.listPhotos(tenantId, orderId);
    return { order, units, photos };
  }

  return {
    summary: (/** @type {string} */ tenantId) => repository.summary(tenantId),
    /** @param {string} tenantId @param {{ accountId?: number | null, due?: string }} [options] */
    queue: (tenantId, options) => repository.queue(tenantId, options),

    /** @param {{ identity: { tenantId: string, userId?: string | null }, orderIds: number[] }} input */
    async createBatch({ identity, orderIds }) {
      const ids = [...new Set((orderIds || []).map(Number).filter(Boolean))];
      if (!ids.length || ids.length > 500) throw fail("Escolha de 1 a 500 pedidos.", 400, "invalid_selection");
      return repository.createBatch(identity.tenantId, ids, identity.userId || null);
    },
    listBatches: (/** @type {string} */ tenantId) => repository.listBatches(tenantId),

    /** Lote com a lista de separação somada por item físico. @param {string} tenantId @param {number} id */
    async getBatch(tenantId, id) {
      const batch = await repository.getBatch(tenantId, id);
      if (!batch) throw fail("Lote não encontrado.", 404, "batch_not_found");
      const units = await unitsByOrder(tenantId, batch.orders.map((/** @type {any} */ o) => Number(o.id)));
      const pending = batch.orders.filter((/** @type {any} */ o) => !o.packedAt);
      return { ...batch, picking: pickingList(pending.map((/** @type {any} */ o) => ({ orderId: Number(o.id), units: units.get(Number(o.id)) || [] }))) };
    },
    /** @param {string} tenantId @param {number} id */
    async closeBatch(tenantId, id) {
      const done = await repository.closeBatch(tenantId, id);
      if (!done) throw fail("Lote não encontrado ou já fechado.", 404, "batch_not_found");
      return done;
    },

    /**
     * Conferência por pedido: bipou o pedido (número, rastreio, NF) → devolve o que conferir.
     * @param {string} tenantId @param {string} code
     */
    async lookup(tenantId, code) {
      const found = await repository.findOrderByCode(tenantId, code);
      if (!found) throw fail(`Nenhum pedido com o código ${code}.`, 404, "order_not_found");
      return forCheckout(tenantId, Number(found.id));
    },

    /**
     * Conferência por produto: bipou o item → o pedido mais urgente de 1 unidade desse item (no lote, se informado).
     * @param {string} tenantId @param {string} code @param {number | null} batchId
     */
    async nextForProduct(tenantId, code, batchId = null) {
      const keys = [skuKey(code), eanKey(code)].filter(Boolean);
      const found = keys.length ? await repository.findSingleUnitOrder(tenantId, /** @type {string[]} */ (keys), batchId) : null;
      if (!found) throw fail(`Nenhum pedido de 1 unidade aguardando o produto ${code}.`, 404, "order_not_found");
      return forCheckout(tenantId, Number(found.id));
    },

    /** @param {string} tenantId @param {number} orderId */
    checkout: forCheckout,

    /** Confere um código contra as unidades do pedido (ajuda da tela; a validação final é no concluir). @param {string} tenantId @param {number} orderId @param {string} code */
    async matchUnit(tenantId, orderId, code) {
      const units = (await unitsByOrder(tenantId, [orderId])).get(orderId) || [];
      const unit = matchCode(units, code);
      if (!unit) throw fail(`O código ${code} não é de nenhum item deste pedido.`, 400, "code_not_in_order");
      return { key: unit.key, sku: unit.sku };
    },

    /**
     * Conclui a conferência: a contagem precisa bater item a item (bipado + confirmado sem código).
     * @param {{ identity: { tenantId: string, userId?: string | null }, orderId: number, checks: Array<{ key: string, scanned?: number, manual?: number }>, photoBase64?: string | null }} input
     */
    async pack({ identity, orderId, checks, photoBase64 = null }) {
      const units = (await unitsByOrder(identity.tenantId, [orderId])).get(orderId) || [];
      if (!units.length) throw fail("Pedido sem itens para conferir.", 400, "no_units");
      const problem = checkCounts(units, Array.isArray(checks) ? checks : []);
      if (problem) throw fail(problem, 400, "count_mismatch");
      const photo = decodePhoto(photoBase64);
      const manual = checks.reduce((s, c) => s + (Number(c.manual) || 0), 0);
      const total = units.reduce((s, u) => s + u.quantity, 0);
      const note = `Conferido: ${total} unidade(s)${manual ? `, ${manual} sem código` : ""}${photo ? ", com foto do pacote" : ""} (${identity.userId || "?"}).`;
      const done = await repository.packOrder(identity.tenantId, orderId, { userId: identity.userId || null, note, photo });
      if (!done) throw fail("Pedido já conferido, já enviado, Full, cancelado ou de outra empresa.", 409, "already_packed");
      try { await onOrderPacked({ tenantId: identity.tenantId, orderId, packedAt: new Date(done.packedAt).toISOString() }); }
      catch (error) { console.error("[seller-hub:expedition] automação", orderId, /** @type {any} */ (error)?.message); }
      return done;
    },

    /** @param {{ identity: { tenantId: string, userId?: string | null }, orderId: number, note: string }} input */
    async reportIssue({ identity, orderId, note }) {
      const clean = String(note || "").trim();
      if (!clean) throw fail("Descreva o problema.", 400, "note_required");
      const done = await repository.setIssue(identity.tenantId, orderId, clean, identity.userId || null);
      if (!done) throw fail("Pedido não encontrado ou já conferido.", 404, "order_not_found");
      return done;
    },
    /** @param {{ identity: { tenantId: string, userId?: string | null }, orderId: number }} input */
    async unpack({ identity, orderId }) {
      const done = await repository.unpack(identity.tenantId, orderId, identity.userId || null);
      if (!done) throw fail("Só dá para desfazer pedido conferido e ainda não entregue à transportadora.", 409, "cannot_unpack");
      return done;
    },
    /** @param {string} tenantId @param {number} photoId */
    async photo(tenantId, photoId) {
      const p = await repository.getPhoto(tenantId, photoId);
      if (!p) throw fail("Foto não encontrada.", 404, "photo_not_found");
      return p;
    },

    listPickups: (/** @type {string} */ tenantId) => repository.listPickups(tenantId),
    /** @param {{ identity: { tenantId: string, userId?: string | null }, carrier: string, scheduledFor: string }} input */
    async createPickup({ identity, carrier, scheduledFor }) {
      const name = String(carrier || "").trim().slice(0, 80);
      if (!name) throw fail("Informe a transportadora ou o marketplace da coleta.", 400, "carrier_required");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(scheduledFor || ""))) throw fail("Informe a data da coleta.", 400, "date_required");
      return repository.createPickup(identity.tenantId, { carrier: name, scheduledFor, userId: identity.userId || null });
    },
    /** @param {string} tenantId @param {number} id */
    async getPickup(tenantId, id) {
      const p = await repository.getPickup(tenantId, id);
      if (!p) throw fail("Coleta não encontrada.", 404, "pickup_not_found");
      return p;
    },
    /** Embarque por bipagem do pedido (número, rastreio, NF). @param {{ identity: { tenantId: string }, pickupId: number, code: string }} input */
    async scanToPickup({ identity, pickupId, code }) {
      const found = await repository.findOrderByCode(identity.tenantId, code);
      if (!found) throw fail(`Nenhum pedido com o código ${code}.`, 404, "order_not_found");
      const result = await repository.attachToPickup(identity.tenantId, pickupId, Number(found.id));
      if (!result.ok) throw fail(/** @type {any} */ (result).reason, 409, "cannot_attach");
      return { orderId: Number(found.id) };
    },
    /** @param {{ identity: { tenantId: string }, pickupId: number, orderId: number }} input */
    async removeFromPickup({ identity, pickupId, orderId }) {
      const done = await repository.detachFromPickup(identity.tenantId, pickupId, orderId);
      if (!done) throw fail("Pedido não está nesta coleta aberta.", 404, "not_in_pickup");
      return done;
    },
    /** @param {{ identity: { tenantId: string, userId?: string | null }, pickupId: number }} input */
    async closePickup({ identity, pickupId }) {
      const done = await repository.closePickup(identity.tenantId, pickupId, identity.userId || null);
      if (!done) throw fail("Coleta não encontrada ou já fechada.", 404, "pickup_not_found");
      return done;
    },
  };
}

module.exports = { createExpeditionService, decodePhoto };
