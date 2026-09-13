"use strict";

const db = require("../../../../../db/db");

const CLOSED_RECEIVABLE_STATUSES = new Set(["paid", "received", "compensated", "canceled"]);

function money(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function receivableStatus(row) {
  const balance = money(Number(row.amount || 0) - Number(row.paidAmount || 0));
  const raw = String(row.status || "open").toLowerCase();
  if (raw === "canceled") return "canceled";
  if (CLOSED_RECEIVABLE_STATUSES.has(raw) || balance <= 0.009) return "paid";
  const due = String(row.dueDate || "").slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  if (due && due < today) return "overdue";
  if (Number(row.paidAmount || 0) > 0 || raw === "partial") return "partial";
  return "open";
}

function installmentLabel(metadata = {}) {
  const current = Number(metadata.installment || metadata.installmentNumber || 0);
  const total = Number(metadata.installments || metadata.installmentCount || 0);
  return current && total ? `${current}/${total}` : null;
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

function accessAllowed(access, key) {
  return !access || access[key] !== false;
}

function emptyResult(row = {}) {
  return Promise.resolve({ rowCount: 1, rows: [row] });
}

async function getCustomerAccount(companyId, customerId, access = {}) {
  const customerResult = await db.query(`
    select id, number, name, phone, document, email, address, notes, active,
      created_at as "createdAt", updated_at as "updatedAt"
    from volt_core.customers
    where company_id=$1 and id=$2
    limit 1;
  `, [companyId, customerId]);
  if (!customerResult.rowCount) {
    throw Object.assign(new Error("Cliente nao encontrado"), { statusCode: 404, code: "CUSTOMER_NOT_FOUND" });
  }

  const canSales = accessAllowed(access, "sales");
  const canReceivables = accessAllowed(access, "receivables");
  const canReceivablesWrite = accessAllowed(access, "receivablesWrite");
  const canCash = accessAllowed(access, "cashRegister");
  const canReceipts = accessAllowed(access, "receipts");

  const [salesAgg, receivableAgg, paymentAgg, salesResult, receivablesResult, paymentsResult, receiptsResult] = await Promise.all([
    canSales ? db.query(`
      select
        count(*) filter (where status <> 'canceled')::int as "saleCount",
        coalesce(sum(total) filter (where status <> 'canceled'),0)::numeric as "totalPurchased",
        coalesce(sum(total) filter (where status='pending_delivery'),0)::numeric as "pendingDeliveryBalance",
        count(*) filter (where status='pending_delivery')::int as "pendingDeliveryCount",
        max(sold_at) filter (where status <> 'canceled') as "lastPurchaseAt"
      from volt_core.sales
      where company_id=$1 and customer_id=$2;
    `, [companyId, customerId]) : emptyResult({ saleCount: null, totalPurchased: null, pendingDeliveryBalance: null, pendingDeliveryCount: null, lastPurchaseAt: null }),
    canReceivables ? db.query(`
      select
        coalesce(sum(amount-paid_amount) filter (where status not in ('paid','received','compensated','canceled')),0)::numeric as "receivableOpenBalance",
        coalesce(sum(amount-paid_amount) filter (
          where status not in ('paid','received','compensated','canceled') and amount-paid_amount>0 and due_date<current_date
        ),0)::numeric as "overdueBalance",
        count(*) filter (
          where status not in ('paid','received','compensated','canceled') and amount-paid_amount>0 and due_date<current_date
        )::int as "overdueCount",
        count(*) filter (
          where status not in ('paid','received','compensated','canceled') and amount-paid_amount>0
        )::int as "openCount",
        min(due_date) filter (
          where status not in ('paid','received','compensated','canceled') and amount-paid_amount>0 and due_date>=current_date
        ) as "nextDueDate"
      from volt_core.receivables
      where company_id=$1 and customer_id=$2;
    `, [companyId, customerId]) : emptyResult({ receivableOpenBalance: null, overdueBalance: null, overdueCount: null, openCount: null, nextDueDate: null }),
    canCash ? db.query(`
      with customer_movements as (
        select m.type,m.amount,coalesce(m.operational_at,m.created_at) as happened_at
        from volt_core.cash_movements m
        join volt_core.sales s on s.company_id=m.company_id and s.id=m.source_id and s.customer_id=$2
        where m.company_id=$1 and m.source_type in ('sale','sale_edit','sale_edit_reversal','sale_reversal')
        union all
        select m.type,m.amount,coalesce(m.operational_at,m.created_at) as happened_at
        from volt_core.cash_movements m
        join volt_core.receivables r on r.company_id=m.company_id and r.id=m.source_id and r.customer_id=$2
        where m.company_id=$1 and m.source_type='receivable'
      )
      select
        coalesce(sum(case when type='entry' then amount else -amount end),0)::numeric as "totalReceived",
        max(happened_at) filter (where type='entry') as "lastPaymentAt"
      from customer_movements;
    `, [companyId, customerId]) : emptyResult({ totalReceived: null, lastPaymentAt: null }),
    canSales ? db.query(`
      select s.id,s.number,s.status,s.subtotal,s.discount_total as "discountTotal",s.total,s.payments,s.notes,
        s.payment_timing as "paymentTiming",s.promised_delivery_date as "promisedDeliveryDate",s.delivered_at as "deliveredAt",
        s.sold_at as "soldAt",s.created_at as "createdAt",
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'productId',si.product_id,'description',si.description,'quantity',si.quantity,
            'unitPrice',si.unit_price,'discount',si.discount,'total',si.total
          ) order by si.id)
          from volt_core.sale_items si
          where si.company_id=s.company_id and si.sale_id=s.id
        ),'[]'::jsonb) as items
      from volt_core.sales s
      where s.company_id=$1 and s.customer_id=$2
      order by s.sold_at desc,s.created_at desc
      limit 60;
    `, [companyId, customerId]) : Promise.resolve({ rowCount: 0, rows: [] }),
    canReceivables ? db.query(`
      select r.id,r.sale_id as "saleId",s.number as "saleNumber",r.type,r.status,r.due_date as "dueDate",
        r.amount,r.paid_amount as "paidAmount",r.description,r.metadata,r.created_at as "createdAt",r.updated_at as "updatedAt"
      from volt_core.receivables r
      left join volt_core.sales s on s.company_id=r.company_id and s.id=r.sale_id
      where r.company_id=$1 and r.customer_id=$2
      order by r.due_date desc,r.created_at desc
      limit 160;
    `, [companyId, customerId]) : Promise.resolve({ rowCount: 0, rows: [] }),
    canCash ? db.query(`
      select m.id,m.type,m.source_type as "sourceType",m.source_id as "sourceId",m.payment_method as "paymentMethod",
        m.amount,m.description,m.actor_user_id as "actorUserId",coalesce(u.name,m.actor_user_id,'Sistema') as actor,
        coalesce(m.operational_at,m.created_at) as "operationalAt",m.created_at as "createdAt",
        coalesce(s1.id,s2.id) as "saleId",coalesce(s1.number,s2.number) as "saleNumber",
        r.id as "receivableId"
      from volt_core.cash_movements m
      left join volt_core.sales s1 on s1.company_id=m.company_id and s1.id=m.source_id
        and m.source_type in ('sale','sale_edit','sale_edit_reversal','sale_reversal') and s1.customer_id=$2
      left join volt_core.receivables r on r.company_id=m.company_id and r.id=m.source_id
        and m.source_type='receivable' and r.customer_id=$2
      left join volt_core.sales s2 on s2.company_id=r.company_id and s2.id=r.sale_id
      left join volt_core.users u on u.id=m.actor_user_id
      where m.company_id=$1 and (s1.id is not null or r.id is not null)
      order by coalesce(m.operational_at,m.created_at) desc,m.created_at desc
      limit 160;
    `, [companyId, customerId]) : Promise.resolve({ rowCount: 0, rows: [] }),
    canReceipts ? db.query(`
      select r.id,r.number,r.sale_id as "saleId",r.html,r.payload,r.created_at as "createdAt",
        s.number as "saleNumber",s.total
      from volt_core.receipts r
      join volt_core.sales s on s.company_id=r.company_id and s.id=r.sale_id
      where r.company_id=$1 and s.customer_id=$2
      order by r.created_at desc
      limit 80;
    `, [companyId, customerId]) : Promise.resolve({ rowCount: 0, rows: [] }),
  ]);

  const salesSummary = salesAgg.rows[0] || {};
  const financialSummary = receivableAgg.rows[0] || {};
  const paymentsSummary = paymentAgg.rows[0] || {};
  const receivableOpenBalance = canReceivables ? money(financialSummary.receivableOpenBalance) : 0;
  const pendingDeliveryBalance = canSales ? money(salesSummary.pendingDeliveryBalance) : 0;
  const openBalance = money(receivableOpenBalance + pendingDeliveryBalance);

  const receivables = receivablesResult.rows.map((row) => ({
    ...row,
    amount: money(row.amount),
    paidAmount: money(row.paidAmount),
    balanceAmount: money(Number(row.amount || 0) - Number(row.paidAmount || 0)),
    installment: installmentLabel(row.metadata || {}),
    displayStatus: receivableStatus(row),
  }));

  const payments = paymentsResult.rows.map((row) => ({
    ...row,
    amount: money(row.amount),
    methodLabel: paymentMethodLabel(row.paymentMethod),
  }));

  const receipts = receiptsResult.rows.map((row) => ({
    id: `RC-${row.number}`,
    receiptId: row.id,
    number: row.number,
    saleId: row.saleId,
    saleNumber: row.saleNumber,
    sale: row.saleNumber ? `#${row.saleNumber}` : "-",
    total: money(row.total || row.payload?.total),
    status: "Emitido",
    html: row.html || "",
    payload: row.payload || {},
    createdAt: row.createdAt,
  }));

  const timeline = [
    ...salesResult.rows.map((sale) => ({
      id: `sale:${sale.id}`,
      type: "sale",
      happenedAt: sale.createdAt,
      title: `Pedido #${sale.number}`,
      detail: sale.status === "canceled" ? "Pedido cancelado" : sale.status === "finalized" ? "Venda/pedido registrado" : "Pedido criado e em andamento",
      amount: money(sale.total),
      status: sale.status === "canceled"
        ? "canceled"
        : sale.paymentTiming === "delivery" && sale.status === "pending_delivery"
          ? "pending_delivery"
          : sale.status === "finalized"
            ? "finalized"
            : sale.status,
      saleId: sale.id,
      saleNumber: sale.number,
    })),
    ...receivables.map((row) => ({
      id: `receivable:${row.id}`,
      type: "receivable",
      happenedAt: row.createdAt,
      title: row.installment ? `Parcela ${row.installment} criada` : "Recebivel criado",
      detail: `${paymentMethodLabel(row.type)}${row.dueDate ? ` • vence em ${String(row.dueDate).slice(0, 10)}` : ""}`,
      amount: row.amount,
      status: row.displayStatus,
      saleId: row.saleId,
      saleNumber: row.saleNumber,
      receivableId: row.id,
    })),
    ...payments.map((row) => ({
      id: `payment:${row.id}`,
      type: row.type === "entry" ? "payment" : "refund",
      happenedAt: row.operationalAt,
      title: row.type === "entry" ? "Pagamento recebido" : "Estorno / saida financeira",
      detail: `${row.methodLabel}${row.saleNumber ? ` • Pedido #${row.saleNumber}` : ""}`,
      amount: row.type === "entry" ? row.amount : -row.amount,
      status: row.type === "entry" ? "received" : "reversed",
      saleId: row.saleId,
      saleNumber: row.saleNumber,
      receivableId: row.receivableId,
      actor: row.actor,
    })),
  ].filter((item) => item.happenedAt).sort((a, b) => String(b.happenedAt).localeCompare(String(a.happenedAt))).slice(0, 220);

  return {
    customer: customerResult.rows[0],
    access: {
      sales: canSales,
      receivables: canReceivables,
      receivablesWrite: canReceivablesWrite,
      cashRegister: canCash,
      receipts: canReceipts,
    },
    summary: {
      saleCount: canSales ? Number(salesSummary.saleCount || 0) : null,
      totalPurchased: canSales ? money(salesSummary.totalPurchased) : null,
      totalReceived: canCash ? money(paymentsSummary.totalReceived) : null,
      openBalance: canSales || canReceivables ? openBalance : null,
      receivableOpenBalance: canReceivables ? receivableOpenBalance : null,
      pendingDeliveryBalance: canSales ? pendingDeliveryBalance : null,
      pendingDeliveryCount: canSales ? Number(salesSummary.pendingDeliveryCount || 0) : null,
      overdueBalance: canReceivables ? money(financialSummary.overdueBalance) : null,
      overdueCount: canReceivables ? Number(financialSummary.overdueCount || 0) : null,
      openCount: canReceivables ? Number(financialSummary.openCount || 0) : null,
      lastPurchaseAt: canSales ? salesSummary.lastPurchaseAt || null : null,
      lastPaymentAt: canCash ? paymentsSummary.lastPaymentAt || null : null,
      nextDueDate: canReceivables ? financialSummary.nextDueDate || null : null,
    },
    sales: salesResult.rows.map((row) => ({ ...row, total: money(row.total) })),
    receivables,
    payments,
    receipts,
    timeline,
  };
}

module.exports = {
  getCustomerAccount,
};
