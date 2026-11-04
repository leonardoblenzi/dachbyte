"use strict";
const { randomUUID } = require("node:crypto");
const db = require("../config/postgres");
const selections = require("./skuBulkSelectionRepository");
const skuMass = require("./skuMassRepository");
const env = require("../config/env");

function error(message,status=422){const e=new Error(message);e.status=status;return e;}
async function create(identity,selectionId,action){
  if(!["activate","deactivate"].includes(action))throw error("Ação inválida.");
  const selection=await selections.get(selectionId,identity.accountId,identity.tenantId,identity.userId);
  if(!selection||selection.state!=="ready"||!Number(selection.matched_count))throw error("Seleção vazia ou expirada.",409);
  const previews=[];
  for(let offset=0;offset<Number(selection.matched_count);offset+=env.MAGALU_SKU_MAX_BATCH_SIZE){
    const part=await selections.skuPage(selectionId,identity,offset,env.MAGALU_SKU_MAX_BATCH_SIZE);
    if(!part.skus.length)throw error("A seleção mudou. Gere nova revisão.",409);
    const preview=await skuMass.createPreview({accountId:identity.accountId,dachTenantId:identity.tenantId,dachUserId:identity.userId,action,selection:{mode:"explicit",skus:part.skus}});
    await db.query(`update magalu.sku_mass_previews set expires_at=now()+interval '24 hours' where id=$1`,[preview.id]);
    previews.push({id:preview.id,selected_count:preview.selected_count,change_count:preview.change_count,first_sku:part.skus[0],last_sku:part.skus.at(-1)});
  }
  if(!previews.some(p=>Number(p.change_count)>0))throw error("Nenhum SKU precisa desta alteração.",409);
  const id=randomUUID(),expiresAt=new Date(Date.now()+24*60*60*1000).toISOString();
  const changeCount=previews.reduce((a,p)=>a+Number(p.change_count),0);
  await db.query(`insert into magalu.sku_bulk_groups(id,selection_id,account_id,dach_tenant_id,dach_user_id,action,preview_ids,total_count,expires_at) values($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9)`,[id,selectionId,Number(identity.accountId),identity.tenantId,identity.userId,action,previews.filter(p=>Number(p.change_count)>0).map(p=>p.id),changeCount,expiresAt]);
  return{id,action,selected_count:previews.reduce((a,p)=>a+Number(p.selected_count),0),change_count:changeCount,previews,expires_at:expiresAt};
}
async function get(id,identity){return db.queryOne(`select * from magalu.sku_bulk_groups where id=$1 and account_id=$2 and dach_tenant_id=$3 and dach_user_id=$4`,[id,Number(identity.accountId),identity.tenantId,identity.userId]);}
async function markQueued(id){await db.query(`update magalu.sku_bulk_groups set status='queued',error_message=null where id=$1 and applied_at is null and status in ('prepared','failed')`,[id]);}
async function apply(identity,id,enqueue){
  const group=await get(id,identity);
  if(!group)throw error("Revisão não encontrada.",404);
  if(group.applied_at)return{id,batches:[],already_enqueued:true};
  if(new Date(group.expires_at)<=new Date())throw error("Revisão expirada. Gere outra.",409);
  const results=[];
  await db.query(`update magalu.sku_bulk_groups set status='running',error_message=null where id=$1`,[id]);
  try{
  for(const previewId of group.preview_ids){
    const existing=await db.queryOne(`select id from magalu.mass_operation_batches where preview_id=$1 and group_id=$2`,[previewId,id]);
    if(existing){
      const pending=await db.query(`select id from magalu.mass_operation_items where batch_id=$1 and status='queued'`,[existing.id]);
      if(pending.rows.length)await enqueue(pending.rows);
      results.push({batch_id:existing.id,reused:true});continue;
    }
    const created=await skuMass.createBatchFromPreview(previewId,{dachTenantId:identity.tenantId,dachUserId:identity.userId,groupId:id});
    const jobs=await enqueue(created.items);
    results.push({batch_id:created.batchId,total:created.items.length,queued:jobs.length});
  }
  await db.query(`update magalu.sku_bulk_groups set applied_at=now(),status='enqueued',error_message=null where id=$1 and applied_at is null`,[id]);
  return{id,batches:results};
  }catch(e){await db.query(`update magalu.sku_bulk_groups set status='failed',error_message=$2 where id=$1`,[id,String(e.message||e).slice(0,1000)]).catch(()=>{});throw e;}
}
module.exports={create,get,apply,markQueued};
