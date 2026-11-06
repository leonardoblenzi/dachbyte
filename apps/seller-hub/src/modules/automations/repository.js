// @ts-check
"use strict";

const RULE_COLUMNS = `r.id, r.name, r.active, r.event, r.event_params as "eventParams", r.conditions, r.actions, r.position,
  r.created_at as "createdAt", r.updated_at as "updatedAt"`;

/**
 * Status internos, etiquetas, regras, execuções e avisos (schema hub).
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any>, queryOne: (sql: string, params?: unknown[]) => Promise<any>,
 *           transaction: (work: (client: any) => Promise<any>) => Promise<any> }} db
 */
function createAutomationsRepository(db) {
  return {
    // ───── Status internos ─────
    /** @param {string} tenantId */
    async listStatuses(tenantId) {
      const { rows } = await db.query(
        `select s.id, s.name, s.color, s.position,
                (select count(*)::int from hub.channel_orders o where o.custom_status_id = s.id) as orders
           from hub.order_statuses s where s.tenant_id = $1 order by s.position, s.id`, [tenantId]);
      return rows;
    },
    /** @param {string} tenantId @param {{ name: string, color: string }} input */
    async createStatus(tenantId, { name, color }) {
      return db.queryOne(
        `insert into hub.order_statuses (tenant_id, name, color, position)
         values ($1, $2, $3, coalesce((select max(position) + 1 from hub.order_statuses where tenant_id = $1), 0))
         on conflict do nothing returning id, name, color, position`, [tenantId, name, color]);
    },
    /** @param {string} tenantId @param {number} id @param {{ name: string, color: string }} input */
    async updateStatus(tenantId, id, { name, color }) {
      return db.queryOne("update hub.order_statuses set name = $3, color = $4 where id = $1 and tenant_id = $2 returning id, name, color, position", [id, tenantId, name, color]);
    },
    /** @param {string} tenantId @param {number} id */
    async deleteStatus(tenantId, id) {
      return db.queryOne("delete from hub.order_statuses where id = $1 and tenant_id = $2 returning id", [id, tenantId]);
    },
    /** Ids de status que pertencem à empresa. @param {string} tenantId @param {number[]} ids */
    async ownedStatusIds(tenantId, ids) {
      if (!ids.length) return new Set();
      const { rows } = await db.query("select id from hub.order_statuses where tenant_id = $1 and id = any($2::bigint[])", [tenantId, ids]);
      return new Set(rows.map((/** @type {any} */ r) => Number(r.id)));
    },

    // ───── Regras ─────
    /** Regras com execuções dos últimos 7 dias. @param {string} tenantId */
    async listRules(tenantId) {
      const { rows } = await db.query(
        `select ${RULE_COLUMNS},
                (select count(*)::int from hub.automation_runs x where x.rule_id = r.id and x.created_at > now() - interval '7 days') as "runs7d",
                (select count(*)::int from hub.automation_runs x where x.rule_id = r.id and x.status = 'failed' and x.created_at > now() - interval '7 days') as "failures7d",
                (select max(x.created_at) from hub.automation_runs x where x.rule_id = r.id) as "lastRunAt"
           from hub.automation_rules r where r.tenant_id = $1 order by r.position, r.id`, [tenantId]);
      return rows;
    },
    /** @param {string} tenantId @param {number} id */
    async getRule(tenantId, id) {
      return db.queryOne(`select ${RULE_COLUMNS} from hub.automation_rules r where r.id = $1 and r.tenant_id = $2`, [id, tenantId]);
    },
    /** @param {string} tenantId @param {any} rule @param {string | null} userId */
    async createRule(tenantId, rule, userId) {
      return db.queryOne(
        `insert into hub.automation_rules (tenant_id, name, active, event, event_params, conditions, actions, position, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, coalesce((select max(position) + 1 from hub.automation_rules where tenant_id = $1), 0), $8)
         returning id`, [tenantId, rule.name, rule.active, rule.event, JSON.stringify(rule.eventParams), JSON.stringify(rule.conditions), JSON.stringify(rule.actions), userId]);
    },
    /** @param {string} tenantId @param {number} id @param {any} rule */
    async updateRule(tenantId, id, rule) {
      return db.queryOne(
        `update hub.automation_rules set name = $3, active = $4, event = $5, event_params = $6, conditions = $7, actions = $8, updated_at = now()
          where id = $1 and tenant_id = $2 returning id`,
        [id, tenantId, rule.name, rule.active, rule.event, JSON.stringify(rule.eventParams), JSON.stringify(rule.conditions), JSON.stringify(rule.actions)]);
    },
    /** @param {string} tenantId @param {number} id @param {boolean} active */
    async setRuleActive(tenantId, id, active) {
      return db.queryOne("update hub.automation_rules set active = $3, updated_at = now() where id = $1 and tenant_id = $2 returning id, active", [id, tenantId, active]);
    },
    /** @param {string} tenantId @param {number} id */
    async deleteRule(tenantId, id) {
      return db.queryOne("delete from hub.automation_rules where id = $1 and tenant_id = $2 returning id", [id, tenantId]);
    },
    /** @param {string} tenantId @param {string} event */
    async activeRulesFor(tenantId, event) {
      const { rows } = await db.query(`select ${RULE_COLUMNS} from hub.automation_rules r where r.tenant_id = $1 and r.event = $2 and r.active order by r.position, r.id`, [tenantId, event]);
      return rows;
    },
    /** Regras de prazo ativas de todas as empresas (varredura periódica). */
    async activeTimeRules() {
      const { rows } = await db.query(
        `select ${RULE_COLUMNS}, r.tenant_id as "tenantId" from hub.automation_rules r where r.active and r.event in ('ship_by_soon','order_late') order by r.id`);
      return rows;
    },
    /**
     * Pedidos no prazo do gatilho: ainda não enviados, com prazo vencido (late) ou vencendo nas próximas N horas (soon).
     * @param {string} tenantId @param {"ship_by_soon" | "order_late"} event @param {number} hours
     */
    async dueOrders(tenantId, event, hours) {
      const { rows } = await db.query(
        `select o.id, o.ship_by as "shipBy" from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id
          where a.tenant_id = $1 and not o.fulfillment and o.stage in ('new','paid','invoiced','ready_to_ship') and o.ship_by is not null
            and (($2 = 'order_late' and o.ship_by < now()) or ($2 = 'ship_by_soon' and o.ship_by >= now() and o.ship_by < now() + make_interval(hours => $3)))
          order by o.ship_by limit 1000`, [tenantId, event, hours]);
      return rows;
    },

    // ───── Pedido (contexto, status, etiquetas, linha do tempo) ─────
    /** O que as condições e o webhook enxergam do pedido. @param {string} tenantId @param {number} orderId */
    async orderContext(tenantId, orderId) {
      return db.queryOne(
        `select o.id, o.external_order_id as "orderId", a.channel, a.id as "accountId", coalesce(a.label, a.external_account_id) as account,
                o.stage, o.channel_status as "channelStatus", o.custom_status_id as "customStatusId", s.name as "customStatus",
                o.logistic_type as "logisticType", o.fulfillment, o.tracking_code is not null as "hasTracking", o.tracking_code as "trackingCode",
                o.invoice_number is not null as "hasInvoice", o.ship_by as "shipBy", o.ordered_at as "orderedAt", o.buyer_state as "buyerState",
                coalesce(o.products_total, o.total, 0)::float as "productsTotal", o.tags,
                coalesce((select sum(ol.quantity) from hub.order_lines ol where ol.order_id = o.id), 0)::float as "itemsCount",
                exists (select 1 from hub.order_lines ol where ol.order_id = o.id and ol.pending_link) as "pendingLink",
                coalesce((select array_agg(distinct coalesce(i.sku, ol.channel_sku)) from hub.order_lines ol left join hub.items i on i.id = ol.item_id
                           where ol.order_id = o.id and coalesce(i.sku, ol.channel_sku) is not null), '{}') as skus
           from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id
           left join hub.order_statuses s on s.id = o.custom_status_id
          where o.id = $1 and a.tenant_id = $2`, [orderId, tenantId]);
    },
    /**
     * Muda o status interno (null limpa). Devolve o nome novo, ou undefined se não mudou.
     * @param {string} tenantId @param {number} orderId @param {number | null} statusId @param {string} source
     */
    async setCustomStatus(tenantId, orderId, statusId, source) {
      return db.transaction(async (client) => {
        const { rows: [row] } = await client.query(
          `update hub.channel_orders o set custom_status_id = $3, custom_status_at = now(), updated_at = now()
             from hub.channel_accounts a
            where o.id = $1 and a.id = o.channel_account_id and a.tenant_id = $2 and o.custom_status_id is distinct from $3::bigint
              and ($3::bigint is null or exists (select 1 from hub.order_statuses s where s.id = $3 and s.tenant_id = $2))
            returning o.id, (select name from hub.order_statuses where id = $3) as name`, [orderId, tenantId, statusId]);
        if (!row) return undefined;
        await client.query("insert into hub.order_events (order_id, kind, note) values ($1, 'custom_status', $2)",
          [orderId, `Status interno: ${row.name || "sem status"} (${source}).`]);
        return row.name || null;
      });
    },
    /** Põe ou tira etiquetas. Devolve true se mudou. @param {string} tenantId @param {number} orderId @param {string[]} add @param {string[]} remove @param {string} source */
    async changeTags(tenantId, orderId, add, remove, source) {
      return db.transaction(async (client) => {
        const { rows: [row] } = await client.query(
          `update hub.channel_orders o set tags = (
              select coalesce(array_agg(distinct t order by t), '{}') from unnest(array_cat(o.tags, $3::text[])) t where not (lower(t) = any($4::text[]))),
              updated_at = now()
             from hub.channel_accounts a where o.id = $1 and a.id = o.channel_account_id and a.tenant_id = $2
           returning o.tags`, [orderId, tenantId, add, remove.map((t) => t.toLowerCase())]);
        if (!row) return false;
        const parts = [add.length ? `+ ${add.join(", ")}` : "", remove.length ? `− ${remove.join(", ")}` : ""].filter(Boolean).join(" · ");
        if (parts) await client.query("insert into hub.order_events (order_id, kind, note) values ($1, 'tags', $2)", [orderId, `Etiquetas: ${parts} (${source}).`]);
        return true;
      });
    },
    /** @param {number} orderId @param {string} note */
    async addAutomationEvent(orderId, note) {
      await db.query("insert into hub.order_events (order_id, kind, note) values ($1, 'automation', $2)", [orderId, note.slice(0, 500)]);
    },

    // ───── Execuções ─────
    /** Reserva a execução (uma por regra + pedido + ocorrência). null = já rodou. */
    async claimRun(/** @type {{ tenantId: string, ruleId: number, orderId: number, event: string, eventKey: string }} */ run) {
      return db.queryOne(
        `insert into hub.automation_runs (tenant_id, rule_id, order_id, event, event_key, status) values ($1, $2, $3, $4, $5, 'done')
         on conflict (rule_id, order_id, event, event_key) do nothing returning id`, [run.tenantId, run.ruleId, run.orderId, run.event, run.eventKey]);
    },
    /** @param {number} runId @param {"done" | "failed"} status @param {any[]} results @param {string | null} error */
    async finishRun(runId, status, results, error) {
      await db.query("update hub.automation_runs set status = $2, results = $3, error = $4 where id = $1", [runId, status, JSON.stringify(results), error]);
    },
    /** @param {string} tenantId @param {number} ruleId @param {number} limit */
    async listRuns(tenantId, ruleId, limit = 50) {
      const { rows } = await db.query(
        `select x.id, x.event, x.status, x.results, x.error, x.created_at as "createdAt", o.id as "orderDbId", o.external_order_id as "orderId"
           from hub.automation_runs x join hub.channel_orders o on o.id = x.order_id
          where x.tenant_id = $1 and x.rule_id = $2 order by x.id desc limit $3`, [tenantId, ruleId, Math.min(200, limit)]);
      return rows;
    },

    // ───── Avisos ─────
    /** @param {{ tenantId: string, title: string, body?: string | null, orderId?: number | null, ruleId?: number | null }} n */
    async createNotification(n) {
      return db.queryOne("insert into hub.notifications (tenant_id, title, body, order_id, rule_id) values ($1, $2, $3, $4, $5) returning id",
        [n.tenantId, n.title.slice(0, 200), n.body ? n.body.slice(0, 1000) : null, n.orderId || null, n.ruleId || null]);
    },
    /** @param {string} tenantId @param {{ unreadOnly?: boolean, limit?: number, offset?: number }} [options] */
    async listNotifications(tenantId, { unreadOnly = false, limit = 50, offset = 0 } = {}) {
      const { rows } = await db.query(
        `select n.id, n.title, n.body, n.read_at as "readAt", n.created_at as "createdAt", o.id as "orderDbId", o.external_order_id as "orderId", r.name as "ruleName"
           from hub.notifications n left join hub.channel_orders o on o.id = n.order_id left join hub.automation_rules r on r.id = n.rule_id
          where n.tenant_id = $1 and (not $2 or n.read_at is null) order by n.id desc limit $3 offset $4`,
        [tenantId, unreadOnly, Math.min(200, Math.max(1, limit)), Math.max(0, offset)]);
      return rows;
    },
    /** @param {string} tenantId */
    async unreadCount(tenantId) {
      return Number((await db.queryOne("select count(*)::int as n from hub.notifications where tenant_id = $1 and read_at is null", [tenantId]))?.n || 0);
    },
    /** Marca como lido (um ou todos). @param {string} tenantId @param {number | null} id */
    async markRead(tenantId, id) {
      const { rowCount } = await db.query("update hub.notifications set read_at = now() where tenant_id = $1 and read_at is null and ($2::bigint is null or id = $2)", [tenantId, id]);
      return rowCount || 0;
    },

    // ───── Segredo dos webhooks ─────
    /** Segredo da empresa (cria no primeiro uso). @param {string} tenantId @param {() => string} generate */
    async webhookSecret(tenantId, generate) {
      const row = await db.queryOne("select webhook_secret as s from hub.tenant_settings where tenant_id = $1", [tenantId]);
      if (row?.s) return String(row.s);
      const secret = generate();
      const saved = await db.queryOne(
        `insert into hub.tenant_settings (tenant_id, webhook_secret) values ($1, $2)
         on conflict (tenant_id) do update set webhook_secret = coalesce(hub.tenant_settings.webhook_secret, excluded.webhook_secret)
         returning webhook_secret as s`, [tenantId, secret]);
      return String(saved.s);
    },
    /** @param {string} tenantId @param {string} secret */
    async rotateWebhookSecret(tenantId, secret) {
      await db.query(`insert into hub.tenant_settings (tenant_id, webhook_secret) values ($1, $2)
                      on conflict (tenant_id) do update set webhook_secret = $2, updated_at = now()`, [tenantId, secret]);
      return secret;
    },

    /** @param {{ tenantId: string, userId?: string | null, action: string, details?: any }} event */
    async audit({ tenantId, userId = null, action, details = {} }) {
      await db.query("insert into hub.audit_events (tenant_id, user_id, action, details) values ($1, $2, $3, $4)", [tenantId, userId, action, JSON.stringify(details)]);
    },
  };
}

module.exports = { createAutomationsRepository };
