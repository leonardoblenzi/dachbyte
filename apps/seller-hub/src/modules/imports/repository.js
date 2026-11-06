// @ts-check
"use strict";

/** Execução parada há mais que isto (sem heartbeat) é considerada morta. */
const STALE_MINUTES = 15;

/** @param {string} alias */
const runColumns = (alias) => {
  const p = alias ? `${alias}.` : "";
  return `${p}id, ${p}channel_account_id as "accountId", ${p}status, ${p}trigger, ${p}pages, ${p}listings_seen as "listingsSeen",
    ${p}linked_auto as "linkedAuto", ${p}unlinked, ${p}error_message as "error", ${p}created_at as "createdAt",
    ${p}started_at as "startedAt", ${p}finished_at as "finishedAt"`;
};

/**
 * Execuções de importação (schema hub). Uma ativa por conta, garantida pelo índice uq_hub_import_active.
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any>, queryOne: (sql: string, params?: unknown[]) => Promise<any>,
 *           transaction: (work: (client: any) => Promise<any>) => Promise<any> }} db
 */
function createImportsRepository(db) {
  return {
    /** Conta conectada desta empresa, pronta para importar. @param {string} tenantId @param {number} accountId */
    async findConnectedAccount(tenantId, accountId) {
      return db.queryOne(
        `select id, channel, external_account_id as "externalAccountId" from hub.channel_accounts
          where id = $1 and tenant_id = $2 and status = 'connected'`, [accountId, tenantId]);
    },

    /**
     * Cria uma execução "na fila". Se já houver uma ativa, devolve essa (sem duplicar).
     * Antes, encerra execução presa (worker caiu) para não travar a conta para sempre.
     * @param {{ accountId: number, trigger: "manual" | "connect" | "schedule", userId?: string | null }} input
     * @returns {Promise<{ run: any, created: boolean }>}
     */
    async createRun({ accountId, trigger, userId = null }) {
      return db.transaction(async (client) => {
        await client.query(
          `update hub.import_runs set status = 'failed', error_message = 'Importação interrompida (sem resposta do processamento).', finished_at = now()
            where channel_account_id = $1 and status in ('queued','running') and heartbeat_at < now() - make_interval(mins => $2)`,
          [accountId, STALE_MINUTES]);
        const inserted = await client.query(
          `insert into hub.import_runs (channel_account_id, trigger, requested_by) values ($1, $2, $3)
           on conflict (channel_account_id) where status in ('queued','running') do nothing
           returning ${runColumns("")}`, [accountId, trigger, userId]);
        if (inserted.rows[0]) return { run: inserted.rows[0], created: true };
        const active = await client.query(
          `select ${runColumns("r")} from hub.import_runs r where r.channel_account_id = $1 and r.status in ('queued','running')`, [accountId]);
        return { run: active.rows[0] || null, created: false };
      });
    },

    /**
     * Worker assume a execução (só se ainda estiver na fila e a conta continuar conectada na mesma empresa).
     * @param {number} runId @param {string} tenantId
     */
    async markRunning(runId, tenantId) {
      return db.queryOne(
        `update hub.import_runs r set status = 'running', started_at = now(), heartbeat_at = now()
           from hub.channel_accounts a
          where r.id = $1 and r.status = 'queued' and a.id = r.channel_account_id and a.tenant_id = $2 and a.status = 'connected'
          returning a.id, a.channel, a.external_account_id as "externalAccountId"`, [runId, tenantId]);
    },

    /** @param {number} runId @param {{ pages: number, listingsSeen: number, linkedAuto: number, unlinked: number }} totals */
    async progress(runId, totals) {
      await db.query(
        `update hub.import_runs set pages = $2, listings_seen = $3, linked_auto = $4, unlinked = $5, heartbeat_at = now()
          where id = $1 and status = 'running'`,
        [runId, totals.pages, totals.listingsSeen, totals.linkedAuto, totals.unlinked]);
    },

    /**
     * Encerra a execução; em caso de sucesso registra a data da última importação na conta.
     * @param {number} runId
     * @param {{ status: "succeeded" | "failed", pages: number, listingsSeen: number, linkedAuto: number, unlinked: number, error?: string | null }} result
     */
    async finish(runId, result) {
      await db.transaction(async (client) => {
        const { rows } = await client.query(
          `update hub.import_runs set status = $2, pages = $3, listings_seen = $4, linked_auto = $5, unlinked = $6,
                  error_message = $7, finished_at = now(), heartbeat_at = now()
            where id = $1 returning channel_account_id`,
          [runId, result.status, result.pages, result.listingsSeen, result.linkedAuto, result.unlinked, result.error || null]);
        if (result.status === "succeeded" && rows[0]) {
          await client.query("update hub.channel_accounts set last_import_at = now(), updated_at = now() where id = $1", [rows[0].channel_account_id]);
        }
      });
    },

    /** @param {string} tenantId @param {number} runId */
    async getRun(tenantId, runId) {
      return db.queryOne(
        `select ${runColumns("r")} from hub.import_runs r join hub.channel_accounts a on a.id = r.channel_account_id
          where r.id = $1 and a.tenant_id = $2`, [runId, tenantId]);
    },
  };
}

module.exports = { createImportsRepository, STALE_MINUTES };
