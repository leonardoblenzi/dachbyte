// @ts-check
"use strict";

const { computeAvailability, planListings } = require("../stock/plan");
const { ruleFromRow } = require("../stock/rules");
const { normalizePriceRule, priceRuleFromRow, effectivePriceRule, computePrice, describePriceRule, toNumber } = require("../pricing/rules");

/** @param {string} message @param {number} status @param {string} code */
function fail(message, status, code) { return Object.assign(new Error(message), { status, code }); }

/** @typedef {{ tenantId: string, userId?: string | null }} Identity */

const STATUS = Object.freeze(["active", "paused", "other"]);
const LINK = Object.freeze(["linked", "unlinked"]);
const PRICE_RULE_FILTER = Object.freeze(["listing", "account", "default"]);

/**
 * Painel por marketplace (fase 1): anúncios de cada canal com o estoque que o Hub enviaria,
 * contas e regras de preço e de estoque. Só lê e grava regras; não escreve nos canais.
 * @param {{
 *   repository: ReturnType<typeof import("./repository").createMarketplacesRepository>,
 *   stockRepository: { availabilityInputs: (tenantId: string, itemIds?: number[] | null) => Promise<any> },
 *   channels: () => Array<{ id: string, label: string, kind: string, available: boolean, connection?: string }>,
 * }} deps
 */
