"use strict";

const crypto = require("node:crypto");
const db = require("../config/postgres");
const { appendAuditEvent } = require("./auditRepository");

function text(value) { return String(value == null ? "" : value).trim(); }

async function createPreview({ accountId, dachTenantId, dachUserId, resourceType, rows, expiresAt }) {
  const id = crypto.randomUUID();
  const { rows: result } = await db.query(
    `insert into magalu.write_previews
       (id,account_id,dach_tenant_id,dach_user_id,resource_type,rows,expires_at)
     values($1,$2,$3,$4,$5,$6::jsonb,$7)
     returning id,account_id,dach_tenant_id,dach_user_id,resource_type,rows,created_at,expires_at,used_at`,
    [id, Number(accountId), text(dachTenantId), text(dachUserId), text(resourceType), JSON.stringify(rows || []), expiresAt],
  );
  return result[0] || null;
}

async function getPreviewForIdentity(previewId, { dachTenantId, dachUserId }) {
  return db.queryOne(
    `select id,account_id,dach_tenant_id,dach_user_id,resource_type,rows,created_at,expires_at,used_at
       from magalu.write_previews where id=$1 and dach_tenant_id=$2 and dach_user_id=$3 limit 1`,
    [String(previewId), text(dachTenantId), text(dachUserId)],
  );
}

async function audit(client, event) {
  return appendAuditEvent({
    ...event,
    batchId: event.batchId || event.details?.preview_id || null,
    requestId: event.requestId || event.details?.request_id || null,
    source: event.source || "protected-write",
  }, { client });
}

async function createOperationsFromPreview(previewId, { dachTenantId, dachUserId }) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const preview = (await client.query(
        `select id,account_id,dach_tenant_id,dach_user_id,resource_type,rows,created_at,expires_at,used_at
           from magalu.write_previews where id=$1 and dach_tenant_id=$2 and dach_user_id=$3 limit 1 for update`,
        [String(previewId), text(dachTenantId), text(dachUserId)],
      )).rows[0] || null;
      if (!preview) { const error=new Error("Preview de alteração não encontrado.");error.code="MAGALU_WRITE_PREVIEW_NOT_FOUND";error.status=404;throw error; }
      if (preview.used_at) { const error=new Error("Este preview já foi confirmado.");error.code="MAGALU_WRITE_PREVIEW_ALREADY_USED";error.status=409;throw error; }
      if (new Date(preview.expires_at).getTime() <= Date.now()) { const error=new Error("O preview expirou. Gere uma nova conferência antes de alterar o Magalu.");error.code="MAGALU_WRITE_PREVIEW_EXPIRED";error.status=409;throw error; }
      const candidates=(Array.isArray(preview.rows)?preview.rows:[]).filter(row=>row&&row.valid===true&&row.changed===true);
      if(!candidates.length){const error=new Error("O preview não possui alterações válidas para aplicar.");error.code="MAGALU_WRITE_PREVIEW_EMPTY";error.status=409;throw error;}
      const operations=[];
      for(const row of candidates){
        const idempotencyKey=crypto.randomUUID();await client.query("savepoint magalu_write_operation_insert");
        try{
          const inserted=(await client.query(`insert into magalu.write_operations
            (idempotency_key,account_id,preview_id,dach_tenant_id,dach_user_id,resource_type,sku,request_hash,intended_method,status,before_payload,requested_payload)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10::jsonb,$11::jsonb) returning *`,
            [idempotencyKey,Number(preview.account_id),preview.id,preview.dach_tenant_id,preview.dach_user_id,preview.resource_type,String(row.sku),String(row.request_hash),String(row.method||"PATCH"),JSON.stringify(row.before||{}),JSON.stringify(row.requested||{})])).rows[0];
          await client.query("release savepoint magalu_write_operation_insert");operations.push({...inserted,duplicate:false});
          await audit(client,{accountId:preview.account_id,operationId:inserted.id,dachTenantId:preview.dach_tenant_id,dachUserId:preview.dach_user_id,action:"WRITE_QUEUED",resourceType:preview.resource_type,sku:row.sku,batchId:preview.id,details:{preview_id:preview.id,request_hash:row.request_hash,method:row.method}});
        }catch(error){
          await client.query("rollback to savepoint magalu_write_operation_insert").catch(()=>{});await client.query("release savepoint magalu_write_operation_insert").catch(()=>{});
          if(String(error?.code||"")!=="23505")throw error;
          const existing=(await client.query(`select * from magalu.write_operations where account_id=$1 and resource_type=$2 and sku=$3 and request_hash=$4 and status in ('queued','running','dispatching','accepted','divergent','uncertain') order by created_at desc limit 1`,[Number(preview.account_id),preview.resource_type,String(row.sku),String(row.request_hash)])).rows[0]||null;
          if(existing){operations.push({...existing,duplicate:true});continue;}
          const blocker=(await client.query(`select id,status,sku,resource_type,created_at from magalu.write_operations where account_id=$1 and resource_type=$2 and sku=$3 and status in ('queued','running','dispatching','accepted','divergent','uncertain') order by created_at desc limit 1`,[Number(preview.account_id),preview.resource_type,String(row.sku)])).rows[0]||null;
          if(blocker){const conflict=new Error(`Já existe uma operação ${blocker.status} não resolvida para o SKU ${row.sku}.`);conflict.code="MAGALU_WRITE_ACTIVE_OPERATION_EXISTS";conflict.status=409;conflict.operation_id=blocker.id;throw conflict;}throw error;
        }
      }
      await client.query(`update magalu.write_previews set used_at=now() where id=$1`,[preview.id]);await client.query("commit");return{preview,operations};
    }catch(error){await client.query("rollback").catch(()=>{});throw error;}
  });
}

