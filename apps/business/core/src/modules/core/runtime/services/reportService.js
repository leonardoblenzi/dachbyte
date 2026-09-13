"use strict";

const db = require("../../../../../db/db");
const {
  listExpensesPage,
  listInventoryMovementsPage,
  listProductsPage,
  listReceivablesPage,
  listSalesPage,
} = require("./dataQueryService");
const { normalizeDateKey } = require("./paging");

function cleanFilters(input = {}) {
  return {
    search: String(input.search || "").trim().slice(0, 160),
    status: String(input.status || input.filter || "").trim().slice(0, 80),
    dateFrom: normalizeDateKey(input.dateFrom),
    dateTo: normalizeDateKey(input.dateTo),
  };
}

function statusForDomain(status, domain) {
  const normalized = String(status || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (!normalized) return "";
  const allowed = {
    sales: new Set(["finalizada", "cancelada"]),
    receivables: new Set(["aberto", "pago", "parcial", "compensar", "vencidos"]),
    expenses: new Set(["aberto", "pago", "cancelado"]),
  };
  return allowed[domain]?.has(normalized) ? status : "";
}

async function getReportSummary(companyId, input = {}) {
  const filters = cleanFilters(input);
  const params = [companyId, filters.search, filters.dateFrom, filters.dateTo];
  const salesStatus = statusForDomain(filters.status, "sales");
  const receivableStatus = statusForDomain(filters.status, "receivables");
  const expenseStatus = statusForDomain(filters.status, "expenses");

  const [salesAgg, expensesAgg, receivablesAgg, stockAgg, sales, movements, expenses, receivables, lowStock] = await Promise.all([
    db.query(`
      select count(*)::int as count, coalesce(sum(s.total),0)::numeric as total
      from volt_core.sales s
      left join volt_core.customers c on c.id=s.customer_id and c.company_id=s.company_id
      where s.company_id=$1
        and ($2='' or lower(concat_ws(' ',s.number::text,c.name,s.status,s.payments::text)) like '%'||lower($2)||'%' or exists (
          select 1 from volt_core.sale_items si where si.company_id=s.company_id and si.sale_id=s.id and lower(si.description) like '%'||lower($2)||'%'
        ))
        and ($3='' or s.sold_at::date >= $3::date)
        and ($4='' or s.sold_at::date <= $4::date)
        and ($5='' or ($5='finalizada' and s.status='finalized') or ($5='cancelada' and s.status='canceled'))`, [...params, String(salesStatus).toLowerCase()]),
    db.query(`
      select count(*)::int as count, coalesce(sum(e.remaining_amount),0)::numeric as total
      from volt_core.expenses e
      where e.company_id=$1
        and ($2='' or lower(concat_ws(' ',e.name,e.category,e.supplier,e.status)) like '%'||lower($2)||'%')
        and ($3='' or e.due_date >= $3::date)
        and ($4='' or e.due_date <= $4::date)
        and ($5='' or ($5='aberto' and e.status='open') or ($5='pago' and e.status='paid') or ($5='cancelado' and e.status='canceled'))`, [...params, String(expenseStatus).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()]),
    db.query(`
      select count(*)::int as count,
        coalesce(sum(case when r.status not in ('paid','received','compensated','canceled') then r.amount-r.paid_amount else 0 end),0)::numeric as total
      from volt_core.receivables r
      left join volt_core.customers c on c.id=r.customer_id and c.company_id=r.company_id
      left join volt_core.sales s on s.id=r.sale_id and s.company_id=r.company_id
      where r.company_id=$1 and r.status<>'canceled' and coalesce(s.status,'')<>'canceled'
        and ($2='' or lower(concat_ws(' ',c.name,r.description,r.status,r.type)) like '%'||lower($2)||'%')
        and ($3='' or r.due_date >= $3::date)
        and ($4='' or r.due_date <= $4::date)
        and ($5='' or ($5='aberto' and r.status='open') or ($5='pago' and r.status in ('paid','received','compensated')) or ($5='parcial' and r.status='partial') or ($5='compensar' and r.status in ('awaiting_deposit','deposited','returned')) or ($5='vencidos' and r.status not in ('paid','received','compensated','canceled') and r.due_date<current_date))`, [...params, String(receivableStatus).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()]),
    db.query(`
      with stock as (
        select product_id,coalesce(sum(quantity),0)::numeric quantity
        from volt_core.inventory_movements where company_id=$1 group by product_id
      ), reserved as (
        select product_id,coalesce(sum(quantity),0)::numeric quantity
        from volt_core.stock_reservations where company_id=$1 and status='active' group by product_id
      )
      select count(*)::int as "productCount",
        count(*) filter(where p.track_stock=true and (coalesce(stock.quantity,0)-coalesce(reserved.quantity,0))<=p.minimum_stock)::int as "lowStockCount"
      from volt_core.products p
      left join stock on stock.product_id=p.id
      left join reserved on reserved.product_id=p.id
      where p.company_id=$1 and p.active=true`, [companyId]),
    listSalesPage(companyId, { ...filters, filter: salesStatus, page: 1, pageSize: 100 }),
    listInventoryMovementsPage(companyId, { ...filters, page: 1, pageSize: 100 }),
    listExpensesPage(companyId, { ...filters, filter: expenseStatus, page: 1, pageSize: 100 }),
    listReceivablesPage(companyId, { ...filters, filter: receivableStatus, page: 1, pageSize: 100 }),
    listProductsPage(companyId, { filter: "estoque baixo", page: 1, pageSize: 100 }),
  ]);

  const revenue = Number(salesAgg.rows[0]?.total || 0);
  const salesCount = Number(salesAgg.rows[0]?.count || 0);
  const expenseTotal = Number(expensesAgg.rows[0]?.total || 0);
  const receivableTotal = Number(receivablesAgg.rows[0]?.total || 0);

  return {
    filters,
    summary: {
      revenue,
      salesCount,
      ticket: salesCount ? revenue / salesCount : 0,
      expenses: expenseTotal,
      expenseCount: Number(expensesAgg.rows[0]?.count || 0),
      receivables: receivableTotal,
      receivableCount: Number(receivablesAgg.rows[0]?.count || 0),
      net: revenue - expenseTotal,
      productCount: Number(stockAgg.rows[0]?.productCount || 0),
      lowStockCount: Number(stockAgg.rows[0]?.lowStockCount || 0),
    },
    data: {
      sales: sales.data.sales,
      inventoryMovements: movements.data.inventoryMovements,
      expenses: expenses.data.expenses,
      receivables: receivables.data.receivables,
      products: lowStock.data.products,
    },
    detailPagination: {
      sales: sales.pagination,
      inventoryMovements: movements.pagination,
      expenses: expenses.pagination,
      receivables: receivables.pagination,
      lowStock: lowStock.pagination,
    },
  };
}

module.exports = { getReportSummary };
