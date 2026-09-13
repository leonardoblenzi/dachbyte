"use strict";

const db = require("../../../../../db/db");
const { normalizePageQuery, pageMeta } = require("./paging");
const { getCashSummary } = require("./cashService");
const { getCompanyConfiguration } = require("./configurationService");
const { extensionRegistry } = require("../../../../platform/extensions/extensionRegistry");

function normalizedFilter(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

async function rowsAndCount(dataSql, countSql, params, query) {
  const [rowsResult, countResult] = await Promise.all([
    db.query(dataSql, [...params, query.pageSize, query.offset]),
    db.query(countSql, params),
  ]);
  return {
    rows: rowsResult.rows,
    pagination: pageMeta(countResult.rows[0]?.total || 0, query),
  };
}

async function listCustomersPage(companyId, input = {}) {
  const query = normalizePageQuery(input);
  const filter = normalizedFilter(query.filter);
  const params = [companyId, query.search, filter];
  const where = `
    c.company_id = $1
    and ($2 = '' or lower(concat_ws(' ', c.name, c.document, c.phone, c.email, c.address, c.notes)) like '%' || lower($2) || '%')
    and (
      $3 = '' or $3 = 'todos'
      or ($3 = 'ativos' and c.active = true)
      or ($3 = 'inativos' and c.active = false)
      or ($3 in ('com saldo','com_saldo') and exists (
        select 1 from volt_core.receivables rx
        where rx.company_id = c.company_id and rx.customer_id = c.id
          and rx.status not in ('paid','received','compensated','canceled')
          and rx.amount > rx.paid_amount
      ))
    )`;
  const fields = `
    c.id, c.number, c.name, c.phone, c.document, c.email, c.address, c.notes, c.active,
    c.custom_fields as "customFields",
    (select max(s.sold_at) from volt_core.sales s where s.company_id = c.company_id and s.customer_id = c.id and s.status <> 'canceled') as "lastPurchaseAt",
    (select coalesce(sum(r.amount-r.paid_amount),0) from volt_core.receivables r where r.company_id=c.company_id and r.customer_id=c.id and r.status not in ('paid','received','compensated','canceled')) as "openBalance",
    c.created_at as "createdAt", c.updated_at as "updatedAt"`;
  const result = await rowsAndCount(
    `select ${fields} from volt_core.customers c where ${where} order by c.number asc limit $4 offset $5`,
    `select count(*)::int as total from volt_core.customers c where ${where}`,
    params,
    query,
  );
  return { data: { customers: result.rows }, pagination: result.pagination };
}

async function listProductsPage(companyId, input = {}) {
  const query = normalizePageQuery(input);
  const filter = normalizedFilter(query.filter);
  const scope = normalizedFilter(query.scope);
  const params = [companyId, query.search, filter, scope];
  const stockCte = `select product_id, coalesce(sum(quantity),0)::numeric as quantity from volt_core.inventory_movements where company_id=$1 group by product_id`;
  const reservationCte = `select product_id, coalesce(sum(quantity),0)::numeric as quantity from volt_core.stock_reservations where company_id=$1 and status='active' group by product_id`;
  const availableStock = `(coalesce(st.quantity,0)-coalesce(sr.quantity,0))`;
  const extensionSearch = `exists (
    select 1 from volt_core.entity_extension_data ex
    where ex.company_id=p.company_id and ex.entity_type='product' and ex.entity_id=p.id
      and lower(ex.data::text) like '%'||lower($2)||'%'
  )`;
  const extensionFilter = `exists (
    select 1 from volt_core.entity_extension_data ex
    where ex.company_id=p.company_id and ex.entity_type='product' and ex.entity_id=p.id
      and lower(ex.data::text) like '%'||lower($3)||'%'
  )`;
  const where = `
    p.company_id = $1
    and ($2 = '' or lower(concat_ws(' ', p.name, p.sku, p.ean, p.category, p.brand, p.type)) like '%' || lower($2) || '%' or ${extensionSearch})
    and (
      $3 = '' or $3 = 'todos'
      or ($3 = 'ativos' and p.active=true)
      or ($3 = 'inativos' and p.active=false)
      or ($3 in ('produto','produtos') and p.type <> 'service')
      or ($3 in ('servico','servicos') and p.type = 'service')
      or ($3='ok' and p.active=true and (p.track_stock=false or ${availableStock} > p.minimum_stock))
      or ($3='critico' and p.active=true and p.track_stock=true and ${availableStock} <= p.minimum_stock)
      or ($3 in ('acessorio','acessorios') and lower(coalesce(p.category,'')) like '%acessor%')
      or ($3 in ('estoque baixo','estoque_baixo') and p.track_stock=true and ${availableStock} <= p.minimum_stock)
      or ($3 in ('estoque zerado','sem estoque','sem_estoque') and p.track_stock=true and ${availableStock} <= 0)
      or ($3 in ('com estoque','com_estoque') and p.track_stock=true and ${availableStock} > 0)
      or ($3 in ('com reserva','com_reserva','reservado','reservados') and p.track_stock=true and coalesce(sr.quantity,0) > 0)
      or ($3='comprar hoje' and p.track_stock=true and ${availableStock} <= p.minimum_stock)
      or ${extensionFilter}
    )
    and ($4='' or ($4 in ('low_stock','estoque_baixo') and p.track_stock=true and ${availableStock} <= p.minimum_stock))`;
  const fields = `
    p.id,p.number,p.sku,p.ean,p.name,p.category,p.category_id as "categoryId",p.brand,p.brand_id as "brandId",p.type,
    p.sale_price as "salePrice",p.cost_price as "costPrice",p.minimum_stock as "minimumStock",p.track_stock as "trackStock",
    p.active,p.custom_fields as "customFields",
    coalesce(st.quantity,0)::numeric as "physicalStockQuantity",
    coalesce(sr.quantity,0)::numeric as "reservedStockQuantity",
    ${availableStock}::numeric as "availableStockQuantity",
    ${availableStock}::numeric as "stockQuantity",
    (p.track_stock and ${availableStock} <= p.minimum_stock) as "lowStock",
    p.created_at as "createdAt",p.updated_at as "updatedAt"`;
  const fromSql = `from volt_core.products p left join st on st.product_id=p.id left join sr on sr.product_id=p.id`;
  const result = await rowsAndCount(
    `with st as (${stockCte}), sr as (${reservationCte}) select ${fields} ${fromSql} where ${where} order by p.number asc limit $5 offset $6`,
    `with st as (${stockCte}), sr as (${reservationCte}) select count(*)::int as total ${fromSql} where ${where}`,
    params,
    query,
  );
  const configuration = await getCompanyConfiguration(companyId);
  await extensionRegistry.runHook("product.decorateRows", { companyId, rows: result.rows }, configuration);
  return { data: { products: result.rows }, pagination: result.pagination };
}

function coreSaleFilterPredicate(filter) {
  const predicates = new Map([
    ["finalizada", "s.status='finalized'"],
    ["finalizado", "s.status='finalized'"],
    ["finalized", "s.status='finalized'"],
    ["concluido", "s.status='finalized'"],
    ["concluido hoje", "s.status='finalized' and s.delivered_at::date=current_date"],
    ["concluidos hoje", "s.status='finalized' and s.delivered_at::date=current_date"],
    ["concluido_hoje", "s.status='finalized' and s.delivered_at::date=current_date"],
    ["cancelada", "s.status='canceled'"],
    ["cancelado", "s.status='canceled'"],
    ["canceled", "s.status='canceled'"],
    ["na entrega", "s.status='pending_delivery'"],
    ["na_entrega", "s.status='pending_delivery'"],
    ["pending_delivery", "s.status='pending_delivery'"],
    ["aguardando pagamento na entrega", "s.status='pending_delivery'"],
    ["em andamento", "s.status='pending_delivery'"],
    ["em_andamento", "s.status='pending_delivery'"],
    ["entrega atrasada", "s.status='pending_delivery' and s.promised_delivery_date is not null and s.promised_delivery_date<current_date"],
    ["entrega_atrasada", "s.status='pending_delivery' and s.promised_delivery_date is not null and s.promised_delivery_date<current_date"],
    ["atrasado", "s.status='pending_delivery' and s.promised_delivery_date is not null and s.promised_delivery_date<current_date"],
    ["atrasados", "s.status='pending_delivery' and s.promised_delivery_date is not null and s.promised_delivery_date<current_date"],
    ["a receber", `(s.status='pending_delivery' or exists (
      select 1 from volt_core.receivables rf
      where rf.company_id=s.company_id and rf.sale_id=s.id
        and rf.status not in ('paid','received','compensated','canceled')
        and rf.amount-rf.paid_amount>0
    ))`],
    ["a_receber", `(s.status='pending_delivery' or exists (
      select 1 from volt_core.receivables rf
      where rf.company_id=s.company_id and rf.sale_id=s.id
        and rf.status not in ('paid','received','compensated','canceled')
        and rf.amount-rf.paid_amount>0
    ))`],
    ["vencidos", `exists (
      select 1 from volt_core.receivables rf
      where rf.company_id=s.company_id and rf.sale_id=s.id
        and rf.status not in ('paid','received','compensated','canceled')
        and rf.amount-rf.paid_amount>0 and rf.due_date<current_date
    )`],
    ["vencido", `exists (
      select 1 from volt_core.receivables rf
      where rf.company_id=s.company_id and rf.sale_id=s.id
        and rf.status not in ('paid','received','compensated','canceled')
        and rf.amount-rf.paid_amount>0 and rf.due_date<current_date
    )`],
    ["pix", "lower(s.payments::text) like '%pix%'"],
    ["cartao", "(lower(s.payments::text) like '%credit%' or lower(s.payments::text) like '%debit%')"],
    ["prazo", "(lower(s.payments::text) like '%store_credit%' or lower(s.payments::text) like '%promissory%' or lower(s.payments::text) like '%check%' or lower(s.payments::text) like '%boleto%')"],
  ]);
  if (!filter || filter === "todos") return "true";
  return predicates.get(filter) || null;
}

async function resolveSaleFilterPredicate(companyId, filter, configuration) {
  const corePredicate = coreSaleFilterPredicate(filter);
  if (corePredicate) return corePredicate;

  const extensionResults = await extensionRegistry.runHook(
    "sale.resolveListFilter",
    { companyId, filter, saleAlias: "s" },
    configuration,
  );
  const predicates = extensionResults
    .map((entry) => String(entry?.value?.predicate || "").trim())
    .filter(Boolean);
  // Unknown filters must not silently broaden the query.
  return predicates.length ? `(${predicates.join(") or (")})` : "false";
}

async function listSalesPage(companyId, input = {}) {
  const query = normalizePageQuery(input);
  const filter = normalizedFilter(query.filter);
  const configuration = await getCompanyConfiguration(companyId);
  const filterPredicate = await resolveSaleFilterPredicate(companyId, filter, configuration);
  const params = [companyId, query.search, query.dateFrom, query.dateTo];
  const where = `
    s.company_id=$1
    and ($2='' or lower(concat_ws(' ', s.number::text, c.name, c.document, s.status, s.payments::text)) like '%'||lower($2)||'%' or exists (
      select 1 from volt_core.sale_items sx where sx.company_id=s.company_id and sx.sale_id=s.id and lower(sx.description) like '%'||lower($2)||'%'
    ))
    and (${filterPredicate})
    and ($3='' or s.sold_at::date >= $3::date)
    and ($4='' or s.sold_at::date <= $4::date)`;
  const selectSql = `
    select s.id,s.number,s.status,s.subtotal,s.discount_total as "discountTotal",s.total,s.payments,s.notes,
      s.custom_fields as "customFields",s.sold_at as "soldAt",s.payment_timing as "paymentTiming",
      s.promised_delivery_date as "promisedDeliveryDate",s.delivered_at as "deliveredAt",s.created_at as "createdAt",
      c.id as "customerId",c.name as "customerName",c.document as "customerDocument",c.phone as "customerPhone",c.email as "customerEmail",
      coalesce(count(i.id),0)::int as "itemCount",
      coalesce(jsonb_agg(jsonb_build_object('description',i.description,'quantity',i.quantity,'unitPrice',i.unit_price,'discount',i.discount,'total',i.total) order by i.description) filter(where i.id is not null),'[]'::jsonb) as items
    from volt_core.sales s
    left join volt_core.customers c on c.id=s.customer_id and c.company_id=s.company_id
    left join volt_core.sale_items i on i.sale_id=s.id and i.company_id=s.company_id
    where ${where}
    group by s.id,c.id,c.name,c.document,c.phone,c.email
    order by s.sold_at desc,s.created_at desc
    limit $5 offset $6`;
  const result = await rowsAndCount(
    selectSql,
    `select count(*)::int as total from volt_core.sales s left join volt_core.customers c on c.id=s.customer_id and c.company_id=s.company_id where ${where}`,
    params,
    query,
  );

  await extensionRegistry.runHook("sale.decorateRows", { client: db, companyId, rows: result.rows }, configuration);

  const saleIds = result.rows.map((row) => row.id);
  let receivables = [];
  if (saleIds.length) {
    const related = await db.query(`
      select r.id,r.customer_id as "customerId",c.name as "customerName",r.sale_id as "saleId",r.type,r.status,
        r.due_date as "dueDate",r.amount,r.paid_amount as "paidAmount",r.description,r.metadata,r.custom_fields as "customFields",
        r.created_at as "createdAt",r.updated_at as "updatedAt"
      from volt_core.receivables r left join volt_core.customers c on c.id=r.customer_id and c.company_id=r.company_id
      where r.company_id=$1 and r.sale_id = any($2::text[]) and r.status <> 'canceled'
      order by r.due_date asc`, [companyId, saleIds]);
    receivables = related.rows;
  }
  return { data: { sales: result.rows, receivables }, pagination: result.pagination };
}

async function listReceivablesPage(companyId, input = {}) {
  const query = normalizePageQuery(input);
  const filter = normalizedFilter(query.filter);
  const params = [companyId, query.search, filter, query.dateFrom, query.dateTo];
  const where = `
    r.company_id=$1 and r.status <> 'canceled' and coalesce(s.status,'') <> 'canceled'
    and ($2='' or lower(concat_ws(' ',c.name,r.description,r.type,r.status,r.due_date::text,r.amount::text,s.number::text)) like '%'||lower($2)||'%')
    and (
      $3='' or $3='todos'
      or ($3='aberto' and r.status='open')
      or ($3='pendentes' and r.status not in ('paid','received','compensated','canceled'))
      or ($3='pago' and r.status in ('paid','received','compensated'))
      or ($3='parcial' and r.status='partial')
      or ($3='compensar' and r.status in ('awaiting_deposit','deposited','returned'))
      or ($3='vencidos' and r.status not in ('paid','received','compensated','canceled') and r.due_date < current_date)
      or ($3 in ('vence hoje','vence_hoje') and r.status not in ('paid','received','compensated','canceled') and r.due_date = current_date)
      or ($3 in ('proximos','próximos','proximos 7 dias','proximos_7_dias') and r.status not in ('paid','received','compensated','canceled') and r.due_date > current_date and r.due_date <= current_date + 7)
    )
    and ($4='' or r.due_date >= $4::date)
    and ($5='' or r.due_date <= $5::date)`;
  const fields = `r.id,r.customer_id as "customerId",c.name as "customerName",r.sale_id as "saleId",s.number as "saleNumber",r.type,r.status,r.due_date as "dueDate",r.amount,r.paid_amount as "paidAmount",(r.amount-r.paid_amount)::numeric as "balanceAmount",r.description,r.metadata,r.custom_fields as "customFields",r.created_at as "createdAt",r.updated_at as "updatedAt"`;
  const [result, overviewResult, summaryResult] = await Promise.all([
    rowsAndCount(
      `select ${fields} from volt_core.receivables r left join volt_core.customers c on c.id=r.customer_id and c.company_id=r.company_id left join volt_core.sales s on s.id=r.sale_id and s.company_id=r.company_id where ${where} order by r.due_date asc,r.created_at desc limit $6 offset $7`,
      `select count(*)::int as total from volt_core.receivables r left join volt_core.customers c on c.id=r.customer_id and c.company_id=r.company_id left join volt_core.sales s on s.id=r.sale_id and s.company_id=r.company_id where ${where}`,
      params,
      query,
    ),
    db.query(`
      select ${fields}
      from volt_core.receivables r
      left join volt_core.customers c on c.id=r.customer_id and c.company_id=r.company_id
      left join volt_core.sales s on s.id=r.sale_id and s.company_id=r.company_id
      where r.company_id=$1 and r.status<>'canceled' and coalesce(s.status,'')<>'canceled'
        and r.status not in ('paid','received','compensated')
      order by r.due_date asc,r.created_at asc limit 100`, [companyId]),
    db.query(`
      select count(*)::int as total,
        count(*) filter(where r.status not in ('paid','received','compensated','canceled'))::int as "openCount",
        count(*) filter(where r.status in ('paid','received','compensated'))::int as "paidCount",
        count(*) filter(where r.status not in ('paid','received','compensated','canceled') and r.due_date<current_date)::int as "overdueCount",
        count(*) filter(where r.status not in ('paid','received','compensated','canceled') and r.due_date=current_date)::int as "dueTodayCount",
        count(*) filter(where r.status not in ('paid','received','compensated','canceled') and r.due_date>current_date and r.due_date<=current_date+7)::int as "next7Count",
        coalesce(sum(case when r.status not in ('paid','received','compensated','canceled') then r.amount-r.paid_amount else 0 end),0)::numeric as "openAmount",
        coalesce(sum(case when r.status not in ('paid','received','compensated','canceled') and r.due_date<current_date then r.amount-r.paid_amount else 0 end),0)::numeric as "overdueAmount",
        coalesce(sum(case when r.status not in ('paid','received','compensated','canceled') and r.due_date=current_date then r.amount-r.paid_amount else 0 end),0)::numeric as "dueTodayAmount",
        coalesce(sum(case when r.status not in ('paid','received','compensated','canceled') and r.due_date>current_date and r.due_date<=current_date+7 then r.amount-r.paid_amount else 0 end),0)::numeric as "next7Amount",
        coalesce(sum(case when r.status='partial' then r.amount-r.paid_amount else 0 end),0)::numeric as "partialAmount"
      from volt_core.receivables r
      left join volt_core.sales s on s.id=r.sale_id and s.company_id=r.company_id
      where r.company_id=$1 and r.status<>'canceled' and coalesce(s.status,'')<>'canceled'`, [companyId]),
  ]);
  return {
    data: { receivables: result.rows },
    pagination: result.pagination,
    summary: { ...summaryResult.rows[0], queueRows: overviewResult.rows },
  };
}

async function listInventoryMovementsPage(companyId, input = {}) {
  const query = normalizePageQuery(input);
  const filter = normalizedFilter(query.filter);
  const params = [companyId, query.search, filter, query.dateFrom, query.dateTo];
  const where = `
    m.company_id=$1
    and ($2='' or lower(concat_ws(' ',p.name,p.sku,m.reason,m.type,m.source_type,m.actor_user_id)) like '%'||lower($2)||'%')
    and ($3='' or $3='todos' or ($3='entrada' and m.quantity>0 and m.type<>'adjustment') or ($3='saida' and m.quantity<0 and m.type<>'adjustment') or ($3='ajuste' and m.type='adjustment'))
    and ($4='' or coalesce(m.operational_at,m.created_at)::date >= $4::date)
    and ($5='' or coalesce(m.operational_at,m.created_at)::date <= $5::date)`;
  const fields = `m.id,m.type,m.quantity,m.reason,m.source_type as "sourceType",m.source_id as "sourceId",m.actor_user_id as "actorUserId",m.notes,coalesce(m.operational_at,m.created_at) as "operationalAt",m.created_at as "createdAt",p.id as "productId",p.sku,p.name as "productName"`;
  const result = await rowsAndCount(
    `select ${fields} from volt_core.inventory_movements m join volt_core.products p on p.id=m.product_id and p.company_id=m.company_id where ${where} order by coalesce(m.operational_at,m.created_at) desc,m.created_at desc limit $6 offset $7`,
    `select count(*)::int as total from volt_core.inventory_movements m join volt_core.products p on p.id=m.product_id and p.company_id=m.company_id where ${where}`,
    params,
    query,
  );
  return { data: { inventoryMovements: result.rows }, pagination: result.pagination };
}

async function listStockReservationsPage(companyId, input = {}) {
  const query = normalizePageQuery(input);
  const filter = normalizedFilter(query.filter);
  const params = [companyId, query.search, filter, query.dateFrom, query.dateTo];
  const where = `
    r.company_id=$1
    and ($2='' or lower(concat_ws(' ',p.name,p.sku,s.number::text,c.name,r.status,r.release_reason)) like '%'||lower($2)||'%')
    and (
      $3='' or $3='todos'
      or ($3 in ('ativas','ativa','active') and r.status='active')
      or ($3 in ('consumidas','consumida','consumed') and r.status='consumed')
      or ($3 in ('liberadas','liberada','released') and r.status='released')
    )
    and ($4='' or r.reserved_at::date >= $4::date)
    and ($5='' or r.reserved_at::date <= $5::date)`;
  const fields = `
    r.id,r.product_id as "productId",p.sku,p.name as "productName",r.sale_id as "saleId",s.number as "saleNumber",
    s.promised_delivery_date as "promisedDeliveryDate",c.id as "customerId",c.name as "customerName",
    r.quantity,r.status,r.reserved_at as "reservedAt",r.released_at as "releasedAt",r.release_reason as "releaseReason",r.metadata,
    r.created_at as "createdAt",r.updated_at as "updatedAt"`;
  const joins = `from volt_core.stock_reservations r
    join volt_core.products p on p.id=r.product_id and p.company_id=r.company_id
    join volt_core.sales s on s.id=r.sale_id and s.company_id=r.company_id
    left join volt_core.customers c on c.id=s.customer_id and c.company_id=s.company_id`;
  const result = await rowsAndCount(
    `select ${fields} ${joins} where ${where} order by case when r.status='active' then 0 else 1 end,r.reserved_at desc limit $6 offset $7`,
    `select count(*)::int as total ${joins} where ${where}`,
    params,
    query,
  );
  return { data: { stockReservations: result.rows }, pagination: result.pagination };
}

async function listCashMovementsPage(companyId, input = {}) {
  const query = normalizePageQuery(input, { defaultPageSize: 25 });
  const filter = normalizedFilter(query.filter);
  const params = [companyId, query.search, filter, query.dateFrom, query.dateTo];
  const where = `m.company_id=$1
    and ($2='' or lower(concat_ws(' ',m.description,m.payment_method,m.type,m.source_type,m.actor_user_id)) like '%'||lower($2)||'%')
    and ($3='' or $3='todos' or ($3='entrada' and m.type='entry') or ($3='saida' and m.type='exit'))
    and ($4='' or coalesce(m.operational_at,m.created_at)::date >= $4::date)
    and ($5='' or coalesce(m.operational_at,m.created_at)::date <= $5::date)`;
  const result = await rowsAndCount(
    `select m.id,m.session_id as "sessionId",m.type,m.source_type as "sourceType",m.source_id as "sourceId",m.payment_method as "paymentMethod",m.amount,m.description,m.actor_user_id as "actorUserId",m.operational_at as "operationalAt",m.created_at as "createdAt" from volt_core.cash_movements m where ${where} order by coalesce(m.operational_at,m.created_at) desc,m.created_at desc limit $6 offset $7`,
    `select count(*)::int as total from volt_core.cash_movements m where ${where}`,
    params,
    query,
  );
  return { data: { cashMovements: result.rows, cashSummary: await getCashSummary(companyId) }, pagination: result.pagination };
}

async function listCashSessionsPage(companyId, input = {}) {
  const query = normalizePageQuery(input, { defaultPageSize: 20 });
  const params = [companyId, query.search];
  const where = `s.company_id=$1 and ($2='' or lower(concat_ws(' ',s.number::text,s.status,s.opened_by,s.closed_by,s.notes)) like '%'||lower($2)||'%')`;
  const result = await rowsAndCount(
    `select s.id,s.number,s.status,s.opening_amount as "openingAmount",s.expected_amount as "expectedAmount",s.counted_amount as "countedAmount",s.difference_amount as "differenceAmount",s.opened_by as "openedBy",s.closed_by as "closedBy",s.opened_at as "openedAt",s.closed_at as "closedAt",s.notes from volt_core.cash_sessions s where ${where} order by s.opened_at desc limit $3 offset $4`,
    `select count(*)::int as total from volt_core.cash_sessions s where ${where}`,
    params,
    query,
  );
  return { data: { cashSessions: result.rows }, pagination: result.pagination };
}

async function listReceiptsPage(companyId, input = {}) {
  const query = normalizePageQuery(input);
  const params = [companyId, query.search];
  const where = `r.company_id=$1 and ($2='' or lower(concat_ws(' ',r.number::text,s.number::text,c.name,r.payload::text)) like '%'||lower($2)||'%')`;
  const result = await rowsAndCount(
    `select r.id,r.number,r.sale_id as "saleId",r.html,r.payload,r.created_at as "createdAt",s.total,c.id as "customerId",c.name as "customerName" from volt_core.receipts r left join volt_core.sales s on s.id=r.sale_id and s.company_id=r.company_id left join volt_core.customers c on c.id=s.customer_id and c.company_id=s.company_id where ${where} order by r.created_at desc limit $3 offset $4`,
    `select count(*)::int as total from volt_core.receipts r left join volt_core.sales s on s.id=r.sale_id and s.company_id=r.company_id left join volt_core.customers c on c.id=s.customer_id and c.company_id=s.company_id where ${where}`,
    params,
    query,
  );
  return { data: { receipts: result.rows }, pagination: result.pagination };
}

async function listExpensesPage(companyId, input = {}) {
  const query = normalizePageQuery(input);
  const filter = normalizedFilter(query.filter);
  const params = [companyId, query.search, filter, query.dateFrom, query.dateTo];
  const where = `e.company_id=$1 and ($2='' or lower(concat_ws(' ',e.name,e.category,e.supplier,e.status,e.due_date::text,e.amount::text)) like '%'||lower($2)||'%') and ($3='' or $3='todos' or ($3='aberto' and e.status='open') or ($3='pago' and e.status='paid') or ($3='cancelado' and e.status='canceled')) and ($4='' or e.due_date >= $4::date) and ($5='' or e.due_date <= $5::date)`;
  const fields = `e.id,e.number,e.name,e.category,e.supplier,e.due_date as "dueDate",e.amount,e.paid_amount as "paidAmount",e.remaining_amount as "remainingAmount",e.status,e.payment_method as "paymentMethod",e.paid_at as "paidAt",e.notes,e.custom_fields as "customFields",e.created_at as "createdAt",e.updated_at as "updatedAt"`;
  const result = await rowsAndCount(
    `select ${fields} from volt_core.expenses e where ${where} order by e.due_date asc,e.number asc limit $6 offset $7`,
    `select count(*)::int as total from volt_core.expenses e where ${where}`,
    params,
    query,
  );
  return { data: { expenses: result.rows }, pagination: result.pagination };
}

async function listServiceOrdersPage(companyId, input = {}) {
  const query = normalizePageQuery(input);
  const filter = normalizedFilter(query.filter);
  const params = [companyId, query.search, filter];
  const where = `so.company_id=$1
    and ($2='' or lower(concat_ws(' ',so.number::text,concat('OS-',so.number::text),c.name,so.service,so.owner_name,so.status,so.notes)) like '%'||lower($2)||'%')
    and (
      $3='' or $3='todos'
      or lower(so.status)=lower($3)
      or ($3='active' and so.status <> 'canceled')
      or ($3='producing' and so.status not in ('open','ready','delivered','canceled'))
      or ($3='ready_or_delivered' and so.status in ('ready','delivered'))
    )`;
  const fields = `so.id,so.number,so.service,so.owner_name as owner,so.due_date as "dueDate",so.status,so.notes,so.custom_fields as "customFields",so.customer_id as "customerId",c.name as "customerName",so.created_at as "createdAt",so.updated_at as "updatedAt"`;
  const [result, overviewResult, summaryResult] = await Promise.all([
    rowsAndCount(
      `select ${fields} from volt_core.service_orders so left join volt_core.customers c on c.id=so.customer_id and c.company_id=so.company_id where ${where} order by so.number desc limit $4 offset $5`,
      `select count(*)::int as total from volt_core.service_orders so left join volt_core.customers c on c.id=so.customer_id and c.company_id=so.company_id where ${where}`,
      params,
      query,
    ),
    db.query(`
      select ${fields}
      from volt_core.service_orders so
      left join volt_core.customers c on c.id=so.customer_id and c.company_id=so.company_id
      where so.company_id=$1 and so.status <> 'canceled'
      order by coalesce(so.due_date,current_date + interval '100 years') asc,so.number desc
      limit 100`, [companyId]),
    db.query(`
      select
        count(*) filter(where so.status='open')::int as "openedCount",
        count(*) filter(where so.status not in ('open','ready','delivered','canceled'))::int as "producingCount",
        count(*) filter(where so.status in ('ready','delivered'))::int as "readyCount",
        count(*) filter(where so.status <> 'canceled')::int as "activeCount"
      from volt_core.service_orders so
      where so.company_id=$1`, [companyId]),
  ]);
  const configuration = await getCompanyConfiguration(companyId);
  await extensionRegistry.runHook("serviceOrder.decorateRows", { companyId, rows: result.rows }, configuration);
  await extensionRegistry.runHook("serviceOrder.decorateRows", { companyId, rows: overviewResult.rows }, configuration);
  return {
    data: { serviceOrders: result.rows },
    pagination: result.pagination,
    summary: { ...summaryResult.rows[0], queueRows: overviewResult.rows },
  };
}

async function listSimpleCollection(companyId, input, spec) {
  const query = normalizePageQuery(input, { defaultPageSize: spec.defaultPageSize || 50, maxPageSize: spec.maxPageSize || 100 });
  const params = [companyId, query.search];
  const where = `${spec.alias}.company_id=$1 and ($2='' or lower(${spec.searchExpression}) like '%'||lower($2)||'%')`;
  const result = await rowsAndCount(
    `select ${spec.fields} from ${spec.table} ${spec.alias} ${spec.joins || ""} where ${where} order by ${spec.orderBy} limit $3 offset $4`,
    `select count(*)::int as total from ${spec.table} ${spec.alias} ${spec.joins || ""} where ${where}`,
    params,
    query,
  );
  return { data: { [spec.dataKey]: result.rows }, pagination: result.pagination };
}

async function listUsersPage(companyId, input = {}) {
  const query = normalizePageQuery(input, { defaultPageSize: 50 });
  const params = [companyId, query.search];
  const where = `uc.company_id=$1 and ($2='' or lower(concat_ws(' ',u.name,u.email,uc.role,u.status)) like '%'||lower($2)||'%')`;
  const result = await rowsAndCount(
    `select u.id,u.name,u.email,uc.role,uc.permissions,uc.screens,u.status,u.last_login_at as "lastLoginAt" from volt_core.user_companies uc join volt_core.users u on u.id=uc.user_id where ${where} order by u.name asc limit $3 offset $4`,
    `select count(*)::int as total from volt_core.user_companies uc join volt_core.users u on u.id=uc.user_id where ${where}`,
    params,
    query,
  );
  return { data: { users: result.rows }, pagination: result.pagination };
}

async function listAuditLogsPage(companyId, input = {}) {
  const query = normalizePageQuery(input);
  const requestedStatus = normalizedFilter(input.status || input.filter);
  const status = ["todos", "all"].includes(requestedStatus) ? "" : requestedStatus;
  const entityType = String(input.entityType || "").trim().toLowerCase().slice(0, 80);
  const params = [companyId, query.search, query.dateFrom, query.dateTo, status, entityType];
  const where = `a.company_id=$1
    and ($2='' or lower(concat_ws(' ',a.actor_user_id,a.action,a.entity_type,a.entity_id,a.metadata::text)) like '%'||lower($2)||'%')
    and ($3='' or a.created_at::date >= $3::date)
    and ($4='' or a.created_at::date <= $4::date)
    and ($5='' or lower(coalesce(a.metadata->>'status',a.metadata->>'severity','info'))=$5)
    and ($6='' or lower(a.entity_type)=$6)`;
  const result = await rowsAndCount(
    `select a.id,a.actor_user_id as "actorUserId",a.action,a.entity_type as "entityType",a.entity_id as "entityId",a.before_payload as before,a.after_payload as after,a.metadata,a.created_at as "createdAt" from volt_core.audit_logs a where ${where} order by a.created_at desc limit $7 offset $8`,
    `select count(*)::int as total from volt_core.audit_logs a where ${where}`,
    params,
    query,
  );
  return { data: { auditLogs: result.rows }, pagination: result.pagination };
}

async function listLookupCollection(companyId, resource) {
  const mappings = {
    product_categories: ["productCategories", `select id,name,description,active,created_at as "createdAt",updated_at as "updatedAt" from volt_core.product_categories where company_id=$1 order by active desc,lower(name) asc`],
    product_brands: ["productBrands", `select id,name,description,active,created_at as "createdAt",updated_at as "updatedAt" from volt_core.product_brands where company_id=$1 order by active desc,lower(name) asc`],
    payment_methods: ["paymentMethods", `select id,name,kind,fee,settlement_days as "settlementDays",active,metadata from volt_core.payment_methods where company_id=$1 order by active desc,lower(name) asc`],
  };
  const mapping = mappings[resource];
  if (!mapping) return null;
  const result = await db.query(mapping[1], [companyId]);
  return { data: { [mapping[0]]: result.rows }, pagination: null };
}

const RESOURCE_LOADERS = {
  customers: listCustomersPage,
  products: listProductsPage,
  sales: listSalesPage,
  receivables: listReceivablesPage,
  inventory_movements: listInventoryMovementsPage,
  stock_reservations: listStockReservationsPage,
  cash_movements: listCashMovementsPage,
  cash_sessions: listCashSessionsPage,
  receipts: listReceiptsPage,
  expenses: listExpensesPage,
  service_orders: listServiceOrdersPage,
  users: listUsersPage,
  audit_logs: listAuditLogsPage,
};

async function loadRuntimeCollection(companyId, resource, query = {}) {
  const lookup = await listLookupCollection(companyId, resource);
  if (lookup) return { resource, ...lookup };
  const loader = RESOURCE_LOADERS[resource];
  if (!loader) {
    throw Object.assign(new Error("Recurso de leitura nao encontrado"), { statusCode: 404, code: "RUNTIME_DATA_RESOURCE_NOT_FOUND" });
  }
  return { resource, ...(await loader(companyId, query)) };
}

module.exports = {
  loadRuntimeCollection,
  listAuditLogsPage,
  listCustomersPage,
  listExpensesPage,
  listInventoryMovementsPage,
  listProductsPage,
  listReceivablesPage,
  listSalesPage,
  listStockReservationsPage,
};
