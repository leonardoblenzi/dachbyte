// @ts-check
"use strict";

/** Arquivos de etiqueta ficam guardados por este tempo (reimpressão sem pedir de novo ao canal). */
const KEEP_DAYS = 7;

/**
 * Etiquetas de envio (schema hub).
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any>, queryOne: (sql: string, params?: unknown[]) => Promise<any>,
 *           transaction: (work: (client: any) => Promise<any>) => Promise<any> }} db
 */
function createLabelsRepository(db) {
  return {
    /** O que cada canal precisa para gerar a etiqueta. @param {string} tenantId @param {number[]} orderIds */
    async refsForOrders(tenantId, orderIds) {
      const { rows } = await db.query(
        `select o.id, a.id as "accountId", a.channel, coalesce(a.label, a.external_account_id) as account, o.external_order_id as "orderId",
                o.shipment_id as "shipmentId", o.tracking_code as "trackingCode", o.channel_refs as refs, o.stage, o.status, o.fulfillment
           from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id
          where a.tenant_id = $1 and o.id = any($2::bigint[]) and a.status = 'connected' order by a.id, o.id`, [tenantId, orderIds]);
      return rows;
    },

    /** @param {{ tenantId: string, format: string, orders: number, userId: string | null }} input */
    async createBatch({ tenantId, format, orders, userId }) {
      return db.queryOne("insert into hub.label_batches (tenant_id, format, orders, created_by) values ($1, $2, $3, $4) returning id", [tenantId, format, orders, userId]);
    },
    /** @param {number} batchId @param {any[]} failures */
    async setFailures(batchId, failures) {
      await db.query("update hub.label_batches set failures = $2 where id = $1", [batchId, JSON.stringify(failures)]);
    },
    /**
     * @param {{ batchId: number, tenantId: string, accountId: number, channel: string, filename: string, contentType: string, content: Buffer, orders: number }} file
     */
    async addFile(file) {
      return db.queryOne(
        `insert into hub.label_files (batch_id, tenant_id, channel_account_id, channel, filename, content_type, size_bytes, content, orders)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [file.batchId, file.tenantId, file.accountId, file.channel, file.filename, file.contentType, file.content.length, file.content, file.orders]);
    },

    /**
     * Marca as etiquetas impressas, grava o rastreio devolvido pelo canal e registra na linha do tempo.
     * @param {Array<{ id: number, trackingCode?: string | null }>} printed @param {string} note
     */
    async markPrinted(printed, note) {
      if (!printed.length) return;
      await db.transaction(async (client) => {
        await client.query(
          `update hub.channel_orders o set label_printed_at = now(), label_prints = label_prints + 1,
                  tracking_code = coalesce(x.tracking, o.tracking_code), updated_at = now()
             from jsonb_to_recordset($1::jsonb) as x(id bigint, tracking text) where o.id = x.id`,
          [JSON.stringify(printed.map((p) => ({ id: p.id, tracking: p.trackingCode || null })))]);
        await client.query("insert into hub.order_events (order_id, kind, note) select x, 'expedition', $2 from unnest($1::bigint[]) x", [printed.map((p) => p.id), note]);
      });
    },

    /** Lotes recentes com os arquivos (sem o conteúdo). @param {string} tenantId */
    async listBatches(tenantId) {
      const { rows } = await db.query(
        `select b.id, b.format, b.orders, b.failures, b.created_by as "createdBy", b.created_at as "createdAt",
                coalesce((select json_agg(json_build_object('id', f.id, 'channel', f.channel, 'filename', f.filename, 'orders', f.orders, 'sizeBytes', f.size_bytes,
                  'account', (select coalesce(a.label, a.external_account_id) from hub.channel_accounts a where a.id = f.channel_account_id)) order by f.id)
                  from hub.label_files f where f.batch_id = b.id), '[]') as files
           from hub.label_batches b where b.tenant_id = $1 and b.created_at > now() - make_interval(days => $2)
          order by b.id desc limit 30`, [tenantId, KEEP_DAYS]);
      return rows;
    },
    /** @param {string} tenantId @param {number} batchId */
    async getBatch(tenantId, batchId) {
      return (await this.listBatches(tenantId)).find((/** @type {any} */ b) => Number(b.id) === Number(batchId)) || null;
    },
    /** @param {string} tenantId @param {number} fileId */
    async getFile(tenantId, fileId) {
      return db.queryOne("select filename, content_type as \"contentType\", content from hub.label_files where id = $1 and tenant_id = $2", [fileId, tenantId]);
    },
    /** Apaga arquivos com mais de 7 dias. */
    async cleanup() {
      const { rowCount } = await db.query("delete from hub.label_batches where created_at < now() - make_interval(days => $1)", [KEEP_DAYS]);
      return rowCount || 0;
    },
  };
}

module.exports = { createLabelsRepository, KEEP_DAYS };
