// @ts-check
"use strict";

/**
 * Situação do anúncio agrupada para os filtros: cada canal usa as próprias palavras
 * (ML active/paused/closed, Shopee NORMAL/UNLIST/BANNED, Magalu...).
 */
const STATUS_GROUP_SQL = `case
  when lower(coalesce(l.status, '')) in ('active','normal','ativo','enabled','published','listed') then 'active'
  when lower(coalesce(l.status, '')) in ('paused','unlist','unlisted','inactive','pausado','disabled') then 'paused'
  else 'other' end`;

const STOCK_RULE_JSON = (/** @type {string} */ a) =>
  `case when ${a}.id is null then null else json_build_object('mode', ${a}.mode, 'value', ${a}.value, 'cap', ${a}.cap, 'min_lock', ${a}.min_lock, 'safety_reserve', ${a}.safety_reserve) end`;
const PRICE_RULE_JSON = (/** @type {string} */ a) =>
  `case when ${a}.id is null then null else json_build_object('base', ${a}.base, 'adjust', ${a}.adjust, 'value', ${a}.value, 'rounding', ${a}.rounding, 'show_from', ${a}.show_from, 'min_price', ${a}.min_price) end`;

const PRICE_COLUMNS = "base, adjust, value, rounding, show_from, min_price";

/** @param {unknown} value */
const text = (value) => String(value ?? "").trim();

/**
 * Painel de cada marketplace (schema hub): anúncios por canal, resumo e regras das contas.
 * Só lê e grava regras; nada aqui escreve nos canais.
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any>, queryOne: (sql: string, params?: unknown[]) => Promise<any> }} db
 */
