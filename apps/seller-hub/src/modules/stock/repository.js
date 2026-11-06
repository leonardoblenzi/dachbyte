// @ts-check
"use strict";

/**
 * @typedef {{
 *   itemId: number, op: "add" | "set", quantity: number,
 *   kind: "initial" | "adjustment" | "inventory" | "spreadsheet" | "sale" | "cancellation" | "return",
 *   note?: string | null, sourceType?: string | null, sourceId?: string | null,
 *   idempotencyKey?: string | null, channelAccountId?: number | null,
 * }} StockEntry
 */

/** @param {string} message @param {number} status @param {string} code @param {any} [details] */
function fail(message, status, code, details) { return Object.assign(new Error(message), { status, code, details }); }

const RULE_COLUMNS = "mode, value, cap, min_lock, safety_reserve";

/**
 * Estoque mestre (schema hub). SQL explícito, operações em lote.
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any>, queryOne: (sql: string, params?: unknown[]) => Promise<any>,
 *           transaction: (work: (client: any) => Promise<any>) => Promise<any> }} db
 */
function createStockRepository(db) {
  /** Local padrão da empresa (criado na primeira vez). @param {any} client @param {string} tenantId @returns {Promise<number>} */
  async function defaultLocation(client, tenantId) {
    await client.query(
      `insert into hub.locations (tenant_id, name, is_default) values ($1, 'Estoque principal', true)
       on conflict (tenant_id) where is_default do nothing`, [tenantId]);
    const { rows } = await client.query("select id from hub.locations where tenant_id = $1 and is_default", [tenantId]);
    return Number(rows[0].id);
  }

  return {
    /**
     * Aplica movimentos de estoque numa transação: trava os saldos, calcula o novo físico,
     * grava o ledger e atualiza o saldo. "set" vira a diferença para o valor informado.
     * Movimento com idempotencyKey já gravado é ignorado (reenvio não duplica).
     * @param {string} tenantId @param {StockEntry[]} entries
     * @param {{ userId?: string | null, allowNegative?: boolean }} [options]
     */
    async applyEntries(tenantId, entries, { userId = null, allowNegative = false } = {}) {
      if (!entries.length) return { applied: 0, unchanged: 0, duplicates: 0, changes: [] };
      return db.transaction(async (client) => {
        const locationId = await defaultLocation(client, tenantId);
        const itemIds = [...new Set(entries.map((e) => Number(e.itemId)))];
        const { rows: items } = await client.query("select id, sku, kind from hub.items where tenant_id = $1 and id = any($2::bigint[])", [tenantId, itemIds]);
        const byId = new Map(items.map((/** @type {any} */ i) => [Number(i.id), i]));
        const invalid = itemIds.filter((id) => !byId.has(id) || byId.get(id).kind === "kit");
        if (invalid.length) {
          throw fail("Há produtos que não existem nesta empresa ou são kits (kit não tem estoque próprio).", 400, "invalid_items",
            invalid.map((id) => ({ itemId: id, sku: byId.get(id)?.sku || null })));
        }
        const keys = entries.map((e) => e.idempotencyKey).filter(Boolean);
        const seen = new Set(keys.length
          ? (await client.query("select idempotency_key from hub.stock_movements where tenant_id = $1 and idempotency_key = any($2::text[])", [tenantId, keys])).rows.map((/** @type {any} */ r) => r.idempotency_key)
          : []);
        const pending = entries.filter((e) => !e.idempotencyKey || !seen.has(e.idempotencyKey));
        const pendingIds = [...new Set(pending.map((e) => Number(e.itemId)))].sort((a, b) => a - b);
        // Cria a linha de saldo (zero) de quem ainda não tem: marca "estoque informado".
        await client.query(
          `insert into hub.stock_balances (item_id, location_id, tenant_id)
           select unnest($1::bigint[]), $2, $3 on conflict (item_id, location_id) do nothing`, [pendingIds, locationId, tenantId]);
        const { rows: locked } = await client.query(
          `select item_id, on_hand from hub.stock_balances where location_id = $1 and item_id = any($2::bigint[])
            order by item_id for update`, [locationId, pendingIds]);
        const onHand = new Map(locked.map((/** @type {any} */ r) => [Number(r.item_id), Number(r.on_hand)]));
        /** @type {any[]} */
        const movements = [];
        /** @type {Array<{ itemId: number, sku: string, before: number, after: number, delta: number }>} */
        const changes = [];
        /** @type {Array<{ itemId: number, sku: string, after: number }>} */
        const negatives = [];
        let unchanged = 0;
        for (const e of pending) {
          const id = Number(e.itemId);
          const before = onHand.get(id) ?? 0;
          const delta = e.op === "set" ? Number(e.quantity) - before : Number(e.quantity);
          if (!delta) { unchanged += 1; continue; }
          const after = before + delta;
          if (after < 0 && !allowNegative) { negatives.push({ itemId: id, sku: byId.get(id).sku, after }); continue; }
          onHand.set(id, after);
          changes.push({ itemId: id, sku: byId.get(id).sku, before, after, delta });
          movements.push({
            item_id: id, kind: e.kind, quantity: delta, balance_after: after, source_type: e.sourceType || null, source_id: e.sourceId || null,
            idempotency_key: e.idempotencyKey || null, channel_account_id: e.channelAccountId || null, note: e.note ? String(e.note).slice(0, 500) : null,
          });
        }
        if (negatives.length) throw fail("O estoque ficaria negativo. Revise as quantidades.", 400, "negative_stock", negatives.slice(0, 50));
        if (movements.length) {
          await client.query(
            `insert into hub.stock_movements (tenant_id, item_id, location_id, kind, quantity, balance_after, source_type, source_id,
                                              idempotency_key, channel_account_id, user_id, note)
             select $1, x.item_id, $2, x.kind, x.quantity, x.balance_after, x.source_type, x.source_id, x.idempotency_key,
                    x.channel_account_id, $3, x.note
               from jsonb_to_recordset($4::jsonb) as x(item_id bigint, kind text, quantity numeric, balance_after numeric, source_type text,
                    source_id text, idempotency_key text, channel_account_id bigint, note text)`,
            [tenantId, locationId, userId, JSON.stringify(movements)]);
          const finals = [...new Map(changes.map((c) => [c.itemId, c.after])).entries()].map(([item_id, on_hand]) => ({ item_id, on_hand }));
          await client.query(
            `update hub.stock_balances b set on_hand = x.on_hand, updated_at = now()
               from jsonb_to_recordset($2::jsonb) as x(item_id bigint, on_hand numeric)
              where b.item_id = x.item_id and b.location_id = $1`, [locationId, JSON.stringify(finals)]);
        }
        return { applied: movements.length, unchanged, duplicates: entries.length - pending.length, changes };
      });
    },

    /**
     * Dados para calcular o disponível (kits pelos componentes). Com itemIds, só esses itens e os
     * componentes dos kits entre eles (usado a cada venda, sem carregar o catálogo inteiro).
     * @param {string} tenantId @param {number[] | null} [itemIds]
     */
    async availabilityInputs(tenantId, itemIds = null) {
      const scope = itemIds
        ? `and (i.id = any($2::bigint[]) or i.id in (select component_item_id from hub.kit_components where kit_item_id = any($2::bigint[])))`
        : "";
      const params = itemIds ? [tenantId, itemIds] : [tenantId];
      const [items, balances, components] = await Promise.all([
        db.query(`select i.id, i.kind from hub.items i where i.tenant_id = $1 and i.active ${scope}`, params),
        db.query(`select b.item_id as "itemId", b.on_hand as "onHand", b.reserved from hub.stock_balances b join hub.items i on i.id = b.item_id where b.tenant_id = $1 ${scope}`, params),
        db.query(
          `select k.kit_item_id as "kitItemId", k.component_item_id as "componentItemId", k.quantity
             from hub.kit_components k join hub.items i on i.id = k.kit_item_id where i.tenant_id = $1 ${itemIds ? "and k.kit_item_id = any($2::bigint[])" : ""}`, params),
      ]);
      return { items: items.rows, balances: balances.rows, components: components.rows };
    },

    /** @param {string} tenantId @param {string[]} skuKeys */
    async findItemsBySkuKeys(tenantId, skuKeys) {
      const { rows } = await db.query(
        `select id, sku, sku_key as "skuKey", kind, name from hub.items where tenant_id = $1 and active and sku_key = any($2::text[])`, [tenantId, skuKeys]);
      return rows;
    },

    /**
     * Itens com saldo e quantidade de anúncios (a tela soma o disponível dos kits).
     * filter: "all" | "no_stock" (sem estoque informado) | "kits" | "low" (disponível de 1 até o limite) | "zero" (disponível ≤ 0).
     * @param {string} tenantId @param {{ q?: string, filter?: string, threshold?: number, limit?: number, offset?: number }} [options]
     */
    async listStock(tenantId, { q = "", filter = "all", threshold = 5, limit = 50, offset = 0 } = {}) {
      const { rows } = await db.query(
        `select i.id, i.sku, i.name, i.kind, i.ean,
                coalesce(sum(b.on_hand), 0)::float as "onHand", coalesce(sum(b.reserved), 0)::float as reserved,
                count(b.item_id) > 0 as "hasStock",
                (select count(*)::int from hub.listings l where l.item_id = i.id) as listings,
                count(*) over ()::int as "totalCount"
           from hub.items i
           left join hub.stock_balances b on b.item_id = i.id
          where i.tenant_id = $1 and i.active
            and ($2 = '' or i.sku ilike '%' || $2 || '%' or coalesce(i.name, '') ilike '%' || $2 || '%' or coalesce(i.ean, '') = $2)
            and ($3 <> 'kits' or i.kind = 'kit')
          group by i.id
         having ($3 <> 'no_stock' or (i.kind = 'simple' and count(b.item_id) = 0))
            and ($3 <> 'low' or (i.kind = 'simple' and count(b.item_id) > 0 and sum(b.on_hand - b.reserved) > 0 and sum(b.on_hand - b.reserved) <= $6))
            and ($3 <> 'zero' or (i.kind = 'simple' and count(b.item_id) > 0 and sum(b.on_hand - b.reserved) <= 0))
          order by i.sku
          limit $4 offset $5`,
        [tenantId, String(q || "").trim(), filter, Math.min(5000, Math.max(1, limit)), Math.max(0, offset), Math.max(0, Number(threshold) || 0)]);
      return rows;
    },

    /** Limite de estoque baixo da empresa (padrão 5). @param {string} tenantId */
    async lowStockThreshold(tenantId) {
      const row = await db.queryOne("select low_stock_threshold as n from hub.tenant_settings where tenant_id = $1", [tenantId]);
      return row ? Number(row.n) : 5;
    },

    /**
     * Números do painel "precisa de atenção". Produtos: só simples (kit não tem estoque próprio).
     * @param {string} tenantId @param {number} threshold
     */
    async attention(tenantId, threshold) {
      return db.queryOne(
        `with bal as (
           select i.id, count(b.item_id) as rows, coalesce(sum(b.on_hand - b.reserved), 0) as available
             from hub.items i left join hub.stock_balances b on b.item_id = i.id
            where i.tenant_id = $1 and i.active and i.kind = 'simple' group by i.id)
         select
           (select count(*)::int from bal where rows = 0) as "itemsNoStock",
           (select count(*)::int from bal where rows > 0 and available > 0 and available <= $2) as "itemsLowStock",
           (select count(*)::int from bal where rows > 0 and available <= 0) as "itemsZero",
           (select count(*)::int from hub.listings l join hub.channel_accounts a on a.id = l.channel_account_id
             where a.tenant_id = $1 and a.status <> 'disconnected' and l.item_id is not null and not l.fulfillment and l.channel_stock = 0) as "listingsZeroInChannel",
           (select count(*)::int from hub.listings l join hub.channel_accounts a on a.id = l.channel_account_id
             where a.tenant_id = $1 and a.status <> 'disconnected' and l.item_id is null) as "listingsUnlinked",
           (select count(*)::int from hub.order_lines ol join hub.channel_orders o on o.id = ol.order_id join hub.channel_accounts a on a.id = o.channel_account_id
             where a.tenant_id = $1 and ol.pending_link) as "pendingSales",
           (select count(*)::int from hub.stock_divergences d where d.tenant_id = $1 and d.status = 'open') as "divergencesOpen",
           (select count(*)::int from hub.stock_pushes p where p.tenant_id = $1 and p.state in ('failed','divergent') and p.updated_at > now() - interval '24 hours') as "pushProblems24h",
           $2::int as threshold`,
        [tenantId, threshold]);
    },

    /** @param {string} tenantId @param {{ itemId?: number | null, limit?: number, offset?: number }} [options] */
    async listMovements(tenantId, { itemId = null, limit = 50, offset = 0 } = {}) {
      const { rows } = await db.query(
        `select m.id, m.item_id as "itemId", i.sku, i.name, m.kind, m.quantity::float as quantity, m.balance_after::float as "balanceAfter",
                m.source_type as "sourceType", m.source_id as "sourceId", m.user_id as "userId", m.note, m.created_at as "createdAt"
           from hub.stock_movements m join hub.items i on i.id = m.item_id
          where m.tenant_id = $1 and ($2::bigint is null or m.item_id = $2)
          order by m.id desc limit $3 offset $4`,
        [tenantId, itemId, Math.min(200, Math.max(1, limit)), Math.max(0, offset)]);
      return rows;
    },

    /**
     * Estoque dos canais para o estoque inicial. "account": o anúncio daquela conta (maior valor se houver
     * mais de um); "lowest": o menor entre todos os canais. Full fica de fora; só itens simples.
     * @param {string} tenantId @param {{ source: "account" | "lowest", accountId?: number | null }} input
     * @returns {Promise<Array<{ itemId: number, sku: string, quantity: number, listings: number }>>}
     */
    async channelStockByItem(tenantId, { source, accountId = null }) {
      const { rows } = await db.query(
        `select i.id as "itemId", i.sku,
                (case when $2 = 'account' then max(l.channel_stock) else min(l.channel_stock) end)::float as quantity,
                count(*)::int as listings
           from hub.listings l
           join hub.channel_accounts a on a.id = l.channel_account_id and a.tenant_id = $1 and a.status <> 'disconnected'
           join hub.items i on i.id = l.item_id and i.kind = 'simple' and i.active
          where not l.fulfillment and l.channel_stock is not null and ($3::bigint is null or a.id = $3)
          group by i.id, i.sku`,
        [tenantId, source, source === "account" ? accountId : null]);
      return rows;
    },

    /**
     * Anúncios vinculados com regra da conta e do anúncio (para o plano e para o envio).
     * @param {string} tenantId @param {{ accountId?: number | null, itemIds?: number[] | null }} [options]
     */
    async planListings(tenantId, { accountId = null, itemIds = null } = {}) {
      const { rows } = await db.query(
        `select l.id, a.id as "accountId", a.channel, coalesce(a.label, a.external_account_id) as "accountLabel", a.stock_sync_mode as "accountMode",
                l.listing_id as "listingId", l.variation_id as "variationId", l.title, l.fulfillment, l.channel_stock::float as "channelStock",
                l.sync_enabled as "syncEnabled", i.id as "itemId", i.sku, i.name as "itemName", l.last_pushed_stock::float as "lastPushedStock",
                case when ar.id is null then null else json_build_object('mode', ar.mode, 'value', ar.value, 'cap', ar.cap, 'min_lock', ar.min_lock, 'safety_reserve', ar.safety_reserve) end as "accountRule",
                case when lr.id is null then null else json_build_object('mode', lr.mode, 'value', lr.value, 'cap', lr.cap, 'min_lock', lr.min_lock, 'safety_reserve', lr.safety_reserve) end as "listingRule"
           from hub.listings l
           join hub.channel_accounts a on a.id = l.channel_account_id and a.tenant_id = $1 and a.status <> 'disconnected'
           join hub.items i on i.id = l.item_id
           left join hub.stock_rules ar on ar.scope = 'account' and ar.channel_account_id = a.id
           left join hub.stock_rules lr on lr.scope = 'listing' and lr.listing_id = l.id
          where ($2::bigint is null or a.id = $2) and ($3::bigint[] is null or i.id = any($3::bigint[]))
          order by i.sku, a.channel, l.listing_id, l.variation_id`,
        [tenantId, accountId, itemIds]);
      return rows;
    },

    /** Contas com o modo de estoque e a regra padrão. @param {string} tenantId */
    async listAccountRules(tenantId) {
      const { rows } = await db.query(
        `select a.id, a.channel, coalesce(a.label, a.external_account_id) as label, a.status, a.stock_sync_mode as "mode",
                a.activated_at as "activatedAt",
                case when r.id is null then null else json_build_object('mode', r.mode, 'value', r.value, 'cap', r.cap, 'min_lock', r.min_lock, 'safety_reserve', r.safety_reserve) end as rule,
                (select count(*)::int from hub.listings l where l.channel_account_id = a.id and l.item_id is not null) as linked
           from hub.channel_accounts a
           left join hub.stock_rules r on r.scope = 'account' and r.channel_account_id = a.id
          where a.tenant_id = $1 and a.status <> 'disconnected'
          order by a.channel, label`, [tenantId]);
      return rows;
    },

    /** @param {string} tenantId @param {number} accountId @param {"off" | "observe"} mode */
    async setAccountMode(tenantId, accountId, mode) {
      return db.queryOne(
        `update hub.channel_accounts set stock_sync_mode = $3, updated_at = now()
          where id = $1 and tenant_id = $2 and status <> 'disconnected' returning id, stock_sync_mode as mode`, [accountId, tenantId, mode]);
    },

    /**
     * Grava (ou remove, com rule = null) a regra da conta ou do anúncio, conferindo a empresa.
     * @param {string} tenantId @param {{ scope: "account" | "listing", targetId: number, rule: import("./rules").StockRule | null, userId?: string | null }} input
     */
    async saveRule(tenantId, { scope, targetId, rule, userId = null }) {
      const owner = scope === "account"
        ? await db.queryOne("select id from hub.channel_accounts where id = $1 and tenant_id = $2", [targetId, tenantId])
        : await db.queryOne(
          `select l.id from hub.listings l join hub.channel_accounts a on a.id = l.channel_account_id
            where l.id = $1 and a.tenant_id = $2`, [targetId, tenantId]);
      if (!owner) return null;
      const column = scope === "account" ? "channel_account_id" : "listing_id";
      if (!rule) {
        await db.query(`delete from hub.stock_rules where scope = $1 and ${column} = $2`, [scope, targetId]);
        return { scope, targetId, rule: null };
      }
      const saved = await db.queryOne(
        `insert into hub.stock_rules (tenant_id, scope, ${column}, ${RULE_COLUMNS}, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (${column}) where scope = '${scope}' do update set
           mode = excluded.mode, value = excluded.value, cap = excluded.cap, min_lock = excluded.min_lock,
           safety_reserve = excluded.safety_reserve, updated_by = excluded.updated_by, updated_at = now()
         returning ${RULE_COLUMNS}`,
        [tenantId, scope, targetId, rule.mode, rule.value ?? 0, rule.cap ?? null, rule.minLock ?? 0, rule.safetyReserve ?? 0, userId]);
      return { scope, targetId, rule: saved };
    },

    /** @param {string} tenantId @param {number} listingId @param {boolean} enabled */
    async setListingSync(tenantId, listingId, enabled) {
      return db.queryOne(
        `update hub.listings l set sync_enabled = $3, updated_at = now() from hub.channel_accounts a
          where l.id = $1 and a.id = l.channel_account_id and a.tenant_id = $2 returning l.id, l.sync_enabled as "syncEnabled"`,
        [listingId, tenantId, enabled]);
    },

    /** Item com componentes (se kit), saldo e se é componente de algum kit. @param {string} tenantId @param {number} itemId */
    async getItem(tenantId, itemId) {
      return db.queryOne(
        `select i.id, i.sku, i.name, i.kind,
                coalesce((select sum(b.on_hand) from hub.stock_balances b where b.item_id = i.id), 0)::float as "onHand",
                exists (select 1 from hub.kit_components k where k.component_item_id = i.id) as "usedInKits",
                coalesce((select json_agg(json_build_object('itemId', c.id, 'sku', c.sku, 'name', c.name, 'quantity', k.quantity::float) order by c.sku)
                            from hub.kit_components k join hub.items c on c.id = k.component_item_id where k.kit_item_id = i.id), '[]') as components
           from hub.items i where i.id = $1 and i.tenant_id = $2`, [itemId, tenantId]);
    },

    /**
     * Troca os componentes do kit (lista vazia volta o item para simples).
     * @param {string} tenantId @param {number} itemId @param {Array<{ itemId: number, quantity: number }>} components
     */
    async replaceKit(tenantId, itemId, components) {
      return db.transaction(async (client) => {
        await client.query("delete from hub.kit_components where kit_item_id = $1", [itemId]);
        if (components.length) {
          await client.query(
            `insert into hub.kit_components (kit_item_id, component_item_id, quantity)
             select $1, x.item_id, x.quantity from jsonb_to_recordset($2::jsonb) as x(item_id bigint, quantity numeric)`,
            [itemId, JSON.stringify(components.map((c) => ({ item_id: c.itemId, quantity: c.quantity })))]);
        }
        const { rows } = await client.query(
          "update hub.items set kind = $3, updated_at = now() where id = $1 and tenant_id = $2 returning id, kind",
          [itemId, tenantId, components.length ? "kit" : "simple"]);
        return rows[0] || null;
      });
    },

    /** Auditoria. @param {{ tenantId: string, userId?: string | null, action: string, details?: any }} event */
    async audit({ tenantId, userId = null, action, details = {} }) {
      await db.query("insert into hub.audit_events (tenant_id, user_id, action, details) values ($1, $2, $3, $4)", [tenantId, userId, action, JSON.stringify(details)]);
    },
  };
}

module.exports = { createStockRepository };
