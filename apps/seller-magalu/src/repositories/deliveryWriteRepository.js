"use strict";
const crypto=require("node:crypto");
const db=require("../config/postgres");
const env=require("../config/env");
const {normalizeAction,requestHash,encryptBody,decryptBody}=require("../services/deliveryWritePayload");
const FINAL_STATES=["succeeded","stale","failed","divergent","uncertain","canceled"];
const BLOCKING_STATES=["queued","running","dispatching","accepted","divergent","uncertain"];
function text(v,max=500){return String(v==null?"":v).trim().slice(0,max);}
function int(v,min,max,fallback){const n=Number.parseInt(String(v==null?"":v),10);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;}
function publicOperation(row){if(!row)return null;const{ sensitive_payload_ciphertext,...safe}=row;return safe;}
async function createPreview({accountId,dachTenantId,dachUserId,delivery,action,requestBody,requestedMetadata}){
  const normalized=normalizeAction(action),id=crypto.randomUUID(),before={remote_id:text(delivery.remote_id||delivery.id,300),status:text(delivery.status,80).toLowerCase(),channel_id:text(delivery.channel_id,160),order_code:text(delivery.order_code,300)||null};
  const hash=requestHash({accountId:Number(accountId),delivery_id:before.remote_id,action:normalized,before,requested:requestedMetadata||{}});
  const expiresAt=new Date(Date.now()+Math.max(60,Number(env.MAGALU_DELIVERY_WRITE_PREVIEW_TTL_SECONDS||600))*1000).toISOString();
  const cipher=encryptBody(requestBody);
  const {rows}=await db.query(`insert into magalu.delivery_write_previews(id,account_id,dach_tenant_id,dach_user_id,delivery_id,order_code,channel_id,action,before_payload,requested_metadata,sensitive_payload_ciphertext,request_hash,expires_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13) returning id,account_id,dach_tenant_id,dach_user_id,delivery_id,order_code,channel_id,action,before_payload,requested_metadata,request_hash,created_at,expires_at,used_at`,[
      id,Number(accountId),text(dachTenantId,160),text(dachUserId,160),before.remote_id,before.order_code,before.channel_id,normalized,JSON.stringify(before),JSON.stringify(requestedMetadata||{}),cipher,hash,expiresAt]);
  return rows[0];
}
async function getPreview(id,{dachTenantId,dachUserId}){return db.queryOne(`select * from magalu.delivery_write_previews where id=$1 and dach_tenant_id=$2 and dach_user_id=$3 limit 1`,[String(id),text(dachTenantId,160),text(dachUserId,160)]);}
async function createOperationFromPreview(id,{dachTenantId,dachUserId}){return db.withClient(async client=>{await client.query("begin");try{
  const p=(await client.query(`select * from magalu.delivery_write_previews where id=$1 and dach_tenant_id=$2 and dach_user_id=$3 for update`,[String(id),text(dachTenantId,160),text(dachUserId,160)])).rows[0];
  if(!p){const e=new Error("Preview de entrega não encontrado.");e.code="MAGALU_DELIVERY_PREVIEW_NOT_FOUND";e.status=404;throw e;}
  if(p.used_at){const e=new Error("Este preview já foi confirmado.");e.code="MAGALU_DELIVERY_PREVIEW_USED";e.status=409;throw e;}
  if(new Date(p.expires_at).getTime()<=Date.now()){const e=new Error("O preview expirou. Gere um novo.");e.code="MAGALU_DELIVERY_PREVIEW_EXPIRED";e.status=409;throw e;}
  const key=crypto.randomUUID();const inserted=(await client.query(`insert into magalu.delivery_write_operations(idempotency_key,preview_id,account_id,dach_tenant_id,dach_user_id,delivery_id,order_code,channel_id,action,request_hash,before_payload,requested_metadata,sensitive_payload_ciphertext)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13) returning *`,[key,p.id,p.account_id,p.dach_tenant_id,p.dach_user_id,p.delivery_id,p.order_code,p.channel_id,p.action,p.request_hash,JSON.stringify(p.before_payload||{}),JSON.stringify(p.requested_metadata||{}),p.sensitive_payload_ciphertext])).rows[0];
  await client.query(`update magalu.delivery_write_previews set used_at=now(),sensitive_payload_ciphertext=null where id=$1`,[p.id]);await client.query("commit");return publicOperation(inserted);
}catch(error){await client.query("rollback").catch(()=>{});if(String(error?.code||"")==="23505"){const e=new Error("Já existe uma operação pendente/ambígua para esta entrega e ação.");e.code="MAGALU_DELIVERY_ACTIVE_OPERATION_EXISTS";e.status=409;throw e;}throw error;}});}
async function getOperation(id){const row=await db.queryOne(`select * from magalu.delivery_write_operations where id=$1`,[Number(id)]);return row;}
async function getOperationForTenant(id,dachTenantId){const row=await db.queryOne(`select * from magalu.delivery_write_operations where id=$1 and dach_tenant_id=$2`,[Number(id),text(dachTenantId,160)]);return row;}
async function claim(id){const{rows}=await db.query(`update magalu.delivery_write_operations set status='running',started_at=coalesce(started_at,now()),error_code=null,error_message=null,updated_at=now() where id=$1 and status='queued' returning *`,[Number(id)]);return rows[0]||null;}
async function setDispatching(id,requestId){const{rows}=await db.query(`update magalu.delivery_write_operations set status='dispatching',request_id=coalesce($2,request_id),sensitive_payload_ciphertext=null,updated_at=now() where id=$1 and status='running' returning *`,[Number(id),text(requestId,200)||null]);return rows[0]||null;}
async function setAccepted(id,{responseStatus,responsePayload,requestId}){const{rows}=await db.query(`update magalu.delivery_write_operations set status='accepted',response_status=$2,response_payload=$3::jsonb,request_id=coalesce($4,request_id),remote_accepted_at=now(),updated_at=now() where id=$1 returning *`,[Number(id),Number(responseStatus)||null,JSON.stringify(responsePayload??{}),text(requestId,200)||null]);return rows[0]||null;}
async function finish(id,{status,afterPayload=null,errorCode=null,errorMessage=null,responseStatus=null,responsePayload=null,requestId=null}={}){const{rows}=await db.query(`update magalu.delivery_write_operations set status=$2,after_payload=coalesce($3::jsonb,after_payload),error_code=$4,error_message=$5,response_status=coalesce($6,response_status),response_payload=coalesce($7::jsonb,response_payload),request_id=coalesce($8,request_id),completed_at=case when $2=any($9::text[]) then now() else completed_at end,updated_at=now() where id=$1 returning *`,[Number(id),text(status,40),afterPayload==null?null:JSON.stringify(afterPayload),text(errorCode,160)||null,errorMessage?String(errorMessage).slice(0,2000):null,Number(responseStatus)||null,responsePayload==null?null:JSON.stringify(responsePayload),text(requestId,200)||null,FINAL_STATES]);return rows[0]||null;}
async function list(dachTenantId,{accountId=null,status="",action="",page=1,limit=30}={}){const p=int(page,1,100000,1),l=int(limit,1,100,30),offset=(p-1)*l,where=["o.dach_tenant_id=$1"],params=[text(dachTenantId,160)];const aid=Number.parseInt(accountId,10),st=text(status,40),act=text(action,40);if(Number.isFinite(aid)&&aid>0){params.push(aid);where.push(`o.account_id=$${params.length}`);}if(st){params.push(st);where.push(`o.status=$${params.length}`);}if(act){params.push(act);where.push(`o.action=$${params.length}`);}const total=await db.queryOne(`select count(*)::int total from magalu.delivery_write_operations o where ${where.join(" and ")}`,params);const{rows}=await db.query(`select o.id,o.preview_id,o.account_id,o.dach_tenant_id,o.dach_user_id,o.delivery_id,o.order_code,o.channel_id,o.action,o.status,o.request_hash,o.before_payload,o.requested_metadata,o.response_payload,o.after_payload,o.response_status,o.request_id,o.error_code,o.error_message,o.remote_accepted_at,o.started_at,o.completed_at,o.created_at,o.updated_at from magalu.delivery_write_operations o where ${where.join(" and ")} order by o.created_at desc limit $${params.length+1} offset $${params.length+2}`,[...params,l,offset]);return{rows,total:Number(total?.total||0),page:p,limit:l};}
async function blockers(accountId){const{rows}=await db.query(`select id,delivery_id,action,status,created_at from magalu.delivery_write_operations where account_id=$1 and status=any($2::text[]) order by created_at asc`,[Number(accountId),BLOCKING_STATES]);return rows;}
function decryptedBody(operation){return decryptBody(operation?.sensitive_payload_ciphertext);}

async function cleanupRetention(){
  const previews=await db.query(`delete from magalu.delivery_write_previews where expires_at<now()-interval '24 hours'`);
  const operations=await db.query(`delete from magalu.delivery_write_operations where (status='succeeded' and completed_at<now()-interval '30 days') or (status in('failed','stale','canceled') and completed_at<now()-interval '60 days') or (status in('uncertain','divergent') and completed_at<now()-interval '90 days')`);
  return{deleted_previews:Number(previews.rowCount||0),deleted_operations:Number(operations.rowCount||0)};
}
module.exports={FINAL_STATES,BLOCKING_STATES,createPreview,getPreview,createOperationFromPreview,getOperation,getOperationForTenant,claim,setDispatching,setAccepted,finish,list,blockers,decryptedBody,cleanupRetention,publicOperation,_test:{text,int}};
