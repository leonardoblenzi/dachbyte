"use strict";

const db = require("../config/postgres");

function int(value, min, max, fallback) {
  const n = Number.parseInt(String(value == null ? "" : value), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function decimal(value, min = -10000, max = 10000) {
  const raw = String(value == null ? "" : value).trim().replace(",", ".");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
}
function text(value, max = 250) { return String(value == null ? "" : value).trim().slice(0, max); }
function isoDate(value, fallback) { const s = text(value, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback; }
function todayIso() { return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function daysAgoIso(days) { const d = new Date(); d.setDate(d.getDate() - days); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

function stockCte() {
  return `with sales as (
    select oi.sku,
      coalesce(sum(oi.quantity),0)::numeric as sold_units,
      count(distinct o.id)::int as order_count,
      max(o.purchased_at) as last_sale_at
    from magalu.order_items oi
    join magalu.orders o on o.id=oi.order_id and o.account_id=oi.account_id
    where oi.account_id=$1 and o.is_present=true
      and o.purchased_at >= now()-($2::int * interval '1 day')
      and lower(coalesce(o.status,'')) not in ('cancelled','canceled')
      and oi.sku is not null and oi.sku<>''
    group by oi.sku
  ), base as (
    select s.sku,s.title,s.status,s.active,
      coalesce(st.quantity,0)::numeric as stock_quantity,
      p.price,c.unit_cost,
      coalesce(sa.sold_units,0)::numeric as sold_units,
      coalesce(sa.order_count,0)::int as order_count,
      sa.last_sale_at,
      case when coalesce(sa.sold_units,0)>0 then coalesce(st.quantity,0)::numeric/(sa.sold_units/$2::numeric) else null end as coverage_days,
      case when coalesce(sa.sold_units,0)>0 then greatest(ceil((sa.sold_units/$2::numeric)*30-coalesce(st.quantity,0)),0)::numeric else 0::numeric end as suggested_units
    from magalu.skus s
    left join magalu.stocks st on st.account_id=s.account_id and st.sku=s.sku and st.is_present=true
    left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku and p.is_present=true
    left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
    left join sales sa on sa.sku=s.sku
    where s.account_id=$1 and s.is_present=true
  ), scored as (
    select *,
      case
        when stock_quantity<=0 then 'critical'
        when coverage_days is not null and coverage_days<=7 then 'critical'
        when coverage_days is not null and coverage_days<=15 then 'attention'
        when sold_units<=0 then 'no_sales'
        else 'healthy'
      end as risk,
      case when unit_cost is not null then suggested_units*unit_cost else null end as suggested_value
    from base
  )`;
}

async function stockAnalysis(accountId, options = {}) {
  const days = [30,60,90].includes(Number(options.days)) ? Number(options.days) : 30;
  const q = text(options.q, 200).toLowerCase();
  const view = ["all","replacement","no_sales"].includes(String(options.view)) ? String(options.view) : "all";
  const page = int(options.page,1,100000,1), limit=int(options.limit,1,100,50), offset=(page-1)*limit;
  const summary = await db.queryOne(`${stockCte()}
    select count(*)::int total,
      count(*) filter(where stock_quantity<=0)::int zero_stock,
      count(*) filter(where risk='critical')::int critical,
      count(*) filter(where risk='attention')::int attention,
      count(*) filter(where risk='no_sales')::int no_sales,
      round(avg(coverage_days) filter(where coverage_days is not null),1) as average_coverage_days,
      coalesce(sum(suggested_units),0)::numeric as suggested_units,
      coalesce(sum(suggested_value) filter(where suggested_value is not null),0)::numeric as suggested_value,
      count(*) filter(where suggested_units>0 and unit_cost is not null)::int suggested_value_known
    from scored`, [Number(accountId),days]);

  const params=[Number(accountId),days];
  const where=[];
  if(q){params.push(`%${q}%`);where.push(`(lower(sku) like $${params.length} or lower(coalesce(title,'')) like $${params.length})`);}
  if(view==="replacement") where.push(`risk in ('critical','attention')`);
  if(view==="no_sales") where.push(`risk='no_sales'`);
  params.push(limit,offset);
  const li=params.length-1, oi=params.length;
  const {rows}=await db.query(`${stockCte()}
    select *,count(*) over()::int as total_count from scored
    ${where.length?`where ${where.join(" and ")}`:""}
    order by case risk when 'critical' then 1 when 'attention' then 2 when 'no_sales' then 3 else 4 end,
      coverage_days asc nulls last, sold_units desc, sku asc
    limit $${li} offset $${oi}`, params);
  return { days, view, q, summary: summary || {}, rows, total:rows.length?Number(rows[0].total_count||0):0, page, limit };
}

function costBaseCte(){return `with base as (
  select s.sku,s.title,p.price,c.unit_cost,coalesce(nullif(f.aliquota,0),c.tax_rate,0) as tax_rate,c.packaging_cost,c.operational_cost,c.other_cost,c.notes,c.updated_at,
    coalesce(h.previous_cost>0 and h.new_cost>h.previous_cost*1.05,false) as cost_up,
    case when p.price is not null and p.price>0 and c.unit_cost is not null then
      p.price - c.unit_cost - (p.price*coalesce(nullif(f.aliquota,0),c.tax_rate,0)/100) - coalesce(c.packaging_cost,0) - coalesce(c.operational_cost,0) - coalesce(c.other_cost,0)
    else null end as known_result,
    case when p.price is not null and p.price>0 and c.unit_cost is not null then
      ((p.price - c.unit_cost - (p.price*coalesce(nullif(f.aliquota,0),c.tax_rate,0)/100) - coalesce(c.packaging_cost,0) - coalesce(c.operational_cost,0) - coalesce(c.other_cost,0))/p.price)*100
    else null end as known_margin_pct
  from magalu.skus s
  left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku and p.is_present=true
  left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
  left join magalu.finance_settings f on f.account_id=s.account_id
  left join lateral (select previous_cost,new_cost from magalu.sku_cost_history
    where account_id=s.account_id and sku=s.sku and created_at>=now()-interval '30 days'
    order by created_at desc,id desc limit 1) h on true
  where s.account_id=$1 and s.is_present=true
)`;}

async function costOverview(accountId){
  const summary=await db.queryOne(`${costBaseCte()}
    select count(*)::int total_skus,
      count(*) filter(where price is not null)::int priced_skus,
      count(*) filter(where unit_cost is not null)::int costed_skus,
      count(*) filter(where unit_cost is null)::int missing_cost,
      count(*) filter(where unit_cost is null or known_margin_pct<=10 or cost_up)::int attention_count,
      count(*) filter(where cost_up)::int cost_up,
      count(*) filter(where price is not null and unit_cost is not null and unit_cost>=price)::int cost_at_or_above_price,
      count(*) filter(where known_margin_pct is not null and known_margin_pct<=10)::int known_margin_attention,
      round(case when count(*)>0 then
        100.0*count(*) filter(where unit_cost is not null)/count(*) else 0 end,2) as coverage_pct
    from base`,[Number(accountId)]);
  const {rows}=await db.query(`${costBaseCte()}
    select * from base where price is not null
    order by case when cost_up then 0 when unit_cost is null then 1 when known_margin_pct<0 then 2 when known_margin_pct<=10 then 3 else 4 end,
      known_margin_pct asc nulls first, sku asc limit 12`,[Number(accountId)]);
  return {summary:summary||{},ranking:rows};
}

function marginOrderCte(){return `with item_costs as (
  select o.id as order_id,
    count(oi.id)::int as synced_item_rows,
    coalesce(sum(case when c.unit_cost is not null then c.unit_cost*coalesce(oi.quantity,0) else 0 end),0)::numeric as product_cost,
    coalesce(sum(case when c.unit_cost is not null then coalesce(oi.amount_total::numeric,oi.unit_price::numeric*coalesce(oi.quantity,0))/nullif(oi.amount_normalizer,0) else 0 end),0)::numeric as tax_base,
    coalesce(sum(case when c.unit_cost is not null then (coalesce(oi.amount_total::numeric,oi.unit_price::numeric*coalesce(oi.quantity,0))/nullif(oi.amount_normalizer,0))*coalesce(nullif(f.aliquota,0),c.tax_rate,0)/100 else 0 end),0)::numeric as taxes,
    coalesce(sum(case when c.unit_cost is not null then (coalesce(c.packaging_cost,0)+coalesce(c.operational_cost,0)+coalesce(c.other_cost,0))*coalesce(oi.quantity,0) else 0 end),0)::numeric as operating_costs,
    count(*) filter(where oi.id is not null and c.unit_cost is null)::int as missing_cost_rows,
    coalesce(sum(oi.quantity),0)::numeric as units
  from magalu.orders o
  left join magalu.order_items oi on oi.order_id=o.id and oi.account_id=o.account_id
  left join magalu.sku_costs c on c.account_id=oi.account_id and c.sku=oi.sku
  left join magalu.finance_settings f on f.account_id=o.account_id
  where o.account_id=$1 and o.is_present=true
    and o.purchased_at >= $2::date and o.purchased_at < ($3::date + interval '1 day')
    and lower(coalesce(o.status,'')) not in ('cancelled','canceled')
  group by o.id
), prepared as (
  select o.id,o.code,o.status,o.purchased_at,o.item_count,oi_first.sku as first_sku,oi_first.name as first_product,
    case when o.amount_total is not null and coalesce(o.amount_normalizer,0)>0 then o.amount_total::numeric/o.amount_normalizer else 0 end as gmv,
    coalesce(ic.product_cost,0)::numeric as product_cost,
    coalesce(ic.tax_base,0)::numeric as tax_base,
    coalesce(ic.taxes,0)::numeric as taxes,
    coalesce(ic.operating_costs,0)::numeric as operating_costs,
    (fr.order_code is not null and fr.transaction_count>0) as financial_report_present,
    fr.fetched_at as financial_fetched_at,
    fr.sale as sale,fr.commission as commission,fr.fees as fees,fr.shipping_net as shipping_net,
    fr.promotion_net as promotion_net,fr.subsidy as subsidy,fr.discount_net as discount_net,
    fr.refund_net as refund_net,fr.other_net as other_net,fr.net_receivable as net_receivable,
    d.shipping_name,d.shipping_type,d.is_fulfillment,
    (coalesce(ic.missing_cost_rows,0)
      + greatest(coalesce(o.item_count,0)-coalesce(ic.synced_item_rows,0),
          case when coalesce(ic.synced_item_rows,0)=0 then 1 else 0 end))::int as missing_cost_items,
    coalesce(ic.units,0)::numeric as units
  from magalu.orders o left join item_costs ic on ic.order_id=o.id
  left join magalu.order_financial_reports fr on fr.account_id=o.account_id and fr.order_code=o.code
  left join lateral (select shipping_name,shipping_type,is_fulfillment from magalu.deliveries d
    where d.account_id=o.account_id and d.order_code=o.code and d.is_present=true
    order by d.updated_at desc limit 1) d on true
  left join lateral (select sku,name from magalu.order_items oi where oi.order_id=o.id
    order by oi.id limit 1) oi_first on true
  where o.account_id=$1 and o.is_present=true
    and o.purchased_at >= $2::date and o.purchased_at < ($3::date + interval '1 day')
    and lower(coalesce(o.status,'')) not in ('cancelled','canceled')
), base as (
  select *,
    case when missing_cost_items=0 and financial_report_present then net_receivable-product_cost-taxes-operating_costs else null end as known_result,
    case when missing_cost_items=0 and financial_report_present and gmv>0 then round(((net_receivable-product_cost-taxes-operating_costs)/gmv)*100,2) else null end as known_margin_pct,
    case when missing_cost_items=0 and financial_report_present and units>0 then (gmv-(net_receivable-product_cost-taxes-operating_costs))/units else null end as break_even_per_unit,
    case when missing_cost_items=0 and financial_report_present and units>0 then (net_receivable-product_cost-taxes-operating_costs)/units else null end as headroom_per_unit,
    (missing_cost_items=0) as cost_complete,
    (missing_cost_items=0 and financial_report_present) as result_complete
  from prepared
)`;}

function marginFilters(options, start, end) {
  const q=text(options.q,200).toLowerCase(),status=text(options.status,80).toLowerCase();
  const costCoverage=["complete","incomplete"].includes(options.cost_coverage) ? options.cost_coverage : "";
  const marginState=["negative","attention","healthy","unknown"].includes(options.margin_state) ? options.margin_state : "";
  let marginMin=decimal(options.margin_min), marginMax=decimal(options.margin_max);
  if (marginMin != null && marginMax != null && marginMin > marginMax) [marginMin,marginMax]=[marginMax,marginMin];
  const params=[Number(options.accountId),start,end], where=[];
  if(status){params.push(status);where.push(`lower(coalesce(status,''))=$${params.length}`);}
  if(q){params.push(`%${q}%`);where.push(`(lower(code) like $${params.length} or exists(
    select 1 from magalu.order_items oi where oi.order_id=base.id
      and (lower(coalesce(oi.sku,'')) like $${params.length} or lower(coalesce(oi.name,'')) like $${params.length})
  ))`);}
  if(costCoverage === "complete") where.push("cost_complete=true");
  if(costCoverage === "incomplete") where.push("cost_complete=false");
  if(marginState === "negative") where.push("result_complete=true and known_margin_pct<0");
  if(marginState === "attention") where.push("result_complete=true and known_margin_pct>=0 and known_margin_pct<=10");
  if(marginState === "healthy") where.push("result_complete=true and known_margin_pct>10");
  if(marginState === "unknown") where.push("result_complete=false");
  if(marginMin != null){params.push(marginMin);where.push(`known_margin_pct>=$${params.length}`);}
  if(marginMax != null){params.push(marginMax);where.push(`known_margin_pct<=$${params.length}`);}
  return {params,where};
}

async function marginOverview(accountId, options={}){
  const to=isoDate(options.to,todayIso()), from=isoDate(options.from,daysAgoIso(6));
  const start=from<=to?from:to,end=from<=to?to:from;
  const filtered=marginFilters({...options,accountId},start,end);
  const whereSql=filtered.where.length?`where ${filtered.where.join(" and ")}`:"";
  const summary=await db.queryOne(`${marginOrderCte()}
    select count(*)::int orders,
      coalesce(sum(gmv),0)::numeric gmv,
      count(*) filter(where result_complete)::int complete_orders,
      count(*) filter(where not result_complete)::int incomplete_orders,
      coalesce(sum(gmv) filter(where result_complete),0)::numeric covered_gmv,
      coalesce(sum(gmv) filter(where not result_complete),0)::numeric incomplete_gmv,
      coalesce(sum(product_cost) filter(where result_complete),0)::numeric product_cost,
      coalesce(sum(taxes) filter(where result_complete),0)::numeric taxes,
      coalesce(sum(operating_costs) filter(where result_complete),0)::numeric operating_costs,
      coalesce(sum(known_result) filter(where result_complete),0)::numeric known_result,
      coalesce(sum(missing_cost_items),0)::int missing_cost_items,
      count(*) filter(where not cost_complete)::int orders_with_missing_cost,
      count(*) filter(where not financial_report_present)::int orders_without_financial_report,
      count(*) filter(where result_complete and known_result<0)::int negative_orders,
      count(*) filter(where result_complete and known_margin_pct<=10)::int low_margin_orders,
      case when coalesce(sum(gmv) filter(where result_complete),0)>0
        then round((sum(known_result) filter(where result_complete)/sum(gmv) filter(where result_complete))*100,2)
        else null end as known_margin_pct
    from base ${whereSql}`,filtered.params);

  const page=int(options.page,1,100000,1),limit=int(options.limit,1,100,40),offset=(page-1)*limit;
  const rowParams=[...filtered.params,limit,offset],li=rowParams.length-1,oi=rowParams.length;
  const {rows}=await db.query(`${marginOrderCte()}
    select *,count(*) over()::int total_count
    from base ${whereSql}
    order by purchased_at desc nulls last,id desc limit $${li} offset $${oi}`,rowParams);
  const best=await db.queryOne(`${marginOrderCte()}
    select code,known_result,gmv from base ${whereSql}${whereSql?" and":" where"} result_complete=true
    order by known_result desc nulls last limit 1`,filtered.params);

  return {from:start,to:end,summary:summary||{},best:best||null,rows,total:rows.length?Number(rows[0].total_count||0):0,page,limit,
    limitations:{
      commission:true,platform_fees:true,seller_shipping:true,
      message:"Resultado conhecido inclui as transações financeiras recebidas do Magalu e considera somente pedidos com relatório financeiro e custo cadastrado. Pedidos sem qualquer uma dessas fontes permanecem incompletos. O imposto global cadastrado e os custos adicionais informados são abatidos separadamente."
    }};
}

async function equilibrium(accountId,options={}){
  const q=text(options.q,200).toLowerCase();
  const state=["below","attention","healthy","missing"].includes(options.state) ? options.state : "";
  const params=[Number(accountId)]; const where=["account_id=$1","is_present=true"];
  if(q){params.push(`%${q}%`);where.push(`(lower(sku) like $${params.length} or lower(coalesce(title,'')) like $${params.length})`);}
  if(state === "below") where.push("unit_cost is not null and known_break_even is not null and price<known_break_even");
  if(state === "attention") where.push("unit_cost is not null and known_break_even is not null and price>=known_break_even and known_margin_pct<=10");
  if(state === "healthy") where.push("unit_cost is not null and known_margin_pct>10");
  if(state === "missing") where.push("unit_cost is null");
  const limit=int(options.limit,1,100,50),offset=int(options.offset,0,1000000,0);params.push(limit,offset);const li=params.length-1,oi=params.length;
  const {rows}=await db.query(`with base as (select s.account_id,s.is_present,s.sku,s.title,p.price,c.unit_cost,coalesce(nullif(f.aliquota,0),c.tax_rate,0) as tax_rate,c.packaging_cost,c.operational_cost,c.other_cost,
    case when c.unit_cost is not null and (1-coalesce(nullif(f.aliquota,0),c.tax_rate,0)/100)>0 then
      (c.unit_cost+coalesce(c.packaging_cost,0)+coalesce(c.operational_cost,0)+coalesce(c.other_cost,0))/(1-coalesce(nullif(f.aliquota,0),c.tax_rate,0)/100)
    else null end as known_break_even,
    case when p.price is not null and p.price>0 and c.unit_cost is not null then
      ((p.price-c.unit_cost-(p.price*coalesce(nullif(f.aliquota,0),c.tax_rate,0)/100)-coalesce(c.packaging_cost,0)-coalesce(c.operational_cost,0)-coalesce(c.other_cost,0))/p.price)*100
    else null end as known_margin_pct,
    count(*) over()::int as unfiltered_total_count
    from magalu.skus s left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku and p.is_present=true
    left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
    left join magalu.finance_settings f on f.account_id=s.account_id
  ) select *,count(*) over()::int as total_count from base
    where ${where.join(" and ")} order by known_margin_pct asc nulls first,sku asc limit $${li} offset $${oi}`,params);
  return {rows,total:rows.length?Number(rows[0].total_count||0):0,limit,offset,
    limitations:{message:"Equilíbrio conhecido considera custo cadastrado, imposto informado e custos operacionais. Comissão, tarifa e frete Magalu não estão incluídos."}};
}

module.exports={stockAnalysis,costOverview,marginOverview,equilibrium,_test:{int,decimal,text,isoDate,marginFilters}};
