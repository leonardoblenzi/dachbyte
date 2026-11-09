// @ts-check
"use strict";

/** Pedido que ainda precisa sair: situação antes do envio, sem Full, não cancelado. */
const PRE_SHIP = "o.stage in ('new','paid','invoiced','ready_to_ship') and not o.fulfillment and o.status = 'open'";
const ORDER_COLUMNS = `o.id, a.channel, coalesce(a.nickname, a.label, a.external_account_id) as account, o.external_order_id as "orderId", o.stage,
  o.ship_by as "shipBy", o.ordered_at as "orderedAt", o.packed_at as "packedAt", o.packed_by as "packedBy", o.pack_issue as "packIssue",
  o.picking_batch_id as "batchId", o.pickup_id as "pickupId", o.handed_over_at as "handedOverAt", o.tracking_code as "trackingCode",
  o.carrier, o.logistic_type as "logisticType", o.fulfillment,
  coalesce((select sum(ol.quantity) from hub.order_lines ol where ol.order_id = o.id), 0)::float as units`;

/**
 * Expedição: lotes de separação, conferência, fotos e coletas (schema hub).
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any>, queryOne: (sql: string, params?: unknown[]) => Promise<any>,
 *           transaction: (work: (client: any) => Promise<any>) => Promise<any> }} db
 */