async function getOperation(operationId){return db.queryOne(`select * from magalu.write_operations where id=$1 limit 1`,[Number(operationId)]);}
async function getOperationForTenant(operationId,dachTenantId){return db.queryOne(`select * from magalu.write_operations where id=$1 and dach_tenant_id=$2 limit 1`,[Number(operationId),text(dachTenantId)]);}
async function listOperations(accountId,dachTenantId,limit=50){const safe=Math.min(100,Math.max(1,Number(limit)||50));const{rows}=await db.query(`select id,idempotency_key,account_id,preview_id,dach_user_id,resource_type,sku,intended_method,actual_method,status,before_payload,requested_payload,response_status,request_id,error_code,error_message,remote_accepted_at,started_at,completed_at,created_at,updated_at from magalu.write_operations where account_id=$1 and dach_tenant_id=$2 order by created_at desc limit $3`,[Number(accountId),text(dachTenantId),safe]);return rows;}
async function findBlockingOperation(accountId,dachTenantId,resourceType,sku){return db.queryOne(`select id,status,resource_type,sku,request_hash,remote_accepted_at,created_at,updated_at from magalu.write_operations where account_id=$1 and dach_tenant_id=$2 and resource_type=$3 and sku=$4 and status in ('queued','running','dispatching','accepted','divergent','uncertain') order by created_at desc limit 1`,[Number(accountId),text(dachTenantId),text(resourceType),text(sku)]);}
async function claimOperation(operationId){const{rows}=await db.query(`update magalu.write_operations set status='running',started_at=coalesce(started_at,now()),updated_at=now(),error_code=null,error_message=null where id=$1 and status='queued' returning *`,[Number(operationId)]);return rows[0]||null;}
async function setOperationDispatching(operationId,{method,requestId}){const{rows}=await db.query(`update magalu.write_operations set status='dispatching',actual_method=$2,request_id=coalesce($3,request_id),updated_at=now() where id=$1 and status='running' returning *`,[Number(operationId),text(method),text(requestId)||null]);return rows[0]||null;}
async function setOperationAccepted(operationId,{method,responseStatus,responsePayload,requestId}){const{rows}=await db.query(`update magalu.write_operations set status='accepted',actual_method=$2,response_status=$3,response_payload=$4::jsonb,request_id=$5,remote_accepted_at=now(),updated_at=now() where id=$1 returning *`,[Number(operationId),method,Number(responseStatus)||null,JSON.stringify(responsePayload??{}),text(requestId)||null]);return rows[0]||null;}
async function finishOperation(operationId,{status,afterPayload=null,errorCode=null,errorMessage=null,responseStatus=null,responsePayload=null,requestId=null,actualMethod=null}={}){const{rows}=await db.query(`update magalu.write_operations set status=$2,after_payload=coalesce($3::jsonb,after_payload),error_code=$4,error_message=$5,response_status=coalesce($6,response_status),response_payload=coalesce($7::jsonb,response_payload),request_id=coalesce($8,request_id),actual_method=coalesce($9,actual_method),completed_at=case when $2 in ('succeeded','stale','failed') then now() else completed_at end,updated_at=now() where id=$1 returning *`,[Number(operationId),text(status),afterPayload==null?null:JSON.stringify(afterPayload),text(errorCode)||null,errorMessage?String(errorMessage).slice(0,2000):null,Number(responseStatus)||null,responsePayload==null?null:JSON.stringify(responsePayload),text(requestId)||null,text(actualMethod)||null]);return rows[0]||null;}
async function appendAudit(event){return audit(db,event);}
async function acquireOperationLock(client,operation){const key=`${operation.account_id}:${operation.resource_type}:${operation.sku}`;await client.query(`select pg_advisory_lock(hashtext($1)::bigint)`,[key]);return async()=>{await client.query(`select pg_advisory_unlock(hashtext($1)::bigint)`,[key]).catch(()=>{});};}
module.exports={createPreview,getPreviewForIdentity,createOperationsFromPreview,getOperation,getOperationForTenant,listOperations,findBlockingOperation,claimOperation,setOperationDispatching,setOperationAccepted,finishOperation,appendAudit,acquireOperationLock,_test:{audit}};
