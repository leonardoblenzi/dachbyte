"use strict";

const crypto = require("node:crypto");
const db = require("../config/postgres");
const env = require("../config/env");
const { normalizeAction, desiredActive, previewState, requestPayload, requestHash } = require("../services/skuMassPayload");

const ACTIVE_ITEM_STATES = ["queued","running","dispatching","accepted"];
const BLOCKING_ITEM_STATES = ["queued","running","dispatching","accepted","divergent","uncertain"];
const FINAL_ITEM_STATES = ["succeeded","stale","failed","divergent","uncertain","canceled"];
function clean(value,max=300){return String(value==null?"":value).trim().slice(0,max);}
function int(value,min,max,fallback){const n=Number.parseInt(String(value==null?"":value),10);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;}
function boolFilter(value){const v=clean(value,20).toLowerCase();if(["true","1","active","ativo","sim"].includes(v))return true;if(["false","0","inactive","inativo","nao","não"].includes(v))return false;return null;}

function catalogWhere(filters={}, alias="s") {
  const where=[`${alias}.account_id=$1`,`${alias}.is_present=true`], params=[Number(filters.accountId)];
  const q=clean(filters.q,200),status=clean(filters.status,80).toUpperCase(),active=boolFilter(filters.active);
  if(q){params.push(`%${q.toLowerCase()}%`);where.push(`(lower(${alias}.sku) like $${params.length} or lower(coalesce(${alias}.title,'')) like $${params.length})`);}
  if(status){params.push(status);where.push(`${alias}.status=$${params.length}`);}
  if(active!==null){params.push(active);where.push(`${alias}.active=$${params.length}`);}
  return{where,params};
}
async function listSkus(accountId,filters={}){
  const page=int(filters.page,1,100000,1),limit=int(filters.limit,1,100,50),offset=(page-1)*limit;
  const f=catalogWhere({...filters,accountId});
  const total=await db.queryOne(`select count(*)::int total from magalu.skus s where ${f.where.join(" and ")}`,f.params);
  const {rows}=await db.query(`select s.sku,s.title,s.status,s.active,s.brand,s.group_id,s.category_id,s.fulfillment,s.last_synced_at,s.updated_at
    from magalu.skus s where ${f.where.join(" and ")} order by s.updated_at desc,s.sku asc limit $${f.params.length+1} offset $${f.params.length+2}`,[...f.params,limit,offset]);
  return{rows,total:Number(total?.total||0),page,limit};
}
async function selectedRows(accountId,selection={}){
  const mode=clean(selection.mode,40)==="all_filtered"?"all_filtered":"explicit";
  if(mode==="all_filtered"){
    const f=catalogWhere({...(selection.filters||{}),accountId});
    const {rows}=await db.query(`select sku,title,status,active,last_synced_at,updated_at from magalu.skus s where ${f.where.join(" and ")} order by s.sku asc limit $${f.params.length+1}`,[...f.params,env.MAGALU_SKU_MAX_BATCH_SIZE+1]);
    return{mode,filters:selection.filters||{},rows};
  }
  const skus=Array.from(new Set((Array.isArray(selection.skus)?selection.skus:[]).map(v=>clean(v,64)).filter(Boolean)));
  if(skus.length>env.MAGALU_SKU_MAX_BATCH_SIZE){const e=new Error(`A seleção excede o máximo de ${env.MAGALU_SKU_MAX_BATCH_SIZE} SKUs.`);e.code="MAGALU_SKU_MASS_TOO_LARGE";e.status=400;throw e;}
  if(!skus.length)return{mode,filters:{},rows:[]};
  const {rows}=await db.query(`select sku,title,status,active,last_synced_at,updated_at from magalu.skus where account_id=$1 and is_present=true and sku=any($2::text[]) order by sku asc`,[Number(accountId),skus]);
  return{mode,filters:{skus},rows};
}
async function createPreview({accountId,dachTenantId,dachUserId,action,selection}){
  const normalized=normalizeAction(action),chosen=await selectedRows(accountId,selection);
  if(chosen.rows.length>env.MAGALU_SKU_MAX_BATCH_SIZE){const e=new Error(`A seleção excede o máximo de ${env.MAGALU_SKU_MAX_BATCH_SIZE} SKUs.`);e.code="MAGALU_SKU_MASS_TOO_LARGE";e.status=400;throw e;}
  if(!chosen.rows.length){const e=new Error("Nenhum SKU elegível foi encontrado para o preview.");e.code="MAGALU_SKU_MASS_EMPTY";e.status=409;throw e;}
  const wanted=desiredActive(normalized);
  const rows=chosen.rows.map(row=>{const before=previewState(row);return{sku:row.sku,title:row.title||null,before,requested:requestPayload(normalized),changed:before.active!==wanted,request_hash:requestHash({accountId,sku:row.sku,action:normalized,before})};});
  const id=crypto.randomUUID(),expiresAt=new Date(Date.now()+env.MAGALU_SKU_PREVIEW_TTL_SECONDS*1000).toISOString(),changeCount=rows.filter(r=>r.changed).length;
  const {rows:saved}=await db.query(`insert into magalu.sku_mass_previews(id,account_id,dach_tenant_id,dach_user_id,action,selection_mode,filter_payload,rows,selected_count,change_count,expires_at)
    values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11) returning *`,[id,Number(accountId),clean(dachTenantId,160),clean(dachUserId,160),normalized,chosen.mode,JSON.stringify(chosen.filters||{}),JSON.stringify(rows),rows.length,changeCount,expiresAt]);
  return saved[0];
}
async function getPreview(previewId,{dachTenantId,dachUserId}){return db.queryOne(`select * from magalu.sku_mass_previews where id=$1 and dach_tenant_id=$2 and dach_user_id=$3 limit 1`,[String(previewId),clean(dachTenantId,160),clean(dachUserId,160)]);}
async function createBatchFromPreview(previewId,{dachTenantId,dachUserId}){
  return db.withClient(async client=>{await client.query("begin");try{
    const p=(await client.query(`select * from magalu.sku_mass_previews where id=$1 and dach_tenant_id=$2 and dach_user_id=$3 for update`,[String(previewId),clean(dachTenantId,160),clean(dachUserId,160)])).rows[0];
    if(!p){const e=new Error("Preview massivo não encontrado.");e.code="MAGALU_SKU_PREVIEW_NOT_FOUND";e.status=404;throw e;}
    if(p.used_at){const e=new Error("Este preview já foi confirmado.");e.code="MAGALU_SKU_PREVIEW_USED";e.status=409;throw e;}
    if(new Date(p.expires_at).getTime()<=Date.now()){const e=new Error("O preview expirou. Gere um novo antes de aplicar.");e.code="MAGALU_SKU_PREVIEW_EXPIRED";e.status=409;throw e;}
    const candidates=(Array.isArray(p.rows)?p.rows:[]).filter(r=>r?.changed===true);
    if(!candidates.length){const e=new Error("O preview não possui mudanças para aplicar.");e.code="MAGALU_SKU_PREVIEW_NO_CHANGES";e.status=409;throw e;}
    const batchId=crypto.randomUUID();
    await client.query(`insert into magalu.mass_operation_batches(id,preview_id,account_id,dach_tenant_id,dach_user_id,action,total_count,pending_count) values($1,$2,$3,$4,$5,$6,$7,$7)`,[batchId,p.id,p.account_id,p.dach_tenant_id,p.dach_user_id,p.action,candidates.length]);
    const items=[];
    for(const row of candidates){
      const idempotency=crypto.randomUUID();
      const inserted=(await client.query(`insert into magalu.mass_operation_items(idempotency_key,batch_id,account_id,dach_tenant_id,dach_user_id,sku,action,request_hash,before_payload,requested_payload)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb) returning id,idempotency_key,batch_id,account_id,dach_tenant_id,dach_user_id,sku,action,status,request_hash,before_payload,requested_payload,created_at`,[idempotency,batchId,p.account_id,p.dach_tenant_id,p.dach_user_id,row.sku,p.action,row.request_hash,JSON.stringify(row.before||{}),JSON.stringify(row.requested||{})])).rows[0];
      items.push(inserted);
    }
    await client.query(`update magalu.sku_mass_previews set used_at=now() where id=$1`,[p.id]);await client.query("commit");return{batchId,preview:p,items};
  }catch(e){await client.query("rollback").catch(()=>{});if(String(e?.code||"")==="23505"){const conflict=new Error("Já existe uma operação massiva pendente/ambígua para pelo menos um dos SKUs selecionados.");conflict.code="MAGALU_SKU_ACTIVE_OPERATION_EXISTS";conflict.status=409;throw conflict;}throw e;}});
}
async function listBatches(dachTenantId,filters={}){
  const page=int(filters.page,1,100000,1),limit=int(filters.limit,1,100,30),offset=(page-1)*limit,where=["b.dach_tenant_id=$1"],params=[clean(dachTenantId,160)];
  const accountId=Number.parseInt(filters.accountId,10),status=clean(filters.status,40).toLowerCase();
  if(Number.isFinite(accountId)&&accountId>0){params.push(accountId);where.push(`b.account_id=$${params.length}`);}if(status){params.push(status);where.push(`b.status=$${params.length}`);}
  const total=await db.queryOne(`select count(*)::int total from magalu.mass_operation_batches b where ${where.join(" and ")}`,params);
  const {rows}=await db.query(`select b.*,a.magalu_tenant_id,a.magalu_tenant_name from magalu.mass_operation_batches b join magalu.accounts a on a.id=b.account_id where ${where.join(" and ")} order by b.created_at desc limit $${params.length+1} offset $${params.length+2}`,[...params,limit,offset]);
  return{rows,total:Number(total?.total||0),page,limit};
}
async function batchDetail(batchId,dachTenantId){const batch=await db.queryOne(`select b.*,a.magalu_tenant_id,a.magalu_tenant_name from magalu.mass_operation_batches b join magalu.accounts a on a.id=b.account_id where b.id=$1 and b.dach_tenant_id=$2`,[String(batchId),clean(dachTenantId,160)]);if(!batch)return null;const{rows}=await db.query(`select * from magalu.mass_operation_items where batch_id=$1 order by id asc`,[String(batchId)]);return{batch,items:rows};}
async function getItem(itemId){return db.queryOne(`select * from magalu.mass_operation_items where id=$1`,[Number(itemId)]);}
async function getItemForTenant(itemId,dachTenantId){return db.queryOne(`select * from magalu.mass_operation_items where id=$1 and dach_tenant_id=$2`,[Number(itemId),clean(dachTenantId,160)]);}
async function claimItem(itemId){const{rows}=await db.query(`update magalu.mass_operation_items set status='running',started_at=coalesce(started_at,now()),updated_at=now(),error_code=null,error_message=null where id=$1 and status='queued' returning *`,[Number(itemId)]);if(rows[0])await refreshBatch(rows[0].batch_id);return rows[0]||null;}
async function setDispatching(itemId,requestId){const{rows}=await db.query(`update magalu.mass_operation_items set status='dispatching',request_id=coalesce($2,request_id),updated_at=now() where id=$1 and status='running' returning *`,[Number(itemId),clean(requestId,200)||null]);if(rows[0])await refreshBatch(rows[0].batch_id);return rows[0]||null;}
async function setAccepted(itemId,{responseStatus,responsePayload,requestId}){const{rows}=await db.query(`update magalu.mass_operation_items set status='accepted',response_status=$2,response_payload=$3::jsonb,request_id=coalesce($4,request_id),remote_accepted_at=now(),updated_at=now() where id=$1 returning *`,[Number(itemId),Number(responseStatus)||null,JSON.stringify(responsePayload??{}),clean(requestId,200)||null]);if(rows[0])await refreshBatch(rows[0].batch_id);return rows[0]||null;}
async function finishItem(itemId,{status,afterPayload=null,errorCode=null,errorMessage=null,responseStatus=null,responsePayload=null,requestId=null}={}){const{rows}=await db.query(`update magalu.mass_operation_items set status=$2,after_payload=coalesce($3::jsonb,after_payload),error_code=$4,error_message=$5,response_status=coalesce($6,response_status),response_payload=coalesce($7::jsonb,response_payload),request_id=coalesce($8,request_id),completed_at=case when $2=any($9::text[]) then now() else completed_at end,updated_at=now() where id=$1 returning *`,[Number(itemId),clean(status,40),afterPayload==null?null:JSON.stringify(afterPayload),clean(errorCode,160)||null,errorMessage?String(errorMessage).slice(0,2000):null,Number(responseStatus)||null,responsePayload==null?null:JSON.stringify(responsePayload),clean(requestId,200)||null,FINAL_ITEM_STATES]);if(rows[0])await refreshBatch(rows[0].batch_id);return rows[0]||null;}
async function refreshBatch(batchId){const row=await db.queryOne(`select count(*)::int total,count(*) filter(where status='succeeded')::int success,count(*) filter(where status='failed')::int failed,count(*) filter(where status='stale')::int stale,count(*) filter(where status='uncertain')::int uncertain,count(*) filter(where status='divergent')::int divergent,count(*) filter(where status='canceled')::int canceled,count(*) filter(where status=any($2::text[]))::int pending from magalu.mass_operation_items where batch_id=$1`,[String(batchId),ACTIVE_ITEM_STATES]);if(!row)return null;let status="running";if(Number(row.pending)===Number(row.total))status="queued";else if(Number(row.pending)>0)status="running";else if(Number(row.failed)+Number(row.stale)+Number(row.uncertain)+Number(row.divergent)+Number(row.canceled)===0)status="completed";else if(Number(row.success)>0)status="partial";else status="failed";return db.queryOne(`update magalu.mass_operation_batches set status=$2,total_count=$3,success_count=$4,failed_count=$5,stale_count=$6,uncertain_count=$7,divergent_count=$8,canceled_count=$9,pending_count=$10,started_at=case when $2<>'queued' then coalesce(started_at,now()) else started_at end,completed_at=case when $2 in('completed','partial','failed','canceled') then now() else null end,updated_at=now() where id=$1 returning *`,[String(batchId),status,row.total,row.success,row.failed,row.stale,row.uncertain,row.divergent,row.canceled,row.pending]);}
async function cleanupRetention(){const item=await db.query(`delete from magalu.mass_operation_items where (status='succeeded' and completed_at<now()-interval '30 days') or (status in('failed','stale','canceled') and completed_at<now()-interval '60 days') or (status in('uncertain','divergent') and completed_at<now()-interval '90 days')`);const batches=await db.query(`delete from magalu.mass_operation_batches b where not exists(select 1 from magalu.mass_operation_items i where i.batch_id=b.id) and ((b.status='completed' and coalesce(b.completed_at,b.updated_at)<now()-interval '60 days') or (b.status in('partial','failed','canceled') and coalesce(b.completed_at,b.updated_at)<now()-interval '90 days'))`);await db.query(`delete from magalu.sku_mass_previews where expires_at<now()-interval '24 hours'`);return{deleted_items:Number(item.rowCount||0),deleted_batches:Number(batches.rowCount||0)};}
module.exports={ACTIVE_ITEM_STATES,BLOCKING_ITEM_STATES,listSkus,createPreview,getPreview,createBatchFromPreview,listBatches,batchDetail,getItem,getItemForTenant,claimItem,setDispatching,setAccepted,finishItem,refreshBatch,cleanupRetention,_test:{clean,int,boolFilter,catalogWhere,selectedRows}};