function createMarketplacesRepository(db) {
  return {
    /** Contas, anúncios e pendências de cada canal da empresa. @param {string} tenantId */
    async channelSummaries(tenantId) {
      const { rows } = await db.query(
        `select a.channel, count(distinct a.id)::int as accounts,
                count(distinct a.id) filter (where a.status = 'reconnect_required')::int as reconnect,
                count(l.id)::int as listings, count(l.id) filter (where l.item_id is null)::int as unlinked
           from hub.channel_accounts a
           left join hub.listings l on l.channel_account_id = a.id
          where a.tenant_id = $1 and a.status <> 'disconnected'
          group by a.channel`, [tenantId]);
      return rows;
    },

    /**
     * Uma página de anúncios do canal, com o produto ligado e as regras (conta e anúncio).
     * status: active | paused | other; link: linked | unlinked; priceRule: listing | account | default.
     * @param {string} tenantId
     * @param {{ channel: string, accountId?: number | null, q?: string, status?: string, link?: string, priceRule?: string, limit?: number, offset?: number }} filters
     */
    async listings(tenantId, { channel, accountId = null, q = "", status = "", link = "", priceRule = "", limit = 50, offset = 0 }) {
      const { rows } = await db.query(
        `select l.id, a.id as "accountId", coalesce(a.nickname, a.label, a.external_account_id) as "accountLabel", a.stock_sync_mode as "accountMode",
                l.listing_id as "listingId", l.variation_id as "variationId", l.channel_sku as "channelSku", l.title, l.status,
                ${STATUS_GROUP_SQL} as "statusGroup", l.fulfillment, l.channel_stock::float as "channelStock", l.price::float as "channelPrice",
                l.sync_enabled as "syncEnabled", l.item_id as "itemId", i.sku, i.name as "itemName", i.kind as "itemKind",
                ${STOCK_RULE_JSON("asr")} as "accountStockRule", ${STOCK_RULE_JSON("lsr")} as "listingStockRule",
                ${PRICE_RULE_JSON("apr")} as "accountPriceRule", ${PRICE_RULE_JSON("lpr")} as "listingPriceRule",
                count(*) over ()::int as "totalCount"
           from hub.listings l
           join hub.channel_accounts a on a.id = l.channel_account_id and a.tenant_id = $1 and a.channel = $2 and a.status <> 'disconnected'
           left join hub.items i on i.id = l.item_id
           left join hub.stock_rules asr on asr.scope = 'account' and asr.channel_account_id = a.id
           left join hub.stock_rules lsr on lsr.scope = 'listing' and lsr.listing_id = l.id
           left join hub.price_rules apr on apr.scope = 'account' and apr.channel_account_id = a.id
           left join hub.price_rules lpr on lpr.scope = 'listing' and lpr.listing_id = l.id
          where ($3::bigint is null or a.id = $3)
            and ($4::text = '' or l.listing_id ilike '%' || $4 || '%' or l.variation_id = $4 or coalesce(l.channel_sku, '') ilike '%' || $4 || '%'
                 or coalesce(l.title, '') ilike '%' || $4 || '%' or coalesce(i.sku, '') ilike '%' || $4 || '%')
            and ($5::text = '' or ${STATUS_GROUP_SQL} = $5)
            and ($6::text = '' or ($6 = 'linked' and l.item_id is not null) or ($6 = 'unlinked' and l.item_id is null))
            and ($7::text = '' or ($7 = 'listing' and lpr.id is not null) or ($7 = 'account' and lpr.id is null and apr.id is not null)
                 or ($7 = 'default' and lpr.id is null and apr.id is null))
          order by l.title nulls last, l.listing_id, l.variation_id
          limit $8 offset $9`,
        [tenantId, channel, accountId, text(q), text(status), text(link), text(priceRule), Math.min(200, Math.max(1, limit)), Math.max(0, offset)]);
      return rows;
    },

    /** Números das abas da lista (sem os filtros de busca). @param {string} tenantId @param {{ channel: string, accountId?: number | null }} scope */
    async listingsSummary(tenantId, { channel, accountId = null }) {
      return db.queryOne(
        `select count(l.id)::int as total,
                count(l.id) filter (where ${STATUS_GROUP_SQL} = 'active')::int as active,
                count(l.id) filter (where ${STATUS_GROUP_SQL} = 'paused')::int as paused,
                count(l.id) filter (where ${STATUS_GROUP_SQL} = 'other')::int as other,
                count(l.id) filter (where l.item_id is null)::int as unlinked,
                count(l.id) filter (where lpr.id is not null)::int as "ownPriceRule",
                count(l.id) filter (where l.fulfillment)::int as fulfillment
           from hub.listings l
           join hub.channel_accounts a on a.id = l.channel_account_id and a.tenant_id = $1 and a.channel = $2 and a.status <> 'disconnected'
           left join hub.price_rules lpr on lpr.scope = 'listing' and lpr.listing_id = l.id
          where ($3::bigint is null or a.id = $3)`,
        [tenantId, channel, accountId]);
    },

    /** Contas do canal com o modo de estoque e as regras de estoque e de preço. @param {string} tenantId @param {string} channel */
    async accountRules(tenantId, channel) {
      const { rows } = await db.query(
        `select a.id, coalesce(a.nickname, a.label, a.external_account_id) as label, a.status, a.stock_sync_mode as mode, a.activated_at as "activatedAt",
                ${STOCK_RULE_JSON("sr")} as "stockRule", ${PRICE_RULE_JSON("pr")} as "priceRule",
                pr.updated_at as "priceRuleUpdatedAt",
                (select count(*)::int from hub.listings l where l.channel_account_id = a.id) as listings,
                (select count(*)::int from hub.listings l where l.channel_account_id = a.id and l.item_id is not null) as linked,
                (select count(*)::int from hub.price_rules p join hub.listings l on l.id = p.listing_id
                  where p.scope = 'listing' and l.channel_account_id = a.id) as "listingPriceRules",
                (select count(*)::int from hub.stock_rules s join hub.listings l on l.id = s.listing_id
                  where s.scope = 'listing' and l.channel_account_id = a.id) as "listingStockRules"
           from hub.channel_accounts a
           left join hub.stock_rules sr on sr.scope = 'account' and sr.channel_account_id = a.id
           left join hub.price_rules pr on pr.scope = 'account' and pr.channel_account_id = a.id
          where a.tenant_id = $1 and a.channel = $2 and a.status <> 'disconnected'
          order by label`, [tenantId, channel]);
      return rows;
    },

    /**
     * Grava (ou remove, com rule = null) a regra de preço da conta ou do anúncio, conferindo a empresa.
     * @param {string} tenantId
     * @param {{ scope: "account" | "listing", targetId: number, rule: import("../pricing/rules").PriceRule | null, userId?: string | null }} input
     */
    async savePriceRule(tenantId, { scope, targetId, rule, userId = null }) {
      const owner = scope === "account"
        ? await db.queryOne("select id, channel from hub.channel_accounts where id = $1 and tenant_id = $2 and status <> 'disconnected'", [targetId, tenantId])
        : await db.queryOne(
          `select l.id, a.channel from hub.listings l join hub.channel_accounts a on a.id = l.channel_account_id
            where l.id = $1 and a.tenant_id = $2 and a.status <> 'disconnected'`, [targetId, tenantId]);
      if (!owner) return null;
      const column = scope === "account" ? "channel_account_id" : "listing_id";
      if (!rule) {
        await db.query(`delete from hub.price_rules where scope = $1 and ${column} = $2`, [scope, targetId]);
        return { scope, targetId, channel: owner.channel, rule: null };
      }
      const saved = await db.queryOne(
        `insert into hub.price_rules (tenant_id, scope, ${column}, ${PRICE_COLUMNS}, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (${column}) where scope = '${scope === "account" ? "account" : "listing"}' do update set
           base = excluded.base, adjust = excluded.adjust, value = excluded.value, rounding = excluded.rounding,
           show_from = excluded.show_from, min_price = excluded.min_price, updated_by = excluded.updated_by, updated_at = now()
         returning ${PRICE_COLUMNS}`,
        [tenantId, scope, targetId, rule.base, rule.adjust, rule.value, rule.rounding, rule.showFrom, rule.minPrice, userId]);
      return { scope, targetId, channel: owner.channel, rule: saved };
    },

    /** Auditoria. @param {{ tenantId: string, userId?: string | null, action: string, details?: any }} event */
    async audit({ tenantId, userId = null, action, details = {} }) {
      await db.query("insert into hub.audit_events (tenant_id, user_id, action, details) values ($1, $2, $3, $4)", [tenantId, userId, action, JSON.stringify(details)]);
    },
  };
}

module.exports = { createMarketplacesRepository, STATUS_GROUP_SQL };