function createExpeditionRepository(db) {
  return {
    /** Contadores do painel da expedição. @param {string} tenantId */
    async summary(tenantId) {
      return db.queryOne(
        `select
           count(*) filter (where ${PRE_SHIP} and o.packed_at is null and o.picking_batch_id is null)::int as "toPick",
           count(*) filter (where ${PRE_SHIP} and o.packed_at is null and o.picking_batch_id is not null)::int as "inBatch",
           count(*) filter (where o.packed_at is not null and o.handed_over_at is null and o.status = 'open')::int as packed,
           count(*) filter (where o.packed_at is not null and o.handed_over_at is null and o.pickup_id is null and o.status = 'open')::int as "packedNoPickup",
           count(*) filter (where ${PRE_SHIP} and o.handed_over_at is null and o.ship_by < now())::int as late,
           count(*) filter (where o.pack_issue is not null and o.packed_at is null and o.status = 'open')::int as issues
           from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id
          where a.tenant_id = $1`, [tenantId]);
    },

    /**
     * Fila: pedidos a separar (sem lote), mais urgentes primeiro.
     * @param {string} tenantId @param {{ accountId?: number | null, due?: string, limit?: number }} [options]
     */
    async queue(tenantId, { accountId = null, due = "", limit = 200 } = {}) {
      const { rows } = await db.query(
        `select ${ORDER_COLUMNS},
                (select string_agg(ol.quantity::int || '× ' || coalesce(i.sku, ol.channel_sku, ol.title, ol.listing_id), ', ' order by ol.id)
                   from hub.order_lines ol left join hub.items i on i.id = ol.item_id where ol.order_id = o.id) as summary
           from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id
          where a.tenant_id = $1 and ${PRE_SHIP} and o.packed_at is null and o.picking_batch_id is null
            and ($2::bigint is null or a.id = $2)
            and ($3 = '' or ($3 = 'late' and o.ship_by < now()) or ($3 = 'today' and o.ship_by < now() + interval '24 hours'))
          order by o.ship_by nulls last, o.ordered_at limit $4`, [tenantId, accountId, due, Math.min(1000, Math.max(1, limit))]);
      return rows;
    },

    /** Itens dos pedidos com dados do produto e componentes de kit (para abrir em unidades). @param {string} tenantId @param {number[]} orderIds */
    async orderLines(tenantId, orderIds) {
      if (!orderIds.length) return [];
      const { rows } = await db.query(
        `select ol.order_id as "orderId", ol.id, ol.quantity::float as quantity, ol.item_id as "itemId", i.sku, i.name, i.ean, i.kind,
                ol.channel_sku as "channelSku", ol.title,
                case when i.kind = 'kit' then (select json_agg(json_build_object('itemId', c.id, 'sku', c.sku, 'name', c.name, 'ean', c.ean, 'quantity', k.quantity::float))
                                                 from hub.kit_components k join hub.items c on c.id = k.component_item_id where k.kit_item_id = i.id) end as components
           from hub.order_lines ol
           join hub.channel_orders o on o.id = ol.order_id join hub.channel_accounts a on a.id = o.channel_account_id
           left join hub.items i on i.id = ol.item_id
          where a.tenant_id = $1 and ol.order_id = any($2::bigint[]) order by ol.order_id, ol.id`, [tenantId, orderIds]);
      return rows;
    },

    /** Um pedido (cabeçalho da conferência). @param {string} tenantId @param {number} orderId */
    async getOrder(tenantId, orderId) {
      return db.queryOne(
        `select ${ORDER_COLUMNS}, o.status from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id
          where o.id = $1 and a.tenant_id = $2`, [orderId, tenantId]);
    },

    /**
     * Acha o pedido pelo que foi bipado: número no canal, rastreio, envio, número ou chave da NF.
     * Prefere o que ainda não foi conferido.
     * @param {string} tenantId @param {string} code
     */
    async findOrderByCode(tenantId, code) {
      return db.queryOne(
        `select o.id from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id
          where a.tenant_id = $1 and $2 <> '' and (o.external_order_id = $2 or o.tracking_code = $2 or o.shipment_id = $2 or o.invoice_number = $2 or o.invoice_key = $2)
          order by (o.packed_at is null) desc, o.ordered_at desc limit 1`, [tenantId, String(code || "").trim()]);
    },

    /**
     * Conferência por produto: o pedido mais urgente, ainda não conferido, que é exatamente 1 unidade deste item.
     * @param {string} tenantId @param {string[]} keys código normalizado (SKU e EAN) @param {number | null} batchId
     */
    async findSingleUnitOrder(tenantId, keys, batchId) {
      return db.queryOne(
        `select o.id from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id
          where a.tenant_id = $1 and ${PRE_SHIP} and o.packed_at is null and ($3::bigint is null or o.picking_batch_id = $3)
            and (select sum(ol.quantity) from hub.order_lines ol where ol.order_id = o.id) = 1
            and exists (select 1 from hub.order_lines ol join hub.items i on i.id = ol.item_id
                         where ol.order_id = o.id and i.kind = 'simple' and (i.sku_key = any($2::text[]) or i.ean = any($2::text[])))
          order by o.ship_by nulls last, o.ordered_at limit 1`, [tenantId, keys, batchId]);
    },

    // ───── Lotes ─────
    /** Cria o lote com os pedidos que ainda estão livres (sem lote e sem conferência). @param {string} tenantId @param {number[]} orderIds @param {string | null} userId */
    async createBatch(tenantId, orderIds, userId) {
      return db.transaction(async (client) => {
        const { rows: [batch] } = await client.query("insert into hub.picking_batches (tenant_id, created_by) values ($1, $2) returning id, created_at", [tenantId, userId]);
        const { rowCount } = await client.query(
          `update hub.channel_orders o set picking_batch_id = $1 from hub.channel_accounts a
            where a.id = o.channel_account_id and a.tenant_id = $2 and o.id = any($3::bigint[]) and o.picking_batch_id is null and o.packed_at is null and ${PRE_SHIP}`,
          [batch.id, tenantId, orderIds]);
        if (!rowCount) throw Object.assign(new Error("Nenhum dos pedidos está livre para separar (já em lote ou conferido)."), { status: 409, code: "nothing_to_pick" });
        await client.query(
          `insert into hub.order_events (order_id, kind, note) select o.id, 'expedition', 'Entrou no lote de separação #' || $1::text from hub.channel_orders o where o.picking_batch_id = $1::bigint`, [batch.id]);
        return { id: Number(batch.id), orders: rowCount };
      });
    },
    /** @param {string} tenantId */
    async listBatches(tenantId) {
      const { rows } = await db.query(
        `select b.id, b.status, b.created_by as "createdBy", b.created_at as "createdAt", b.closed_at as "closedAt",
                (select count(*)::int from hub.channel_orders o where o.picking_batch_id = b.id) as orders,
                (select count(*)::int from hub.channel_orders o where o.picking_batch_id = b.id and o.packed_at is not null) as packed
           from hub.picking_batches b where b.tenant_id = $1 and (b.status = 'open' or b.created_at > now() - interval '7 days')
          order by (b.status = 'open') desc, b.id desc limit 50`, [tenantId]);
      return rows;
    },
    /** @param {string} tenantId @param {number} id */
    async getBatch(tenantId, id) {
      const batch = await db.queryOne(
        `select id, status, created_by as "createdBy", created_at as "createdAt", closed_at as "closedAt" from hub.picking_batches where id = $1 and tenant_id = $2`, [id, tenantId]);
      if (!batch) return null;
      const { rows } = await db.query(
        `select ${ORDER_COLUMNS} from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id
          where o.picking_batch_id = $1 order by o.ship_by nulls last, o.id`, [id]);
      return { ...batch, orders: rows };
    },
    /** Fecha o lote; pedidos não conferidos voltam para a fila. @param {string} tenantId @param {number} id */
    async closeBatch(tenantId, id) {
      return db.transaction(async (client) => {
        const { rows: [batch] } = await client.query(
          "update hub.picking_batches set status = 'done', closed_at = now() where id = $1 and tenant_id = $2 and status = 'open' returning id", [id, tenantId]);
        if (!batch) return null;
        const { rowCount } = await client.query("update hub.channel_orders set picking_batch_id = null where picking_batch_id = $1 and packed_at is null", [id]);
        return { id: Number(batch.id), returned: rowCount || 0 };
      });
    },

    // ───── Conferência ─────
    /**
     * Marca como conferido/embalado (uma vez) e guarda a foto, se houver.
     * @param {string} tenantId @param {number} orderId
     * @param {{ userId: string | null, note: string, photo?: { mime: string, content: Buffer } | null }} input
     */
    async packOrder(tenantId, orderId, { userId, note, photo = null }) {
      return db.transaction(async (client) => {
        const { rows: [row] } = await client.query(
          `update hub.channel_orders o set packed_at = now(), packed_by = $3, pack_issue = null, updated_at = now()
             from hub.channel_accounts a
            where o.id = $1 and a.id = o.channel_account_id and a.tenant_id = $2 and o.packed_at is null and ${PRE_SHIP}
            returning o.id, o.packed_at as "packedAt"`, [orderId, tenantId, userId]);
        if (!row) return null;
        let photoId = null;
        if (photo) {
          const { rows: [p] } = await client.query(
            "insert into hub.order_photos (tenant_id, order_id, mime, size_bytes, content, created_by) values ($1, $2, $3, $4, $5, $6) returning id",
            [tenantId, orderId, photo.mime, photo.content.length, photo.content, userId]);
          photoId = Number(p.id);
        }
        await client.query("insert into hub.order_events (order_id, kind, note) values ($1, 'expedition', $2)", [orderId, note.slice(0, 500)]);
        return { ...row, photoId };
      });
    },
    /** Registra um problema na conferência (ex.: falta no estoque). @param {string} tenantId @param {number} orderId @param {string} note @param {string | null} userId */
    async setIssue(tenantId, orderId, note, userId) {
      return db.transaction(async (client) => {
        const { rows: [row] } = await client.query(
          `update hub.channel_orders o set pack_issue = $3, updated_at = now() from hub.channel_accounts a
            where o.id = $1 and a.id = o.channel_account_id and a.tenant_id = $2 and o.packed_at is null returning o.id`, [orderId, tenantId, note.slice(0, 300)]);
        if (!row) return null;
        await client.query("insert into hub.order_events (order_id, kind, note) values ($1, 'expedition', $2)", [orderId, `Problema na conferência: ${note} (${userId || "?"}).`.slice(0, 500)]);
        return row;
      });
    },
    /** Desfaz a conferência (volta a conferir; sai da coleta aberta). @param {string} tenantId @param {number} orderId @param {string | null} userId */
    async unpack(tenantId, orderId, userId) {
      return db.transaction(async (client) => {
        const { rows: [row] } = await client.query(
          `update hub.channel_orders o set packed_at = null, packed_by = null, pickup_id = null, updated_at = now() from hub.channel_accounts a
            where o.id = $1 and a.id = o.channel_account_id and a.tenant_id = $2 and o.packed_at is not null and o.handed_over_at is null returning o.id`, [orderId, tenantId]);
        if (!row) return null;
        await client.query("insert into hub.order_events (order_id, kind, note) values ($1, 'expedition', $2)", [orderId, `Conferência desfeita (${userId || "?"}).`]);
        return row;
      });
    },
    /** @param {string} tenantId @param {number} orderId */
    async listPhotos(tenantId, orderId) {
      const { rows } = await db.query(
        "select id, mime, size_bytes as \"sizeBytes\", created_by as \"createdBy\", created_at as \"createdAt\" from hub.order_photos where tenant_id = $1 and order_id = $2 order by id",
        [tenantId, orderId]);
      return rows;
    },
    /** @param {string} tenantId @param {number} photoId */
    async getPhoto(tenantId, photoId) {
      return db.queryOne("select mime, content from hub.order_photos where id = $1 and tenant_id = $2", [photoId, tenantId]);
    },

    // ───── Coletas ─────
    /** @param {string} tenantId */
    async listPickups(tenantId) {
      const { rows } = await db.query(
        `select p.id, p.carrier, to_char(p.scheduled_for, 'YYYY-MM-DD') as "scheduledFor", p.status, p.created_at as "createdAt", p.closed_at as "closedAt", p.closed_by as "closedBy",
                (select count(*)::int from hub.channel_orders o where o.pickup_id = p.id) as orders
           from hub.pickups p where p.tenant_id = $1 and (p.status = 'open' or p.closed_at > now() - interval '14 days')
          order by (p.status = 'open') desc, p.scheduled_for desc, p.id desc limit 100`, [tenantId]);
      return rows;
    },
    /** @param {string} tenantId @param {{ carrier: string, scheduledFor: string, userId: string | null }} input */
    async createPickup(tenantId, { carrier, scheduledFor, userId }) {
      return db.queryOne(
        `insert into hub.pickups (tenant_id, carrier, scheduled_for, created_by) values ($1, $2, $3, $4)
         returning id, carrier, to_char(scheduled_for, 'YYYY-MM-DD') as "scheduledFor", status`, [tenantId, carrier, scheduledFor, userId]);
    },
    /** @param {string} tenantId @param {number} id */
    async getPickup(tenantId, id) {
      const pickup = await db.queryOne(
        `select id, carrier, to_char(scheduled_for, 'YYYY-MM-DD') as "scheduledFor", status, created_at as "createdAt", closed_at as "closedAt", closed_by as "closedBy"
           from hub.pickups where id = $1 and tenant_id = $2`, [id, tenantId]);
      if (!pickup) return null;
      const { rows } = await db.query(
        `select ${ORDER_COLUMNS} from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id where o.pickup_id = $1 order by o.packed_at, o.id`, [id]);
      return { ...pickup, orders: rows };
    },
    /**
     * Embarque: põe o pedido (já conferido e ainda não entregue) na coleta aberta.
     * @param {string} tenantId @param {number} pickupId @param {number} orderId
     * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
     */
    async attachToPickup(tenantId, pickupId, orderId) {
      return db.transaction(async (client) => {
        const { rows: [p] } = await client.query("select id, status from hub.pickups where id = $1 and tenant_id = $2 for update", [pickupId, tenantId]);
        if (!p || p.status !== "open") return { ok: false, reason: "Coleta fechada ou inexistente." };
        const { rows: [o] } = await client.query(
          `select o.id, o.packed_at, o.handed_over_at, o.pickup_id, o.status from hub.channel_orders o join hub.channel_accounts a on a.id = o.channel_account_id
            where o.id = $1 and a.tenant_id = $2 for update of o`, [orderId, tenantId]);
        if (!o) return { ok: false, reason: "Pedido não encontrado." };
        if (o.status !== "open") return { ok: false, reason: "Pedido cancelado: não embarque." };
        if (!o.packed_at) return { ok: false, reason: "Pedido ainda não foi conferido." };
        if (o.handed_over_at) return { ok: false, reason: "Pedido já foi entregue em outra coleta." };
        if (Number(o.pickup_id) === Number(pickupId)) return { ok: false, reason: "Pedido já está nesta coleta." };
        await client.query("update hub.channel_orders set pickup_id = $2, updated_at = now() where id = $1", [orderId, pickupId]);
        await client.query("insert into hub.order_events (order_id, kind, note) values ($1, 'expedition', $2)", [orderId, `Embarcado na coleta ${pickupId}.`]);
        return { ok: true };
      });
    },
    /** @param {string} tenantId @param {number} pickupId @param {number} orderId */
    async detachFromPickup(tenantId, pickupId, orderId) {
      return db.queryOne(
        `update hub.channel_orders o set pickup_id = null from hub.pickups p
          where o.id = $1 and o.pickup_id = $2 and p.id = o.pickup_id and p.tenant_id = $3 and p.status = 'open' returning o.id`, [orderId, pickupId, tenantId]);
    },
    /** Fecha a coleta: os pedidos ficam como entregues à transportadora. @param {string} tenantId @param {number} id @param {string | null} userId */
    async closePickup(tenantId, id, userId) {
      return db.transaction(async (client) => {
        const { rows: [p] } = await client.query(
          "update hub.pickups set status = 'closed', closed_at = now(), closed_by = $3 where id = $1 and tenant_id = $2 and status = 'open' returning id, carrier", [id, tenantId, userId]);
        if (!p) return null;
        const { rows } = await client.query("update hub.channel_orders set handed_over_at = now(), updated_at = now() where pickup_id = $1 returning id", [id]);
        if (rows.length) {
          await client.query(
            "insert into hub.order_events (order_id, kind, note) select x, 'expedition', $2 from unnest($1::bigint[]) x",
            [rows.map((/** @type {any} */ r) => r.id), `Entregue na coleta ${id} (${p.carrier}).`]);
        }
        return { id: Number(p.id), orders: rows.length };
      });
    },
  };
}

module.exports = { createExpeditionRepository };
