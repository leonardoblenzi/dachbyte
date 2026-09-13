"use strict";

const db = require("../../../../../db/db");
const { getCashSummary } = require("./cashService");
const { extensionRegistry } = require("../../../../platform/extensions/extensionRegistry");

function money(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

async function getDashboard(companyId, configuration = {}) {
  const enabled = new Set(configuration.modules || []);
  const has = (moduleKey) => enabled.has(moduleKey);
  const cashSummaryPromise = has("cash_register") ? getCashSummary(companyId) : Promise.resolve({ status: "closed", balance: 0 });

  const [
    counts,
    salesToday,
    receivedToday,
    receivableSummary,
    inventorySummary,
    expenseSummary,
    recentSales,
    salesTrend,
    cashSummary,
  ] = await Promise.all([
    db.query(`
      select
        (select count(*) from volt_core.customers where company_id=$1 and active=true)::int as customers,
        (select count(*) from volt_core.products where company_id=$1 and active=true)::int as products`, [companyId]),
    has("sales") ? db.query(`
      select count(*)::int as count,coalesce(sum(total),0)::numeric as amount
      from volt_core.sales
      where company_id=$1 and status<>'canceled' and sold_at::date=current_date`, [companyId]) : Promise.resolve({ rows: [{ count: 0, amount: 0 }] }),
    (has("cash_register") || has("receivables") || has("sales")) ? db.query(`
      select count(*)::int as count,coalesce(sum(amount),0)::numeric as amount
      from volt_core.cash_movements
      where company_id=$1 and type='entry' and operational_at::date=current_date
        and source_type in ('sale','sale_edit','receivable')`, [companyId]) : Promise.resolve({ rows: [{ count: 0, amount: 0 }] }),
    has("receivables") ? db.query(`
      select
        coalesce(sum(case when r.status not in ('paid','received','compensated','canceled') then r.amount-r.paid_amount else 0 end),0)::numeric as "openAmount",
        count(*) filter (where r.status not in ('paid','received','compensated','canceled'))::int as "openCount",
        coalesce(sum(case when r.status not in ('paid','received','compensated','canceled') and r.due_date<current_date then r.amount-r.paid_amount else 0 end),0)::numeric as "overdueAmount",
        count(*) filter (where r.status not in ('paid','received','compensated','canceled') and r.due_date<current_date)::int as "overdueCount",
        coalesce(sum(case when r.status not in ('paid','received','compensated','canceled') and r.due_date=current_date then r.amount-r.paid_amount else 0 end),0)::numeric as "dueTodayAmount",
        count(*) filter (where r.status not in ('paid','received','compensated','canceled') and r.due_date=current_date)::int as "dueTodayCount",
        coalesce(sum(case when r.status not in ('paid','received','compensated','canceled') and r.due_date>current_date and r.due_date<=current_date+interval '7 days' then r.amount-r.paid_amount else 0 end),0)::numeric as "next7Amount",
        count(*) filter (where r.status not in ('paid','received','compensated','canceled') and r.due_date>current_date and r.due_date<=current_date+interval '7 days')::int as "next7Count"
      from volt_core.receivables r
      left join volt_core.sales s on s.id=r.sale_id and s.company_id=r.company_id
      where r.company_id=$1 and coalesce(s.status,'')<>'canceled'`, [companyId]) : Promise.resolve({ rows: [{}] }),
    has("inventory") ? db.query(`
      with stock as (
        select product_id,coalesce(sum(quantity),0)::numeric quantity
        from volt_core.inventory_movements where company_id=$1 group by product_id
      ), reserved as (
        select product_id,coalesce(sum(quantity),0)::numeric quantity
        from volt_core.stock_reservations where company_id=$1 and status='active' group by product_id
      )
      select
        coalesce(sum(coalesce(stock.quantity,0)),0)::numeric as physical,
        coalesce(sum(coalesce(reserved.quantity,0)),0)::numeric as reserved,
        coalesce(sum(coalesce(stock.quantity,0)-coalesce(reserved.quantity,0)),0)::numeric as available,
        count(*) filter (where (coalesce(stock.quantity,0)-coalesce(reserved.quantity,0))<=p.minimum_stock)::int as "criticalCount"
      from volt_core.products p
      left join stock on stock.product_id=p.id
      left join reserved on reserved.product_id=p.id
      where p.company_id=$1 and p.active=true and p.track_stock=true`, [companyId]) : Promise.resolve({ rows: [{}] }),
    has("finance") ? db.query(`
      select
        coalesce(sum(case when status not in ('paid','canceled') and due_date<current_date then remaining_amount else 0 end),0)::numeric as "overdueAmount",
        count(*) filter (where status not in ('paid','canceled') and due_date<current_date)::int as "overdueCount"
      from volt_core.expenses
      where company_id=$1`, [companyId]) : Promise.resolve({ rows: [{}] }),
    has("sales") ? db.query(`select count(*)::int as total from volt_core.sales where company_id=$1 and status<>'canceled'`, [companyId]) : Promise.resolve({ rows: [{ total: 0 }] }),
    has("sales") ? db.query(`
      with days as (
        select generate_series(current_date-interval '29 days',current_date,interval '1 day')::date as day
      ), totals as (
        select sold_at::date as day,coalesce(sum(total),0)::numeric as amount,count(*)::int as count
        from volt_core.sales
        where company_id=$1 and status<>'canceled' and sold_at>=current_date-interval '29 days'
        group by sold_at::date
      )
      select to_char(days.day,'YYYY-MM-DD') as date,coalesce(totals.amount,0)::numeric as amount,coalesce(totals.count,0)::int as count
      from days left join totals using(day)
      order by days.day`, [companyId]) : Promise.resolve({ rows: [] }),
    cashSummaryPromise,
  ]);

  const customerCount = Number(counts.rows[0]?.customers || 0);
  const productCount = Number(counts.rows[0]?.products || 0);
  const saleSummary = salesToday.rows[0] || {};
  const receiveSummary = receivedToday.rows[0] || {};
  const finance = receivableSummary.rows[0] || {};
  const stock = inventorySummary.rows[0] || {};
  const expenses = expenseSummary.rows[0] || {};
  const salesCount = Number(recentSales.rows[0]?.total || 0);
  const lowStockCount = Number(stock.criticalCount || 0);
  const openReceivableAmount = money(finance.openAmount);
  const overdueReceivableAmount = money(finance.overdueAmount);

  const extensionContributions = await extensionRegistry.runHook("dashboard.contribute", { companyId, client: db }, configuration);
  const extensionAlerts = extensionContributions.flatMap((entry) => (entry.value?.alerts || []).map((alert) => ({ ...alert, extensionKey: entry.extensionKey })));
  const operationWidgets = extensionContributions.flatMap((entry) => (entry.value?.widgets || []).map((widget) => ({ ...widget, extensionKey: entry.extensionKey })));

  const alerts = [
    ...(Number(finance.overdueCount || 0) ? [{
      kind: "receivable",
      id: "receivables-overdue",
      title: `${Number(finance.overdueCount)} pagamento${Number(finance.overdueCount) === 1 ? "" : "s"} vencido${Number(finance.overdueCount) === 1 ? "" : "s"}`,
      detail: "Cobrancas que precisam de acompanhamento.",
      amount: overdueReceivableAmount,
      page: "payments",
      permission: "receivables:read",
      intent: { tab: "pending", filter: "Vencidos" },
      priority: 0,
    }] : []),
    ...(Number(expenses.overdueCount || 0) ? [{
      kind: "expense",
      id: "expenses-overdue",
      title: `${Number(expenses.overdueCount)} despesa${Number(expenses.overdueCount) === 1 ? "" : "s"} vencida${Number(expenses.overdueCount) === 1 ? "" : "s"}`,
      detail: "Contas a pagar com vencimento ultrapassado.",
      amount: money(expenses.overdueAmount),
      page: "finance",
      permission: "expenses:read",
      priority: 1,
    }] : []),
    ...extensionAlerts,
    ...(lowStockCount ? [{
      kind: "stock",
      id: "stock-critical",
      title: `${lowStockCount} produto${lowStockCount === 1 ? "" : "s"} com estoque critico`,
      detail: "Disponivel igual ou abaixo do minimo configurado.",
      meta: "Estoque",
      page: "inventory",
      permission: "inventory:read",
      intent: { tab: "balance", filter: "Critico" },
      priority: 4,
    }] : []),
  ].sort((a, b) => Number(a.priority ?? 9) - Number(b.priority ?? 9)).slice(0, 5);

  const metrics = [
    has("sales") ? {
      id: "sales_today",
      label: "Vendas hoje",
      value: money(saleSummary.amount),
      format: "currency",
      hint: `${Number(saleSummary.count || 0)} venda${Number(saleSummary.count || 0) === 1 ? "" : "s"}`,
      tone: "blue",
      page: "sales",
      permission: "sales:read",
    } : null,
    has("cash_register") ? {
      id: "received_today",
      label: "Recebido hoje",
      value: money(receiveSummary.amount),
      format: "currency",
      hint: `${Number(receiveSummary.count || 0)} entrada${Number(receiveSummary.count || 0) === 1 ? "" : "s"}`,
      tone: "green",
      page: "cash_register",
      permission: "cash_register:read",
    } : null,
    has("receivables") ? {
      id: "open_receivables",
      label: "A receber",
      value: openReceivableAmount,
      format: "currency",
      hint: `${Number(finance.openCount || 0)} titulo${Number(finance.openCount || 0) === 1 ? "" : "s"} em aberto`,
      tone: "violet",
      page: "payments",
      permission: "receivables:read",
      intent: { tab: "pending", filter: "Pendentes" },
    } : null,
    has("receivables") ? {
      id: "overdue_receivables",
      label: "Vencido",
      value: overdueReceivableAmount,
      format: "currency",
      hint: `${Number(finance.overdueCount || 0)} titulo${Number(finance.overdueCount || 0) === 1 ? "" : "s"} atrasado${Number(finance.overdueCount || 0) === 1 ? "" : "s"}`,
      tone: "red",
      page: "payments",
      permission: "receivables:read",
      intent: { tab: "pending", filter: "Vencidos" },
    } : null,
    has("cash_register") ? {
      id: "cash",
      label: "Caixa",
      value: cashSummary?.status === "open" ? money(cashSummary.balance) : 0,
      format: cashSummary?.status === "open" ? "currency" : "text",
      textValue: cashSummary?.status === "open" ? null : "Fechado",
      hint: cashSummary?.status === "open" ? `Caixa #${cashSummary.sessionNumber || "-"} aberto` : "Nenhuma sessao aberta",
      tone: cashSummary?.status === "open" ? "green" : "slate",
      page: "cash_register",
      permission: "cash_register:read",
    } : null,
  ].filter(Boolean);

  return {
    metrics,
    finance: has("receivables") ? {
      openAmount: openReceivableAmount,
      openCount: Number(finance.openCount || 0),
      overdueAmount: overdueReceivableAmount,
      overdueCount: Number(finance.overdueCount || 0),
      dueTodayAmount: money(finance.dueTodayAmount),
      dueTodayCount: Number(finance.dueTodayCount || 0),
      next7Amount: money(finance.next7Amount),
      next7Count: Number(finance.next7Count || 0),
      receivedTodayAmount: money(receiveSummary.amount),
      permission: "receivables:read",
    } : null,
    inventory: has("inventory") ? {
      physical: Number(stock.physical || 0),
      reserved: Number(stock.reserved || 0),
      available: Number(stock.available || 0),
      criticalCount: lowStockCount,
      permission: "inventory:read",
    } : null,
    salesTrend: has("sales") ? salesTrend.rows.map((row) => ({ date: row.date, amount: money(row.amount), count: Number(row.count || 0) })) : [],
    salesTrendPermission: "sales:read",
    cash: has("cash_register") ? {
      balance: money(cashSummary?.balance),
      status: cashSummary?.status || "closed",
      sessionNumber: cashSummary?.sessionNumber || null,
      openedAt: cashSummary?.openedAt || null,
      permission: "cash_register:read",
    } : null,
    lowStock: lowStockCount,
    openReceivables: openReceivableAmount,
    alerts,
    operationWidgets,
    firstUse: {
      hasProducts: productCount > 0,
      hasPositiveStock: has("inventory") ? await hasPositiveStock(companyId) : false,
      hasOpenCash: cashSummary?.status === "open",
      hasSales: salesCount > 0,
    },
  };
}

async function hasPositiveStock(companyId) {
  const result = await db.query(`
    select exists(
      select 1
      from volt_core.products p
      left join lateral (
        select coalesce(sum(m.quantity),0)::numeric as physical
        from volt_core.inventory_movements m where m.company_id=p.company_id and m.product_id=p.id
      ) st on true
      left join lateral (
        select coalesce(sum(r.quantity),0)::numeric as reserved
        from volt_core.stock_reservations r where r.company_id=p.company_id and r.product_id=p.id and r.status='active'
      ) sr on true
      where p.company_id=$1 and p.track_stock=true and (st.physical-sr.reserved)>0
    ) as value`, [companyId]);
  return result.rows[0]?.value === true;
}

module.exports = { getDashboard };
