"use strict";
const db=require("../config/postgres");
const MAX_REFRESH=5000;
function invalid(message,status=422){const e=new Error(message);e.status=status;return e;}
function filters(input={}){
  const accountId=Number(input.accountId);
  if(!Number.isSafeInteger(accountId)||accountId<=0)throw invalid("Conta inválida.");
  const where=["s.account_id=$1","s.is_present=true"],params=[accountId];
  const publication=String(input.publication||"").toUpperCase();
  if(publication&&! ["PUBLISHED","UNPUBLISHED","BLOCKED","UNDER_REVIEW"].includes(publication))throw invalid("Status de publicação inválido.");
  if(publication){params.push(publication);where.push(`s.status=$${params.length}`);}
  const activity=String(input.activity||"");
  if(activity&&! ["active","inactive"].includes(activity))throw invalid("Atividade inválida.");
  if(activity)where.push(`s.active=${activity==="active"?"true":"false"}`);
  const category=String(input.category||"").trim();
  if(category.length>128)throw invalid("Categoria muito longa.");
  if(category){params.push(category);where.push(`s.category_id=$${params.length}`);}
  const q=String(input.q||"").trim(),type=String(input.search_type||"sku");
  if(q.length>200)throw invalid("Busca muito longa.",413);
  if(!["sku","ean","group","product"].includes(type))throw invalid("Tipo de busca inválido.");
  if(q){
    if(type==="ean"){params.push(q.toLowerCase());where.push(`exists(select 1 from jsonb_array_elements(coalesce(s.payload->'identifiers','[]'::jsonb)) i where lower(i->>'type')='ean' and lower(i->>'value')=$${params.length})`);}
    else if(type==="group"){params.push(q.toLowerCase());where.push(`lower(coalesce(s.group_id,''))=$${params.length}`);}
    else{params.push(`%${q.toLowerCase()}%`);where.push(`lower(${type==="product"?"coalesce(s.title,'')":"s.sku"}) like $${params.length}`);}
  }
  return{where,params};
}
function validateRefreshCount(count){const n=Number(count);if(!Number.isSafeInteger(n)||n<1)throw invalid("Nenhum SKU no recorte.",409);if(n>MAX_REFRESH)throw invalid(`A atualização aceita até ${MAX_REFRESH} SKUs por vez. Refine os filtros.`,413);return n;}
async function list(accountId,options={}){
  const f=filters({...options,accountId});
  const page=Math.max(1,Math.floor(Number(options.page)||1)),limit=Math.min(100,Math.max(1,Math.floor(Number(options.limit)||50)));
  const count=await db.queryOne(`select count(*)::int total from magalu.skus s where ${f.where.join(" and ")}`,f.params);
  const {rows}=await db.query(`select s.sku,s.title,s.status,s.active,s.group_id,s.category_id,
    (select i->>'value' from jsonb_array_elements(coalesce(s.payload->'identifiers','[]'::jsonb)) i where lower(i->>'type')='ean' limit 1) ean,
    c.unit_cost,p.price,p.list_price,p.last_synced_at as price_synced_at,p.last_error as price_error,p.is_present as price_present,
    t.aliquota as tax_rate
    from magalu.skus s left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku
    left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
    left join magalu.finance_settings t on t.account_id=s.account_id
    where ${f.where.join(" and ")} order by s.sku limit $${f.params.length+1} offset $${f.params.length+2}`,[...f.params,limit,(page-1)*limit]);
  return{rows,total:Number(count?.total||0),page,limit};
}
async function snapshot(accountId,options={}){
  const f=filters({...options,accountId});
  const {rows}=await db.query(`select s.sku from magalu.skus s where ${f.where.join(" and ")} order by s.sku limit $${f.params.length+1}`,[...f.params,MAX_REFRESH+1]);
  validateRefreshCount(rows.length);
  return rows.map(row=>row.sku);
}
async function details(accountId,options={}){
  const f=filters({...options,accountId});
  const {rows}=await db.query(`select s.sku,s.title,s.status,s.active,s.group_id,s.category_id,
    (select i->>'value' from jsonb_array_elements(coalesce(s.payload->'identifiers','[]'::jsonb)) i where lower(i->>'type')='ean' limit 1) ean,
    c.unit_cost,c.updated_at as cost_updated_at,p.price,p.list_price,p.last_synced_at as price_synced_at,p.last_error as price_error,p.is_present as price_present,t.aliquota as tax_rate,t.updated_at as tax_updated_at
    from magalu.skus s left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku
    left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
    left join magalu.finance_settings t on t.account_id=s.account_id
    where ${f.where.join(" and ")} order by s.sku limit $${f.params.length+1}`,[...f.params,MAX_REFRESH+1]);
  validateRefreshCount(rows.length);return rows;
}
module.exports={filters,validateRefreshCount,list,snapshot,details,MAX_REFRESH};
