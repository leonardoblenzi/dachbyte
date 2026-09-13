"use strict";

const db = require("../../../../../db/db");

function money(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function statusLabel(status) {
  return ({
    open: "Aberto",
    pending: "Pendente",
    pending_delivery: "Em andamento",
    finalized: "Concluido",
    canceled: "Cancelado",
    in_production: "Em producao",
    sent_to_lab: "Enviado ao laboratorio",
    received_from_lab: "Recebido do laboratorio",
    quality_check: "Conferencia",
    rework: "Retrabalho",
    ready: "Pronto para retirada",
    delivered: "Entregue",
    waiting_part: "Aguardando recurso",
  })[String(status || "").toLowerCase()] || status || "-";
}

function paymentMethodLabel(method) {
  return ({
    cash: "Dinheiro",
    pix: "Pix",
    debit_card: "Cartao de debito",
    credit_card: "Cartao de credito",
    bank_transfer: "Transferencia bancaria",
    store_credit: "Crediario / carne",
    promissory_note: "Nota promissoria",
    check: "Cheque",
    boleto: "Boleto",
  })[String(method || "").toLowerCase()] || method || "Pagamento";
}

function auditPresentation(action, row) {
  const map = {
    "sale.created": ["Venda registrada", "Venda finalizada no PDV"],
    "sale.pending_delivery_created": ["Pedido criado", "Pedido criado para entrega/retirada futura"],
    "sale.delivery_completed": ["Pedido concluido", "Entrega/retirada confirmada"],
    "sale.updated": ["Venda corrigida", "Dados da venda foram atualizados"],
    "sale.canceled": ["Pedido cancelado", row.metadata?.reason || row.after?.cancelReason || "Cancelamento registrado"],
    "receivable.due_date_updated": ["Vencimento corrigido", row.metadata?.reason || "Data de vencimento alterada"],
    "receivable.canceled": ["Recebivel cancelado", row.metadata?.reason || "Parcela cancelada"],
    "optical_order.marked_ready": ["Pedido pronto", "Marcado como pronto para retirada"],
    "optical_order.status_changed": ["Producao atualizada", "Etapa operacional alterada"],
  };
  return map[action] || [String(action || "Evento").replace(/\./g, " "), row.metadata?.reason || "Alteracao registrada"];
}

function historyAccessAllowed(access, key) {
  return !access || access[key] !== false;
}

function isMirroredOpticalWorkflowEvent(row = {}) {
  if (row.workflowKey !== "optical_order" || row.entityType !== "service_order") return false;
  return new Set(["sale_create", "optical_order_sync", "operator_mark_ready", "sale_cancel", "sale_delivery"]).has(row.metadata?.source);
}

function noRows() {
  return Promise.resolve({ rowCount: 0, rows: [] });
}

async function getSaleHistory(companyId, saleId, access = {}) {
  const saleResult = await db.query(`
    select s.id,s.number,s.customer_id as "customerId",c.name as "customerName",s.status,s.total,s.payments,
      s.payment_timing as "paymentTiming",s.promised_delivery_date as "promisedDeliveryDate",s.delivered_at as "deliveredAt",
      s.sold_at as "soldAt",s.canceled_at as "canceledAt",s.cancel_reason as "cancelReason",
      s.created_at as "createdAt",s.updated_at as "updatedAt"
    from volt_core.sales s
    left join volt_core.customers c on c.company_id=s.company_id and c.id=s.customer_id
    where s.company_id=$1 and s.id=$2
    limit 1;
  `, [companyId, saleId]);
  if (!saleResult.rowCount) {
    throw Object.assign(new Error("Pedido nao encontrado"), { statusCode: 404, code: "SALE_NOT_FOUND" });
  }
  const sale = saleResult.rows[0];

  const canInventory = historyAccessAllowed(access, "inventory");
  const canReceivables = historyAccessAllowed(access, "receivables");
  const canReceipts = historyAccessAllowed(access, "receipts");
  const canCash = historyAccessAllowed(access, "cashRegister");
  const canAudit = historyAccessAllowed(access, "audit");

  const [itemsResult, receivablesResult, reservationsResult, inventoryResult, receiptsResult] = await Promise.all([
    db.query(`
      select i.id,i.product_id as "productId",p.name as "productName",p.sku,i.description,i.quantity,
        i.unit_price as "unitPrice",i.discount,i.total
      from volt_core.sale_items i
      left join volt_core.products p on p.company_id=i.company_id and p.id=i.product_id
      where i.company_id=$1 and i.sale_id=$2
      order by i.id;
    `, [companyId, saleId]),
    canReceivables ? db.query(`
      select r.id,r.type,r.status,r.due_date as "dueDate",r.amount,r.paid_amount as "paidAmount",r.description,
        r.metadata,r.created_at as "createdAt",r.updated_at as "updatedAt"
      from volt_core.receivables r
      where r.company_id=$1 and r.sale_id=$2
      order by r.due_date,r.created_at;
    `, [companyId, saleId]) : noRows(),
    canInventory ? db.query(`
      select r.id,r.product_id as "productId",p.name as "productName",p.sku,r.quantity,r.status,
        r.reserved_at as "reservedAt",r.released_at as "releasedAt",r.release_reason as "releaseReason",
        r.actor_user_id as "actorUserId",coalesce(u.name,r.actor_user_id,'Sistema') as actor
      from volt_core.stock_reservations r
      left join volt_core.products p on p.company_id=r.company_id and p.id=r.product_id
      left join volt_core.users u on u.id=r.actor_user_id
      where r.company_id=$1 and r.sale_id=$2
      order by r.reserved_at;
    `, [companyId, saleId]) : noRows(),
    canInventory ? db.query(`
      select m.id,m.product_id as "productId",p.name as "productName",p.sku,m.type,m.quantity,m.reason,
        m.source_type as "sourceType",m.actor_user_id as "actorUserId",coalesce(u.name,m.actor_user_id,'Sistema') as actor,
        coalesce(m.operational_at,m.created_at) as "operationalAt",m.created_at as "createdAt"
      from volt_core.inventory_movements m
      left join volt_core.products p on p.company_id=m.company_id and p.id=m.product_id
      left join volt_core.users u on u.id=m.actor_user_id
      where m.company_id=$1 and m.source_id=$2 and m.source_type in ('sale','sale_reversal')
      order by coalesce(m.operational_at,m.created_at),m.created_at;
    `, [companyId, saleId]) : noRows(),
    canReceipts ? db.query(`
      select id,number,created_at as "createdAt"
      from volt_core.receipts
      where company_id=$1 and sale_id=$2
      order by created_at;
    `, [companyId, saleId]) : noRows(),
  ]);

  const receivableIds = receivablesResult.rows.map((row) => row.id);
  const reservationIds = reservationsResult.rows.map((row) => row.id);

  const [cashResult, auditResult, workflowResult] = await Promise.all([
    canCash ? db.query(`
      select m.id,m.type,m.source_type as "sourceType",m.source_id as "sourceId",m.payment_method as "paymentMethod",
        m.amount,m.description,m.actor_user_id as "actorUserId",coalesce(u.name,m.actor_user_id,'Sistema') as actor,
        coalesce(m.operational_at,m.created_at) as "operationalAt",m.created_at as "createdAt"
      from volt_core.cash_movements m
      left join volt_core.users u on u.id=m.actor_user_id
      where m.company_id=$1 and (
        (m.source_id=$2 and m.source_type in ('sale','sale_edit','sale_edit_reversal','sale_reversal'))
        or (m.source_type='receivable' and m.source_id=any($3::text[]))
      )
      order by coalesce(m.operational_at,m.created_at),m.created_at;
    `, [companyId, saleId, receivableIds]) : noRows(),
    canAudit ? db.query(`
      select a.id,a.actor_user_id as "actorUserId",coalesce(u.name,a.actor_user_id,'Sistema') as actor,a.action,
        a.entity_type as "entityType",a.entity_id as "entityId",a.before_payload as before,a.after_payload as after,
        a.metadata,a.created_at as "createdAt"
      from volt_core.audit_logs a
      left join volt_core.users u on u.id=a.actor_user_id
      where a.company_id=$1 and (
        (a.entity_type='sale' and a.entity_id=$2)
        or a.metadata->>'saleId'=$2
        or (a.entity_type='receivable' and a.entity_id=any($3::text[]))
        or (a.entity_type='stock_reservation' and a.entity_id=any($4::text[]))
      )
      order by a.created_at;
    `, [companyId, saleId, receivableIds, reservationIds]) : noRows(),
    db.query(`
      with related_entities as (
        select distinct entity_type,entity_id
        from volt_core.workflow_events
        where company_id=$1 and metadata->>'saleId'=$2
      )
      select w.id,w.workflow_key as "workflowKey",w.entity_type as "entityType",w.entity_id as "entityId",
        w.from_status as "fromStatus",w.to_status as "toStatus",w.actor_user_id as "actorUserId",
        coalesce(u.name,w.actor_user_id,'Sistema') as actor,w.metadata,w.created_at as "createdAt"
      from volt_core.workflow_events w
      left join volt_core.users u on u.id=w.actor_user_id
      where w.company_id=$1 and (
        w.metadata->>'saleId'=$2
        or exists (
          select 1 from related_entities r
          where r.entity_type=w.entity_type and r.entity_id=w.entity_id
        )
      )
      order by w.created_at;
    `, [companyId, saleId]),
  ]);

  const timeline = [];
  const hasCreateAudit = auditResult.rows.some((row) => ["sale.created", "sale.pending_delivery_created"].includes(row.action));
  if (!hasCreateAudit) {
    timeline.push({
      id: `sale-created:${sale.id}`,
      type: "sale",
      happenedAt: sale.createdAt,
      title: sale.paymentTiming === "delivery" ? "Pedido criado" : "Venda registrada",
      detail: `Total ${money(sale.total).toFixed(2)}`,
      status: sale.status,
      actor: "Sistema",
    });
  }

  for (const row of auditResult.rows) {
    if (["stock.reserved", "stock.reservation_released", "stock.reservation_consumed", "receivable.received"].includes(row.action)) continue;
    const [title, detail] = auditPresentation(row.action, row);
    timeline.push({
      id: `audit:${row.id}`,
      type: "audit",
      happenedAt: row.createdAt,
      title,
      detail,
      status: row.after?.status || row.metadata?.status || null,
      actor: row.actor,
      metadata: row.metadata || {},
    });
  }

  for (const row of workflowResult.rows) {
    if (isMirroredOpticalWorkflowEvent(row)) continue;
    const from = row.fromStatus ? statusLabel(row.fromStatus) : null;
    const to = statusLabel(row.toStatus);
    timeline.push({
      id: `workflow:${row.id}`,
      type: "workflow",
      happenedAt: row.createdAt,
      title: row.fromStatus ? "Etapa atualizada" : "Fluxo operacional iniciado",
      detail: from ? `${from} → ${to}` : to,
      status: row.toStatus,
      actor: row.actor,
      metadata: row.metadata || {},
    });
  }

  for (const row of reservationsResult.rows) {
    timeline.push({
      id: `reservation-created:${row.id}`,
      type: "inventory",
      happenedAt: row.reservedAt,
      title: "Estoque reservado",
      detail: `${row.productName || row.sku || "Produto"} • ${Number(row.quantity || 0)} un.`,
      status: "reserved",
      actor: row.actor,
    });
    if (row.releasedAt) {
      timeline.push({
        id: `reservation-ended:${row.id}`,
        type: "inventory",
        happenedAt: row.releasedAt,
        title: row.status === "consumed" ? "Reserva convertida em saida" : "Reserva liberada",
        detail: `${row.productName || row.sku || "Produto"}${row.releaseReason ? ` • ${row.releaseReason}` : ""}`,
        status: row.status,
        actor: row.actor,
      });
    }
  }

  for (const row of inventoryResult.rows) {
    timeline.push({
      id: `inventory:${row.id}`,
      type: "inventory",
      happenedAt: row.operationalAt,
      title: Number(row.quantity || 0) < 0 ? "Saida fisica do estoque" : "Estoque devolvido",
      detail: `${row.productName || row.sku || "Produto"} • ${Math.abs(Number(row.quantity || 0))} un.${row.reason ? ` • ${row.reason}` : ""}`,
      status: row.sourceType,
      actor: row.actor,
    });
  }

  for (const row of receivablesResult.rows) {
    const installment = Number(row.metadata?.installment || 0);
    const installments = Number(row.metadata?.installments || 0);
    timeline.push({
      id: `receivable:${row.id}`,
      type: "finance",
      happenedAt: row.createdAt,
      title: installment && installments ? `Parcela ${installment}/${installments} criada` : "Recebivel criado",
      detail: `${paymentMethodLabel(row.type)} • vence ${String(row.dueDate || "").slice(0, 10)} • R$ ${money(row.amount).toFixed(2)}`,
      status: row.status,
      receivableId: row.id,
    });
  }

  for (const row of cashResult.rows) {
    timeline.push({
      id: `cash:${row.id}`,
      type: "finance",
      happenedAt: row.operationalAt,
      title: row.type === "entry" ? "Pagamento recebido" : "Estorno financeiro",
      detail: `${paymentMethodLabel(row.paymentMethod)} • R$ ${money(row.amount).toFixed(2)}`,
      status: row.type === "entry" ? "received" : "reversed",
      actor: row.actor,
    });
  }

  for (const row of receiptsResult.rows) {
    timeline.push({
      id: `receipt:${row.id}`,
      type: "document",
      happenedAt: row.createdAt,
      title: `Recibo #${row.number} emitido`,
      detail: "Comprovante da venda gerado",
      status: "issued",
      actor: "Sistema",
    });
  }

  timeline.sort((a, b) => {
    const byDate = String(a.happenedAt || "").localeCompare(String(b.happenedAt || ""));
    return byDate || String(a.id).localeCompare(String(b.id));
  });

  return {
    access: {
      inventory: canInventory,
      receivables: canReceivables,
      receipts: canReceipts,
      cashRegister: canCash,
      audit: canAudit,
    },
    sale: { ...sale, total: money(sale.total) },
    items: itemsResult.rows.map((row) => ({ ...row, quantity: Number(row.quantity || 0), unitPrice: money(row.unitPrice), discount: money(row.discount), total: money(row.total) })),
    receivables: receivablesResult.rows.map((row) => ({ ...row, amount: money(row.amount), paidAmount: money(row.paidAmount) })),
    timeline,
  };
}

module.exports = {
  getSaleHistory,
};
