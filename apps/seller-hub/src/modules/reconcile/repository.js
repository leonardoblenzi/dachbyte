// @ts-check
"use strict";

/** Conferência sem sinal de vida há mais que isto é considerada morta. */
const STALE_MINUTES = 30;
/** O mesmo anúncio divergindo esta quantidade de vezes em 24h = outro sistema escrevendo. */
const RECURRING_AFTER = 2;

const RUN_COLUMNS = `id, channel_account_id as "accountId", status, trigger, checked, divergences, overwritten, error_message as "error",
  created_at as "createdAt", started_at as "startedAt", finished_at as "finishedAt"`;

/**
 * Conferência do estoque nos canais, divergências e saúde das contas (schema hub).
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any>, queryOne: (sql: string, params?: unknown[]) => Promise<any>,
 *           transaction: (work: (client: any) => Promise<any>) => Promise<any> }} db
 */
function createReconcileRepository(db) {
  return {
    /** @param {string} tenantId @param {number} accountId */
    async findConnectedAccount(tenantId, accountId) {
      return db.queryOne(
        `select id, channel, stock_sync_mode as "mode" from hub.channel_accounts where id = $1 and tenant_id = $2 and status = 'connected'`, [accountId, tenantId]);
    },

    /** Contas conferidas pelo agendamento: conectadas e em observação ou ativas. */
    async reconcilableAccounts() {
      const { rows } = await db.query(
        `select id, tenant_id as "tenantId" from hub.channel_accounts where status = 'connected' and stock_sync_mode in ('observe','active') order by id`);
      return rows;
    },

    /**
     * Abre uma conferência na fila (devolve a ativa, se houver). Encerra antes a que travou.
     * @param {{ accountId: number, trigger: "manual" | "schedule", userId?: string | null }} input
     */
    async createRun({ accountId, trigger, userId = null }) {
      return db.transaction(async (client) => {
        await client.query(
          `update hub.reconcile_runs set status = 'failed', error_message = 'Conferência interrompida (sem resposta do processamento).', finished_at = now()
            where channel_account_id = $1 and status in ('queued','running') and heartbeat_at < now() - make_interval(mins => $2)`, [accountId, STALE_MINUTES]);
        const inserted = await client.query(
          `insert into hub.reconcile_runs (channel_account_id, trigger, requested_by) values ($1, $2, $3)
           on conflict (channel_account_id) where status in ('queued','running') do nothing returning ${RUN_COLUMNS}`, [accountId, trigger, userId]);
        if (inserted.rows[0]) return { run: inserted.rows[0], created: true };
        const active = await client.query(`select ${RUN_COLUMNS} from hub.reconcile_runs where channel_account_id = $1 and status in ('queued','running')`, [accountId]);
        return { run: active.rows[0] || null, created: false };
      });
    },

    /** @param {number} runId @param {string} tenantId */
    async markRunning(runId, tenantId) {
      return db.queryOne(
        `update hub.reconcile_runs r set status = 'running', started_at = now(), heartbeat_at = now()
           from hub.channel_accounts a
          where r.id = $1 and r.status = 'queued' and a.id = r.channel_account_id and a.tenant_id = $2 and a.status = 'connected'
          returning a.id, a.tenant_id as "tenantId", a.channel, a.external_account_id as "externalAccountId",
                    a.stock_sync_mode as "mode", a.divergence_policy as "policy"`, [runId, tenantId]);
    },

    /**
     * Próximo lote de anúncios a conferir (vinculados, sem Full, sincronização ligada, sem envio aberto),
     * com as vendas e cancelamentos recebidos depois da última vez que o Hub viu o estoque.
     * @param {number} accountId @param {number} afterId @param {number} limit
     */
    async listingsToCheck(accountId, afterId, limit) {
      const { rows } = await db.query(
        `select l.id, l.listing_id as "listingId", l.variation_id as "variationId", l.channel_stock::float as "channelStock",
                l.channel_checked_at as "checkedAt", l.item_id as "itemId",
                coalesce((select sum(ol.quantity) from hub.order_lines ol join hub.channel_orders o on o.id = ol.order_id
                           where o.channel_account_id = l.channel_account_id and ol.listing_id = l.listing_id and ol.variation_id in (l.variation_id, '')
                             and o.status = 'open' and o.received_at > l.channel_checked_at), 0)::float as sold,
                coalesce((select sum(ol.quantity) from hub.order_lines ol join hub.channel_orders o on o.id = ol.order_id
                           where o.channel_account_id = l.channel_account_id and ol.listing_id = l.listing_id and ol.variation_id in (l.variation_id, '')
                             and o.status = 'cancelled' and o.received_at <= l.channel_checked_at and o.updated_at > l.channel_checked_at), 0)::float as restored
           from hub.listings l
          where l.channel_account_id = $1 and l.id > $2 and l.item_id is not null and not l.fulfillment and l.sync_enabled
            and not exists (select 1 from hub.stock_pushes p where p.listing_id = l.id and p.state in ('pending','sending'))
          order by l.id limit $3`, [accountId, afterId, limit]);
      return rows;
    },

    /** Grava o que foi lido no canal. @param {Array<{ id: number, stock: number }>} rows */
    async recordObservations(rows) {
      if (!rows.length) return;
      await db.query(
        `update hub.listings l set channel_stock = x.stock, channel_checked_at = now(), updated_at = now()
           from jsonb_to_recordset($1::jsonb) as x(id bigint, stock numeric) where l.id = x.id`, [JSON.stringify(rows)]);
    },

    /**
     * Registra divergências. É "recorrente" quando o anúncio já divergiu 2 vezes nas últimas 24h.
     * @param {{ tenantId: string, accountId: number, runId: number }} ctx @param {Array<{ listingId: number, expected: number, observed: number }>} rows
     */
    async insertDivergences(ctx, rows) {
      if (!rows.length) return [];
      const { rows: inserted } = await db.query(
        `insert into hub.stock_divergences (tenant_id, listing_id, channel_account_id, run_id, expected, observed, recurring)
         select $1, x.listing_id, $2, $3, x.expected, x.observed,
                (select count(*) from hub.stock_divergences d where d.listing_id = x.listing_id and d.detected_at > now() - interval '24 hours') >= $5
           from jsonb_to_recordset($4::jsonb) as x(listing_id bigint, expected numeric, observed numeric)
         returning id, listing_id as "listingId", recurring`,
        [ctx.tenantId, ctx.accountId, ctx.runId, JSON.stringify(rows.map((r) => ({ listing_id: r.listingId, expected: r.expected, observed: r.observed }))), RECURRING_AFTER]);
      return inserted;
    },

    /** @param {number[]} ids */
    async markOverwritten(ids) {
      if (!ids.length) return;
      await db.query("update hub.stock_divergences set status = 'overwritten', resolved_by = 'hub', resolved_at = now() where id = any($1::bigint[])", [ids]);
    },

    /** @param {number} runId @param {{ checked: number, divergences: number, overwritten: number }} totals */
    async progress(runId, totals) {
      await db.query(
        "update hub.reconcile_runs set checked = $2, divergences = $3, overwritten = $4, heartbeat_at = now() where id = $1 and status = 'running'",
        [runId, totals.checked, totals.divergences, totals.overwritten]);
    },

    /** @param {number} runId @param {{ status: "succeeded" | "failed", checked: number, divergences: number, overwritten: number, error?: string | null }} result */
    async finish(runId, result) {
      await db.transaction(async (client) => {
        const { rows } = await client.query(
          `update hub.reconcile_runs set status = $2, checked = $3, divergences = $4, overwritten = $5, error_message = $6, finished_at = now(), heartbeat_at = now()
            where id = $1 returning channel_account_id`,
          [runId, result.status, result.checked, result.divergences, result.overwritten, result.error || null]);
        if (result.status === "succeeded" && rows[0]) await client.query("update hub.channel_accounts set last_reconciled_at = now() where id = $1", [rows[0].channel_account_id]);
      });
    },

    /** @param {string} tenantId @param {{ status?: string, accountId?: number | null, limit?: number, offset?: number }} [options] */
    async listDivergences(tenantId, { status = "open", accountId = null, limit = 50, offset = 0 } = {}) {
      const { rows } = await db.query(
        `select d.id, d.status, d.recurring, d.expected::float as expected, d.observed::float as observed, d.detected_at as "detectedAt",
                d.resolved_by as "resolvedBy", d.resolved_at as "resolvedAt", a.id as "accountId", a.channel,
                coalesce(a.label, a.external_account_id) as account, a.stock_sync_mode as "accountMode",
                l.id as "listingDbId", l.listing_id as "listingId", l.variation_id as "variationId", l.title, i.sku
           from hub.stock_divergences d
           join hub.channel_accounts a on a.id = d.channel_account_id
           join hub.listings l on l.id = d.listing_id
           left join hub.items i on i.id = l.item_id
          where d.tenant_id = $1 and ($2 = '' or d.status = $2) and ($3::bigint is null or d.channel_account_id = $3)
          order by d.detected_at desc, d.id desc limit $4 offset $5`,
        [tenantId, status, accountId, Math.min(200, Math.max(1, limit)), Math.max(0, offset)]);
      return rows;
    },

    /**
     * Decide uma divergência aberta. Devolve o item e a conta (para reenviar, se for o caso).
     * @param {string} tenantId @param {number} id @param {"overwritten" | "ignored"} status @param {string | null} userId
     * @param {boolean} [requireActive] reenviar só vale para conta ativa
     */
    async resolve(tenantId, id, status, userId, requireActive = false) {
      return db.queryOne(
        `update hub.stock_divergences d set status = $3, resolved_by = $4, resolved_at = now()
           from hub.listings l, hub.channel_accounts a
          where d.id = $1 and d.tenant_id = $2 and d.status = 'open' and l.id = d.listing_id and a.id = d.channel_account_id
            and (not $5 or a.stock_sync_mode = 'active')
          returning d.id, l.item_id as "itemId", a.id as "accountId", a.stock_sync_mode as "accountMode"`, [id, tenantId, status, userId, requireActive]);
    },

    /** Ignora todas as abertas da conta. @param {string} tenantId @param {number} accountId @param {string | null} userId */
    async ignoreAll(tenantId, accountId, userId) {
      const { rowCount } = await db.query(
        `update hub.stock_divergences set status = 'ignored', resolved_by = $3, resolved_at = now()
          where tenant_id = $1 and channel_account_id = $2 and status = 'open'`, [tenantId, accountId, userId]);
      return rowCount || 0;
    },

    /** @param {string} tenantId @param {number} accountId @param {"overwrite" | "alert"} policy */
    async setPolicy(tenantId, accountId, policy) {
      return db.queryOne(
        `update hub.channel_accounts set divergence_policy = $3, updated_at = now() where id = $1 and tenant_id = $2 returning id, divergence_policy as policy`,
        [accountId, tenantId, policy]);
    },

    /** Saúde de cada conta: conexão, leituras, avisos recebidos, envios e divergências. @param {string} tenantId */
    async health(tenantId) {
      const { rows } = await db.query(
        `select a.id, a.channel, coalesce(a.label, a.external_account_id) as label, a.status, a.stock_sync_mode as "mode",
                a.divergence_policy as policy, a.activated_at as "activatedAt", a.last_import_at as "lastImportAt",
                a.orders_synced_at as "ordersSyncedAt", a.last_reconciled_at as "lastReconciledAt", t.expires_at as "tokenExpiresAt",
                (select count(*)::int from hub.webhook_events w where w.channel = a.channel and w.external_account_id = a.external_account_id
                   and w.received_at > now() - interval '24 hours') as "webhooks24h",
                (select count(*)::int from hub.webhook_events w where w.channel = a.channel and w.external_account_id = a.external_account_id
                   and w.status = 'failed' and w.received_at > now() - interval '24 hours') as "webhookFailures24h",
                (select max(w.received_at) from hub.webhook_events w where w.channel = a.channel and w.external_account_id = a.external_account_id) as "lastWebhookAt",
                (select count(*)::int from hub.stock_pushes p where p.channel_account_id = a.id and p.state in ('pending','sending')) as "pushesOpen",
                (select count(*)::int from hub.stock_pushes p where p.channel_account_id = a.id and p.state = 'failed' and p.updated_at > now() - interval '24 hours') as "pushesFailed24h",
                (select count(*)::int from hub.stock_pushes p where p.channel_account_id = a.id and p.state = 'divergent' and p.updated_at > now() - interval '24 hours') as "pushesDivergent24h",
                (select count(*)::int from hub.stock_divergences d where d.channel_account_id = a.id and d.status = 'open') as "divergencesOpen",
                (select count(*)::int from hub.stock_divergences d where d.channel_account_id = a.id and d.status = 'open' and d.recurring) as "divergencesRecurring",
                (select count(*)::int from hub.order_lines ol join hub.channel_orders o on o.id = ol.order_id where o.channel_account_id = a.id and ol.pending_link) as "pendingSales",
                (select json_build_object('id', r.id, 'status', r.status, 'checked', r.checked, 'divergences', r.divergences, 'error', r.error_message, 'finishedAt', r.finished_at)
                   from hub.reconcile_runs r where r.channel_account_id = a.id order by r.id desc limit 1) as "lastRun"
           from hub.channel_accounts a
           left join hub.channel_tokens t on t.channel_account_id = a.id
          where a.tenant_id = $1 and a.status <> 'disconnected'
          order by a.channel, label`, [tenantId]);
      return rows;
    },

    /** @param {{ tenantId: string, userId?: string | null, action: string, details?: any }} event */
    async audit({ tenantId, userId = null, action, details = {} }) {
      await db.query("insert into hub.audit_events (tenant_id, user_id, action, details) values ($1, $2, $3, $4)", [tenantId, userId, action, JSON.stringify(details)]);
    },
  };
}

module.exports = { createReconcileRepository, RECURRING_AFTER, STALE_MINUTES };
