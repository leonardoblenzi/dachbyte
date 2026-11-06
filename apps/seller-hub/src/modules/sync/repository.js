// @ts-check
"use strict";

const PUSH_COLUMNS = `p.id, p.listing_id as "listingDbId", p.channel_account_id as "accountId", p.desired::float as desired, p.previous::float as previous,
  p.observed::float as observed, p.followup::float as followup, p.reason, p.state, p.attempts, p.error, p.created_at as "createdAt",
  p.sent_at as "sentAt", p.verified_at as "verifiedAt"`;

/**
 * Envios de estoque, pausa geral e ativação (schema hub).
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any>, queryOne: (sql: string, params?: unknown[]) => Promise<any>,
 *           transaction: (work: (client: any) => Promise<any>) => Promise<any> }} db
 */
function createSyncRepository(db) {
  return {
    /** @param {string} tenantId */
    async getSettings(tenantId) {
      return (await db.queryOne(
        `select stock_paused as "paused", paused_by as "pausedBy", paused_at as "pausedAt" from hub.tenant_settings where tenant_id = $1`, [tenantId]))
        || { paused: false, pausedBy: null, pausedAt: null };
    },

    /** @param {string} tenantId @param {boolean} paused @param {string | null} userId */
    async setPaused(tenantId, paused, userId) {
      await db.query(
        `insert into hub.tenant_settings (tenant_id, stock_paused, paused_by, paused_at) values ($1, $2, $3, case when $2 then now() end)
         on conflict (tenant_id) do update set stock_paused = $2, paused_by = $3, paused_at = case when $2 then now() end, updated_at = now()`,
        [tenantId, paused, userId]);
    },

    /** Kits que usam algum dos itens (venda de componente muda o disponível do kit). @param {string} tenantId @param {number[]} itemIds */
    async kitsContaining(tenantId, itemIds) {
      const { rows } = await db.query(
        `select distinct k.kit_item_id as id from hub.kit_components k join hub.items i on i.id = k.kit_item_id
          where i.tenant_id = $1 and k.component_item_id = any($2::bigint[])`, [tenantId, itemIds]);
      return rows.map((/** @type {any} */ r) => Number(r.id));
    },

    /**
     * Cria ou atualiza o envio aberto de cada anúncio. Pendente: troca o valor. Em andamento: guarda o
     * novo valor como "followup" (vira o próximo envio quando o atual terminar).
     * @param {string} tenantId @param {Array<{ listingDbId: number, accountId: number, desired: number, previous: number | null, reason: string }>} rows
     * @returns {Promise<number[]>} contas com envio a processar
     */
    async upsertPushes(tenantId, rows) {
      if (!rows.length) return [];
      const payload = JSON.stringify(rows.map((r) => ({ listing_id: r.listingDbId, account_id: r.accountId, desired: r.desired, previous: r.previous, reason: r.reason })));
      await db.query(
        `update hub.stock_pushes p set followup = x.desired, updated_at = now()
           from jsonb_to_recordset($1::jsonb) as x(listing_id bigint, desired numeric)
          where p.listing_id = x.listing_id and p.state = 'sending'`, [payload]);
      await db.query(
        `insert into hub.stock_pushes (tenant_id, listing_id, channel_account_id, desired, previous, reason)
         select $1, x.listing_id, x.account_id, x.desired, x.previous, x.reason
           from jsonb_to_recordset($2::jsonb) as x(listing_id bigint, account_id bigint, desired numeric, previous numeric, reason text)
          where not exists (select 1 from hub.stock_pushes s where s.listing_id = x.listing_id and s.state = 'sending')
         on conflict (listing_id) where state in ('pending','sending') do update set
           desired = excluded.desired, reason = excluded.reason, updated_at = now()`,
        [tenantId, payload]);
      return [...new Set(rows.map((r) => Number(r.accountId)))];
    },

    /** Estado da conta para decidir se envia. @param {number} accountId */
    async getAccountState(accountId) {
      return db.queryOne(
        `select a.id, a.tenant_id as "tenantId", a.channel, a.external_account_id as "externalAccountId", a.status,
                a.stock_sync_mode as "mode", coalesce(s.stock_paused, false) as paused
           from hub.channel_accounts a left join hub.tenant_settings s on s.tenant_id = a.tenant_id where a.id = $1`, [accountId]);
    },

    /** @param {string} tenantId @param {number} accountId @param {string | null} userId */
    async activate(tenantId, accountId, userId) {
      return db.queryOne(
        `update hub.channel_accounts set stock_sync_mode = 'active', activated_at = now(), activated_by = $3, updated_at = now()
          where id = $1 and tenant_id = $2 and status = 'connected' returning id, channel`, [accountId, tenantId, userId]);
    },

    /**
     * Pega um lote de envios pendentes da conta (trava a linha; dois workers não enviam o mesmo).
     * @param {number} accountId @param {number} limit
     */
    async claimPending(accountId, limit) {
      const { rows } = await db.query(
        `update hub.stock_pushes p set state = 'sending', attempts = attempts + 1, sent_at = now(), updated_at = now()
           from hub.listings l
          where p.id in (select id from hub.stock_pushes where channel_account_id = $1 and state = 'pending' order by id limit $2 for update skip locked)
            and l.id = p.listing_id
          returning ${PUSH_COLUMNS}, l.listing_id as "listingId", l.variation_id as "variationId", l.fulfillment, l.item_id as "itemId"`,
        [accountId, limit]);
      return rows;
    },

    /**
     * Encerra o envio. Verificado ou divergente: grava o valor lido no anúncio. Havendo valor novo
     * (followup) diferente do enviado, abre o próximo envio.
     * @param {number} pushId @param {{ state: "verified" | "divergent" | "failed" | "skipped", observed?: number | null, error?: string | null }} result
     */
    async finish(pushId, result) {
      return db.transaction(async (client) => {
        const { rows: [push] } = await client.query(
          `update hub.stock_pushes set state = $2, observed = $3, error = $4, updated_at = now(),
                  verified_at = case when $2 in ('verified','divergent') then now() else verified_at end
            where id = $1 returning tenant_id, listing_id, channel_account_id, desired, followup`,
          [pushId, result.state, result.observed ?? null, result.error ? String(result.error).slice(0, 500) : null]);
        if (!push) return null;
        if (result.state === "verified" || result.state === "divergent") {
          await client.query(
            `update hub.listings set channel_stock = coalesce($2, channel_stock), last_pushed_stock = $3, last_pushed_at = now(), updated_at = now() where id = $1`,
            [push.listing_id, result.observed ?? null, push.desired]);
        }
        if (push.followup != null && Number(push.followup) !== Number(push.desired) && result.state !== "skipped") {
          await client.query(
            `insert into hub.stock_pushes (tenant_id, listing_id, channel_account_id, desired, previous, reason)
             values ($1, $2, $3, $4, $5, 'novo valor durante o envio') on conflict do nothing`,
            [push.tenant_id, push.listing_id, push.channel_account_id, push.followup, result.observed ?? push.desired]);
          return { followup: true };
        }
        return { followup: false };
      });
    },

    /** Volta para a fila (erro temporário). @param {number} pushId @param {string} error */
    async requeue(pushId, error) {
      await db.query("update hub.stock_pushes set state = 'pending', error = $2, updated_at = now() where id = $1", [pushId, String(error).slice(0, 500)]);
    },

    /** Cancela os pendentes da conta (conta desativada ou desconectada). @param {number} accountId @param {string} reason */
    async skipPending(accountId, reason) {
      const { rowCount } = await db.query(
        "update hub.stock_pushes set state = 'skipped', error = $2, updated_at = now() where channel_account_id = $1 and state = 'pending'", [accountId, reason]);
      return rowCount || 0;
    },

    /** @param {string | null} tenantId */
    async accountsWithPending(tenantId) {
      const { rows } = await db.query(
        `select distinct channel_account_id as id from hub.stock_pushes where state = 'pending' and ($1::text is null or tenant_id = $1)`, [tenantId]);
      return rows.map((/** @type {any} */ r) => Number(r.id));
    },

    /** @param {string} tenantId @param {{ state?: string, accountId?: number | null, limit?: number, offset?: number }} [options] */
    async listPushes(tenantId, { state = "", accountId = null, limit = 50, offset = 0 } = {}) {
      const [list, summary] = await Promise.all([
        db.query(
          `select ${PUSH_COLUMNS}, a.channel, coalesce(a.label, a.external_account_id) as account, l.listing_id as "listingId",
                  l.variation_id as "variationId", l.title, i.sku
             from hub.stock_pushes p
             join hub.channel_accounts a on a.id = p.channel_account_id
             join hub.listings l on l.id = p.listing_id
             left join hub.items i on i.id = l.item_id
            where p.tenant_id = $1 and ($2 = '' or p.state = $2) and ($3::bigint is null or p.channel_account_id = $3)
            order by p.id desc limit $4 offset $5`,
          [tenantId, state, accountId, Math.min(200, Math.max(1, limit)), Math.max(0, offset)]),
        db.query(
          `select state, count(*)::int as n from hub.stock_pushes
            where tenant_id = $1 and (state in ('pending','sending') or updated_at > now() - interval '24 hours') group by state`, [tenantId]),
      ]);
      return { pushes: list.rows, summary: Object.fromEntries(summary.rows.map((/** @type {any} */ r) => [r.state, r.n])) };
    },

    /** Reenvio manual de envio que falhou ou divergiu (se não houver outro aberto). @param {string} tenantId @param {number} pushId */
    async retry(tenantId, pushId) {
      return db.queryOne(
        `insert into hub.stock_pushes (tenant_id, listing_id, channel_account_id, desired, previous, reason)
         select p.tenant_id, p.listing_id, p.channel_account_id, p.desired, p.observed, 'reenvio manual'
           from hub.stock_pushes p where p.id = $1 and p.tenant_id = $2 and p.state in ('failed','divergent')
         on conflict do nothing returning id, channel_account_id as "accountId"`, [pushId, tenantId]);
    },

    /** @param {{ tenantId: string, userId?: string | null, action: string, details?: any }} event */
    async audit({ tenantId, userId = null, action, details = {} }) {
      await db.query("insert into hub.audit_events (tenant_id, user_id, action, details) values ($1, $2, $3, $4)", [tenantId, userId, action, JSON.stringify(details)]);
    },
  };
}

module.exports = { createSyncRepository };
