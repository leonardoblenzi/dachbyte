"use strict";
const { randomUUID } = require("node:crypto");
const db = require("../config/postgres");
const skuMass = require("./skuMassRepository");

function error(message,status=422){const e=new Error(message);e.status=status;return e;}
function normalizeIdentifiers(values,maxLength=128){
  if(!Array.isArray(values)||values.length>1000)throw error("Envie até 1.000 identificadores por parte.",413);
  const result=[];const seen=new Set();
  for(const value of values){const id=String(value??"").trim();if(!id)continue;if(id.length>maxLength)throw error(`Identificador com mais de ${maxLength} caracteres: ${id.slice(0,30)}...`);const key=id.toLowerCase();if(!seen.has(key)){seen.add(key);result.push(id);}}
  return result;
}
async function create({accountId,tenantId,userId,searchType,status,active}){
  if(!["sku","ean","group"].includes(searchType))throw error("Tipo de busca inválido.");
  const id=randomUUID();
  await db.query(`insert into magalu.sku_bulk_selections(id,account_id,dach_tenant_id,dach_user_id,search_type,status_filter,active_filter) values($1,$2,$3,$4,$5,$6,$7)`,[id,Number(accountId),String(tenantId),String(userId),searchType,status||null,active==="true"?true:active==="false"?false:null]);
  return {id};
}
async function get(id,accountId,tenantId,userId,client=db,locked=false){
  const result=await client.query(`select * from magalu.sku_bulk_selections where id=$1 and account_id=$2 and dach_tenant_id=$3 and dach_user_id=$4 and expires_at>now()${locked?" for update":""}`,[id,Number(accountId),String(tenantId),String(userId)]);
  return result.rows[0]||null;
}
async function append(id,identity,values){
  const identifiers=normalizeIdentifiers(values);if(!identifiers.length)return{added:0};
  return db.withClient(async client=>{await client.query("begin");try{
    const selection=await get(id,identity.accountId,identity.tenantId,identity.userId,client,true);
    if(!selection||selection.state!=="building")throw error("Seleção expirada ou já finalizada.",409);
    if(selection.search_type==="sku")normalizeIdentifiers(values,64);
    const inserted=await client.query(`insert into magalu.sku_bulk_identifiers(selection_id,identifier) select $1,unnest($2::text[]) on conflict do nothing`,[id,identifiers]);
    await client.query("commit");return{added:inserted.rowCount||0};
  }catch(e){await client.query("rollback");throw e;}});
}
function matchingQuery(type){
  const source=type==="ean"?`select i.identifier,s.sku from magalu.skus s cross join lateral jsonb_array_elements(coalesce(s.payload->'identifiers','[]'::jsonb)) marker join magalu.sku_bulk_identifiers i on i.selection_id=$1 and lower(i.identifier)=lower(marker->>'value') where s.account_id=$2 and s.is_present=true and lower(marker->>'type')='ean'`:
    `select i.identifier,s.sku from magalu.sku_bulk_identifiers i join magalu.skus s on s.account_id=$2 and s.is_present=true and lower(${type==="group"?"s.group_id":"s.sku"})=lower(i.identifier) where i.selection_id=$1`;
  return `select distinct matched.identifier,matched.sku from (${source}) matched join magalu.skus filtered on filtered.account_id=$2 and filtered.sku=matched.sku where ($3::text is null or filtered.status=$3) and ($4::boolean is null or filtered.active=$4)`;
}
async function finalize(id,identity){
  return db.withClient(async client=>{await client.query("begin");try{
    const selection=await get(id,identity.accountId,identity.tenantId,identity.userId,client,true);
    if(!selection||selection.state!=="building")throw error("Seleção expirada ou já finalizada.",409);
    const params=[id,Number(identity.accountId),selection.status_filter,selection.active_filter],matching=matchingQuery(selection.search_type);
    await client.query(`insert into magalu.sku_bulk_matches(selection_id,sku) select $1,sku from (${matching}) result where true on conflict do nothing`,params);
    await client.query(`insert into magalu.sku_bulk_found_identifiers(selection_id,identifier) select $1,identifier from (${matching}) result where true on conflict do nothing`,params);
    const invalid=await client.query(`select sku from magalu.sku_bulk_matches where selection_id=$1 and length(sku)>64 limit 1`,[id]);
    if(invalid.rows.length)throw error("Há SKU sincronizado com mais de 64 caracteres; esta operação não pode processá-lo sem alterar o identificador.");
    const counts=await client.query(`select (select count(*) from magalu.sku_bulk_identifiers where selection_id=$1)::int identifier_count,(select count(*) from magalu.sku_bulk_matches where selection_id=$1)::int matched_count,(select count(*) from magalu.sku_bulk_identifiers i where i.selection_id=$1 and not exists(select 1 from magalu.sku_bulk_found_identifiers f where f.selection_id=i.selection_id and f.identifier=i.identifier))::int missing_count`,[id]);
    const summary=counts.rows[0];await client.query(`update magalu.sku_bulk_selections set state='ready',identifier_count=$2,matched_count=$3,missing_count=$4 where id=$1`,[id,summary.identifier_count,summary.matched_count,summary.missing_count]);
    await client.query("commit");return{id,...summary};
  }catch(e){await client.query("rollback");throw e;}});
}
async function page(id,identity,page=1,limit=50){
  const selection=await get(id,identity.accountId,identity.tenantId,identity.userId);
  if(!selection||selection.state!=="ready")throw error("Seleção não encontrada.",404);
  const safePage=Math.max(1,Math.floor(Number(page)||1)),safeLimit=Math.min(100,Math.max(1,Math.floor(Number(limit)||50)));
  const {rows}=await db.query(`select s.sku,s.title,s.status,s.active,s.last_synced_at,s.updated_at,
    (select marker->>'value' from jsonb_array_elements(coalesce(s.payload->'identifiers','[]'::jsonb)) marker where lower(marker->>'type')='ean' limit 1) ean,s.group_id
    from magalu.sku_bulk_matches m join magalu.skus s on s.account_id=$2 and s.sku=m.sku
    where m.selection_id=$1 order by m.sku limit $3 offset $4`,[id,Number(identity.accountId),safeLimit,(safePage-1)*safeLimit]);
  const missing=await db.query(`select i.identifier from magalu.sku_bulk_identifiers i where i.selection_id=$1 and not exists(select 1 from magalu.sku_bulk_found_identifiers f where f.selection_id=i.selection_id and f.identifier=i.identifier) order by i.identifier limit 100`,[id]);
  return{rows,total:Number(selection.matched_count),page:safePage,limit:safeLimit,identifier_count:Number(selection.identifier_count),missing_count:Number(selection.missing_count),missing_identifiers:missing.rows.map(row=>row.identifier)};
}
async function missingPage(id,identity,offset=0){
  const selection=await get(id,identity.accountId,identity.tenantId,identity.userId);
  if(!selection||selection.state!=="ready")throw error("Seleção não encontrada.",404);
  const safeOffset=Math.max(0,Math.floor(Number(offset)||0));
  const {rows}=await db.query(`select i.identifier from magalu.sku_bulk_identifiers i where i.selection_id=$1 and not exists(select 1 from magalu.sku_bulk_found_identifiers f where f.selection_id=i.selection_id and f.identifier=i.identifier) order by i.identifier limit 100 offset $2`,[id,safeOffset]);
  return {rows:rows.map(row=>row.identifier),offset:safeOffset,total:Number(selection.missing_count)};
}
async function skuPage(id,identity,offset,limit){
  const selection=await get(id,identity.accountId,identity.tenantId,identity.userId);
  if(!selection||selection.state!=="ready")throw error("Seleção expirada.",409);
  const {rows}=await db.query(`select sku from magalu.sku_bulk_matches where selection_id=$1 order by sku limit $2 offset $3`,[id,limit,offset]);
  return{selection,skus:rows.map(row=>row.sku)};
}
async function createFromFilters(identity,filters){
  if(String(filters.q||"").length>200)throw error("A busca textual excede 200 caracteres. Use uma lista de identificadores.",413);
  const id=randomUUID(),f=skuMass._test.catalogWhere({...filters,accountId:identity.accountId});
  return db.withClient(async client=>{await client.query("begin");try{
    await client.query(`insert into magalu.sku_bulk_selections(id,account_id,dach_tenant_id,dach_user_id,search_type,state) values($1,$2,$3,$4,'sku','ready')`,[id,Number(identity.accountId),identity.tenantId,identity.userId]);
    await client.query(`insert into magalu.sku_bulk_matches(selection_id,sku) select $${f.params.length+1},s.sku from magalu.skus s where ${f.where.join(" and ")} on conflict do nothing`,[...f.params,id]);
    const invalid=await client.query(`select sku from magalu.sku_bulk_matches where selection_id=$1 and length(sku)>64 limit 1`,[id]);
    if(invalid.rows.length)throw error("Há SKU sincronizado com mais de 64 caracteres; use uma seleção compatível.");
    const count=await client.query(`select count(*)::int total from magalu.sku_bulk_matches where selection_id=$1`,[id]);
    await client.query(`update magalu.sku_bulk_selections set matched_count=$2 where id=$1`,[id,count.rows[0].total]);
    await client.query("commit");return{id,matched_count:count.rows[0].total};
  }catch(e){await client.query("rollback");throw e;}});
}
module.exports={create,append,finalize,page,missingPage,skuPage,get,createFromFilters,_test:{normalizeIdentifiers,matchingQuery}};