function createMarketplacesService({ repository, stockRepository, channels }) {
  /** Canal precisa existir e ser marketplace. @param {string} channel */
  function marketplace(channel) {
    const found = channels().find((c) => c.id === channel && c.kind === "marketplace");
    if (!found) throw fail("Marketplace desconhecido.", 404, "unknown_marketplace");
    return found;
  }

  /** @param {unknown} value @param {readonly string[]} allowed */
  const oneOf = (value, allowed) => (allowed.includes(String(value || "")) ? String(value) : "");

  return {
    /** Cartões da tela Marketplaces: cada canal com contas, anúncios e pendências. @param {string} tenantId */
    async overview(tenantId) {
      const summaries = new Map((await repository.channelSummaries(tenantId)).map((/** @type {any} */ s) => [s.channel, s]));
      return channels().filter((c) => c.kind === "marketplace").map((c) => {
        const s = summaries.get(c.id) || {};
        return { id: c.id, label: c.label, available: c.available, accounts: s.accounts || 0, reconnect: s.reconnect || 0, listings: s.listings || 0, unlinked: s.unlinked || 0 };
      });
    },

    /**
     * Anúncios do canal com o estoque que o Hub enviaria (mesma conta do "O que mudaria")
     * e a regra de preço que vale para cada um.
     * @param {string} tenantId @param {string} channel
     * @param {{ accountId?: number | null, q?: string, status?: string, link?: string, priceRule?: string, limit?: number, offset?: number }} [filters]
     */
    async listings(tenantId, channel, filters = {}) {
      marketplace(channel);
      const scope = { channel, accountId: filters.accountId || null };
      const [rows, summary] = await Promise.all([
        repository.listings(tenantId, {
          ...scope, q: filters.q || "", status: oneOf(filters.status, STATUS), link: oneOf(filters.link, LINK),
          priceRule: oneOf(filters.priceRule, PRICE_RULE_FILTER), limit: filters.limit ?? 50, offset: filters.offset ?? 0,
        }),
        repository.listingsSummary(tenantId, scope),
      ]);
      const itemIds = [...new Set(rows.filter((/** @type {any} */ r) => r.itemId != null).map((/** @type {any} */ r) => Number(r.itemId)))];
      const availability = itemIds.length ? computeAvailability(await stockRepository.availabilityInputs(tenantId, itemIds)) : new Map();
      const linked = rows.filter((/** @type {any} */ r) => r.itemId != null);
      const { rows: planned } = planListings({
        availability,
        listings: linked.map((/** @type {any} */ r) => ({ ...r, accountRule: ruleFromRow(r.accountStockRule), listingRule: ruleFromRow(r.listingStockRule) })),
      });
      const planById = new Map(planned.map((p) => [Number(p.id), p]));
      return {
        summary,
        total: rows[0]?.totalCount || 0,
        rows: rows.map((/** @type {any} */ r) => {
          const plan = planById.get(Number(r.id));
          const { rule, source } = effectivePriceRule(priceRuleFromRow(r.accountPriceRule), priceRuleFromRow(r.listingPriceRule));
          return {
            id: Number(r.id), accountId: Number(r.accountId), accountLabel: r.accountLabel, listingId: r.listingId, variationId: r.variationId,
            channelSku: r.channelSku, title: r.title, status: r.status, statusGroup: r.statusGroup, fulfillment: r.fulfillment,
            item: r.itemId == null ? null : { id: Number(r.itemId), sku: r.sku, name: r.itemName, kind: r.itemKind },
            stock: {
              channel: r.channelStock, available: plan ? plan.available : null, desired: plan ? plan.desired : null,
              state: plan ? plan.state : "unlinked", rule: plan ? plan.rule : null, ruleSource: plan ? plan.ruleSource : null,
            },
            price: { channel: r.channelPrice, rule, ruleText: describePriceRule(rule), ruleSource: source },
          };
        }),
      };
    },

    /** Contas do canal com as regras de estoque e de preço (aba Regras). @param {string} tenantId @param {string} channel */
    async rules(tenantId, channel) {
      marketplace(channel);
      return (await repository.accountRules(tenantId, channel)).map((/** @type {any} */ a) => {
        const priceRule = priceRuleFromRow(a.priceRule);
        return {
          ...a, stockRule: ruleFromRow(a.stockRule), priceRule,
          priceRuleText: describePriceRule(effectivePriceRule(priceRule, null).rule),
        };
      });
    },

    /**
     * Regra de preço da conta ou do anúncio. rule = null remove (anúncio volta a seguir a conta;
     * conta volta ao preço de venda sem ajuste). Nesta fase nada é enviado ao canal.
     * @param {{ identity: Identity, scope: "account" | "listing", targetId: number, rule: any }} input
     */
    async savePriceRule({ identity, scope, targetId, rule }) {
      if (!["account", "listing"].includes(scope)) throw fail("Escopo inválido.", 400, "invalid_scope");
      let clean = null;
      if (rule != null) {
        const normalized = normalizePriceRule(rule);
        if (!normalized.rule) throw fail(normalized.error || "Regra inválida.", 400, "invalid_price_rule");
        clean = normalized.rule;
      }
      const saved = await repository.savePriceRule(identity.tenantId, { scope, targetId, rule: clean, userId: identity.userId });
      if (!saved) throw fail("Conta ou anúncio não encontrado.", 404, "target_not_found");
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "price_rule_saved", details: { scope, target_id: targetId, channel: saved.channel, rule: clean } });
      const savedRule = priceRuleFromRow(saved.rule);
      return { scope, targetId, rule: savedRule, ruleText: savedRule ? describePriceRule(savedRule) : null };
    },

    /**
     * Simulação da regra com preços de exemplo (o cadastro de preços chega na fase Produtos).
     * @param {{ rule: any, sample: { salePrice?: unknown, promoPrice?: unknown, cost?: unknown } }} input
     */
    previewPrice({ rule, sample }) {
      const normalized = normalizePriceRule(rule || {});
      if (!normalized.rule) throw fail(normalized.error || "Regra inválida.", 400, "invalid_price_rule");
      const input = { salePrice: toNumber(sample?.salePrice), promoPrice: toNumber(sample?.promoPrice), cost: toNumber(sample?.cost) };
      return { rule: normalized.rule, ruleText: describePriceRule(normalized.rule), result: computePrice({ ...input, rule: normalized.rule }) };
    },
  };
}

module.exports = { createMarketplacesService };
