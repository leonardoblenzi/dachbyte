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
  // "Apenas estoque > 0": usa o estoque gravado na última sincronização do catálogo.
  // Reduz o recorte (e as consultas à Magalu) aos SKUs que podem vender.
  const stock=String(input.stock||"");
  if(stock&&stock!=="positive")throw invalid("Filtro de estoque inválido.");
  if(stock==="positive")where.push(`exists(select 1 from magalu.stocks st where st.account_id=s.account_id and st.sku=s.sku and st.is_present=true and st.quantity>0)`);
  const category=String(input.category||"").trim();
  if(category.length>128)throw invalid("Categoria muito longa.");
  if(category){params.push(category);where.push(`s.category_id=$${params.length}`);}
  const q=String(input.q||"").trim(),type=String(input.search_type||"sku");
  if(q.length>20000)throw invalid("Lista muito longa. Divida a busca em partes.",413);
  if(!["sku","ean","group","product"].includes(type))throw invalid("Tipo de busca inválido.");
  if(q){
    const values=type==="product"?[]:[...new Set(q.split(/[,;\r\n]+/).map(value=>value.trim().toLowerCase()).filter(Boolean))];
    if(type!=="product"&&!values.length)throw invalid("Informe ao menos um identificador.");
    if(type==="ean"){params.push(values);where.push(`exists(select 1 from jsonb_array_elements(coalesce(s.payload->'identifiers','[]'::jsonb)) i where lower(i->>'type')='ean' and lower(i->>'value')=any($${params.length}::text[]))`);}
    else if(type==="group"){params.push(values);where.push(`lower(coalesce(s.group_id,''))=any($${params.length}::text[])`);}
    else if(type==="sku"&&values.length>1){params.push(values);where.push(`lower(s.sku)=any($${params.length}::text[])`);}
    else{params.push(`%${type==="product"?q.toLowerCase():values[0]}%`);where.push(`lower(${type==="product"?"coalesce(s.title,'')":"s.sku"}) like $${params.length}`);}
  }
  return{where,params};
}
async function count(accountId,options={}){const f=filters({...options,accountId});const row=await db.queryOne(`select count(*)::int total from magalu.skus s where ${f.where.join(" and ")}`,f.params);return Number(row?.total||0);}
async function pageSkus(accountId,options={},after=null,limit=MAX_REFRESH){const f=filters({...options,accountId});if(after!==null){f.params.push(after);f.where.push(`s.sku>$${f.params.length}`);}const size=Math.min(MAX_REFRESH,Math.max(1,Number(limit)||MAX_REFRESH));const {rows}=await db.query(`select s.sku from magalu.skus s where ${f.where.join(" and ")} order by s.sku limit $${f.params.length+1}`,[...f.params,size]);return rows.map(row=>row.sku);}
async function list(accountId,options={}){
  const f=filters({...options,accountId});
  const page=Math.max(1,Math.floor(Number(options.page)||1)),limit=Math.min(100,Math.max(1,Math.floor(Number(options.limit)||50)));
  const count=await db.queryOne(`select count(*)::int total from magalu.skus s where ${f.where.join(" and ")}`,f.params);
  const previewId=options.preview_id||null,previewParam=f.params.length+1;
  const {rows}=await db.query(`select s.sku,s.title,s.status,s.active,s.group_id,s.category_id,
    (select i->>'value' from jsonb_array_elements(coalesce(s.payload->'identifiers','[]'::jsonb)) i where lower(i->>'type')='ean' limit 1) ean,
    c.unit_cost,p.price,p.list_price,p.last_synced_at as price_synced_at,p.last_error as price_error,p.is_present as price_present,
    (select case when r.result->>'eligible'='true' then (r.result->>'suggested_price')::numeric end from magalu.promo_pricing_preview_rows r where r.preview_id=$${previewParam} and r.sku=s.sku) suggested_price,
    t.aliquota as tax_rate
    from magalu.skus s left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku
    left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
    left join magalu.finance_settings t on t.account_id=s.account_id
    where ${f.where.join(" and ")} order by s.sku limit $${f.params.length+2} offset $${f.params.length+3}`,[...f.params,previewId,limit,(page-1)*limit]);
  return{rows,total:Number(count?.total||0),page,limit};
}
async function detailsPage(accountId,options={},after=null,limit=1000){
  const f=filters({...options,accountId});
  if(after!==null){f.params.push(after);f.where.push(`s.sku>$${f.params.length}`);}
  const size=Math.min(MAX_REFRESH,Math.max(1,Number(limit)||1000));
  const {rows}=await db.query(`select s.sku,s.title,s.status,s.active,s.group_id,s.category_id,
    (select i->>'value' from jsonb_array_elements(coalesce(s.payload->'identifiers','[]'::jsonb)) i where lower(i->>'type')='ean' limit 1) ean,
    c.unit_cost,c.updated_at as cost_updated_at,p.price,p.list_price,p.last_synced_at as price_synced_at,p.last_error as price_error,p.is_present as price_present,t.aliquota as tax_rate,t.updated_at as tax_updated_at
    from magalu.skus s left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku
    left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
    left join magalu.finance_settings t on t.account_id=s.account_id
    where ${f.where.join(" and ")} order by s.sku limit $${f.params.length+1}`,[...f.params,size]);
  return rows;
}
// Exportacao do recorte filtrado inteiro (sem paginacao). Com revisao calculada,
// traz tambem o resultado de cada SKU (sugerido, Pix e margens).
const MAX_EXPORT=60000;
async function exportRows(accountId,options={}){
  const f=filters({...options,accountId});
  const total=await db.queryOne(`select count(*)::int total from magalu.skus s where ${f.where.join(" and ")}`,f.params);
  if(Number(total?.total||0)>MAX_EXPORT)throw invalid(`O recorte tem mais de ${MAX_EXPORT.toLocaleString("pt-BR")} SKUs. Filtre antes de exportar.`,413);
  const previewId=options.preview_id||null,previewParam=f.params.length+1;
  const {rows}=await db.query(`select s.sku,s.title,s.status,s.active,s.group_id,s.category_id,
    (select i->>'value' from jsonb_array_elements(coalesce(s.payload->'identifiers','[]'::jsonb)) i where lower(i->>'type')='ean' limit 1) ean,
    c.unit_cost,p.price,p.list_price,p.last_synced_at as price_synced_at,p.last_error as price_error,p.is_present as price_present,
    t.aliquota as tax_rate,r.result as preview_result
    from magalu.skus s left join magalu.prices p on p.account_id=s.account_id and p.sku=s.sku
    left join magalu.sku_costs c on c.account_id=s.account_id and c.sku=s.sku
    left join magalu.finance_settings t on t.account_id=s.account_id
    left join magalu.promo_pricing_preview_rows r on r.preview_id=$${previewParam}::uuid and r.sku=s.sku
    where ${f.where.join(" and ")} order by s.sku`,[...f.params,previewId]);
  return rows;
}
module.exports={filters,list,count,pageSkus,detailsPage,exportRows,MAX_REFRESH,MAX_EXPORT};
