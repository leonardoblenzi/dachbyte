"use strict";

const crypto = require("node:crypto");
const { Queue } = require("bullmq");
const { ensureRedisConnected } = require("../config/redis");
const queueNames = require("../config/queueNames");

const queues = new Map();
async function getQueue(name) {
  if (!Object.values(queueNames).includes(name)) throw new Error(`Fila Magalu desconhecida: ${name}`);
  if (queues.has(name)) return queues.get(name);
  const connection = await ensureRedisConnected();
  const queue = new Queue(name,{connection}); queues.set(name,queue); return queue;
}
async function enqueueWebhookEvent(eventId){const q=await getQueue(queueNames.webhookProcess);return q.add("process",{eventId:Number(eventId)},{jobId:`magalu-webhook-${Number(eventId)}`,attempts:5,backoff:{type:"exponential",delay:5000},removeOnComplete:500,removeOnFail:1000});}
async function enqueueTokenRefresh(accountId){const id=Number(accountId);if(!Number.isFinite(id)||id<=0)throw new Error("accountId inválido para refresh Magalu.");const q=await getQueue(queueNames.tokenRefresh);return q.add("refresh",{accountId:id},{jobId:`magalu-token-refresh-${id}`,attempts:4,backoff:{type:"exponential",delay:10000},removeOnComplete:true,removeOnFail:true});}
async function enqueueCatalogSync(accountId,{dachTenantId=null,reason="manual"}={}){const id=Number(accountId);if(!Number.isFinite(id)||id<=0)throw new Error("accountId inválido para sync Magalu.");const q=await getQueue(queueNames.catalogSync);return q.add("full-sync",{accountId:id,dachTenantId:dachTenantId||null,reason},{jobId:`magalu-catalog-full-${id}-${crypto.randomUUID()}`,attempts:2,backoff:{type:"exponential",delay:15000},removeOnComplete:200,removeOnFail:500});}
async function enqueueHubResourceSync(accountId){const id=Number(accountId);if(!Number.isFinite(id)||id<=0)throw new Error("accountId inválido para recurso Hub Magalu.");const q=await getQueue(queueNames.hubResourceSync);const jobId=`magalu-hub-resource-${id}`;const connection=await ensureRedisConnected();const lockKey=`magalu:hub-resource:enqueue:${id}`;const lockToken=crypto.randomUUID();const reserved=await connection.set(lockKey,lockToken,"PX",30000,"NX");if(reserved!=="OK")return{id:jobId,scheduled:false};try{const existing=await q.getJob(jobId);if(existing)return{id:existing.id,scheduled:false};const job=await q.add("sync-resource",{accountId:id},{jobId,attempts:5,backoff:{type:"exponential",delay:5000},removeOnComplete:true,removeOnFail:true});return{id:job.id,scheduled:true};}finally{await connection.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",1,lockKey,lockToken).catch(()=>{});}}
async function enqueueCatalogReconcile(accountId,sku,{topic="manual",eventId=null}={}){const id=Number(accountId),normalizedSku=String(sku||"").trim();if(!Number.isFinite(id)||id<=0||!normalizedSku)throw new Error("Conta/SKU inválidos para reconciliação Magalu.");const q=await getQueue(queueNames.catalogSync);return q.add("reconcile-sku",{accountId:id,sku:normalizedSku,topic,eventId:eventId?Number(eventId):null},{jobId:`magalu-catalog-sku-${id}-${Buffer.from(normalizedSku).toString("hex").slice(0,48)}-${Date.now()}`,attempts:3,backoff:{type:"exponential",delay:5000},removeOnComplete:500,removeOnFail:1000});}
async function enqueueWriteOperation(operation,{reason="apply"}={}){const id=Number(operation?.id),resource=String(operation?.resource_type||"");if(!Number.isFinite(id)||id<=0||!["price","stock"].includes(resource))throw new Error("Operação Magalu inválida para fila de escrita.");const q=await getQueue(resource==="price"?queueNames.priceUpdate:queueNames.stockUpdate);return q.add(reason==="reverify"?"verify":"apply",{operationId:id,reason},{jobId:`magalu-${resource}-update-${id}-${crypto.randomUUID()}`,attempts:3,backoff:{type:"exponential",delay:5000},removeOnComplete:500,removeOnFail:1000});}
async function enqueueAuditMaintenance({reason="manual"}={}){const q=await getQueue(queueNames.auditMaintenance);return q.add("cleanup",{reason},{jobId:`magalu-audit-maintenance-${crypto.randomUUID()}`,attempts:2,backoff:{type:"exponential",delay:30000},removeOnComplete:100,removeOnFail:200});}
async function ensureAuditMaintenanceSchedule(){const q=await getQueue(queueNames.auditMaintenance);if(typeof q.upsertJobScheduler==="function")return q.upsertJobScheduler("magalu-audit-daily",{pattern:"17 3 * * *",tz:"America/Sao_Paulo"},{name:"cleanup",data:{reason:"scheduled"},opts:{attempts:2,backoff:{type:"exponential",delay:30000},removeOnComplete:100,removeOnFail:200}});return q.add("cleanup",{reason:"scheduled"},{jobId:"magalu-audit-daily",repeat:{pattern:"17 3 * * *",tz:"America/Sao_Paulo"},attempts:2,backoff:{type:"exponential",delay:30000},removeOnComplete:100,removeOnFail:200});}

async function enqueueSkuMassItems(items,{reason="apply"}={}){
  const rows=Array.isArray(items)?items:[];
  if(!rows.length)return[];
  const q=await getQueue(queueNames.skuUpdate);
  return q.addBulk(rows.map(item=>({
    name:reason==="reverify"?"verify":"apply",
    data:{itemId:Number(item.id),reason},
    opts:{jobId:`magalu-sku-update-${Number(item.id)}-${reason}-${crypto.randomUUID()}`,attempts:3,backoff:{type:"exponential",delay:5000},removeOnComplete:1000,removeOnFail:2000}
  })));
}
async function enqueueSkuMassReverify(item){return enqueueSkuMassItems([item],{reason:"reverify"});}
async function ensureSkuRetentionSchedule(){
  const q=await getQueue(queueNames.skuUpdate);
  const opts={attempts:2,backoff:{type:"exponential",delay:30000},removeOnComplete:50,removeOnFail:100};
  if(typeof q.upsertJobScheduler==="function")return q.upsertJobScheduler("magalu-sku-retention-daily",{pattern:"7 4 * * *",tz:"America/Sao_Paulo"},{name:"retention",data:{reason:"scheduled"},opts});
  return q.add("retention",{reason:"scheduled"},{jobId:"magalu-sku-retention-daily",repeat:{pattern:"7 4 * * *",tz:"America/Sao_Paulo"},...opts});
}
async function enqueueOrdersSync(accountId,{dachTenantId=null,dachUserId=null,reason="manual"}={}){const id=Number(accountId);if(!Number.isFinite(id)||id<=0)throw new Error("accountId inválido para sync de pedidos Magalu.");const q=await getQueue(queueNames.ordersSync);return q.add("full-sync",{accountId:id,dachTenantId:dachTenantId||null,dachUserId:dachUserId||null,reason},{jobId:`magalu-orders-full-${id}-${crypto.randomUUID()}`,attempts:3,backoff:{type:"exponential",delay:10000},removeOnComplete:300,removeOnFail:1000});}
async function enqueueOrderReconcile(accountId,code,{dachTenantId=null,dachUserId=null,reason="manual"}={}){const id=Number(accountId),orderCode=String(code||"").trim();if(!Number.isFinite(id)||id<=0||!orderCode)throw new Error("Conta/código inválidos para reconciliação de pedido Magalu.");const q=await getQueue(queueNames.ordersSync);return q.add("reconcile-order",{accountId:id,code:orderCode,dachTenantId:dachTenantId||null,dachUserId:dachUserId||null,reason},{jobId:`magalu-order-reconcile-${id}-${crypto.randomUUID()}`,attempts:3,backoff:{type:"exponential",delay:5000},removeOnComplete:500,removeOnFail:1000});}
async function enqueueDeliveryReconcile(accountId,deliveryId,{dachTenantId=null,dachUserId=null,reason="orders_delivery"}={}){const id=Number(accountId),remoteId=String(deliveryId||"").trim();if(!Number.isFinite(id)||id<=0||!remoteId)throw new Error("Conta/entrega inválidas para reconciliação Magalu.");const q=await getQueue(queueNames.ordersSync);return q.add("reconcile-delivery",{accountId:id,deliveryId:remoteId,dachTenantId:dachTenantId||null,dachUserId:dachUserId||null,reason},{jobId:`magalu-delivery-reconcile-${id}-${crypto.randomUUID()}`,attempts:3,backoff:{type:"exponential",delay:5000},removeOnComplete:500,removeOnFail:1000});}
async function enqueueDeliveryWriteOperation(operation,{reason="apply"}={}){const id=Number(operation?.id);if(!Number.isFinite(id)||id<=0)throw new Error("Operação de entrega inválida para fila.");const q=await getQueue(queueNames.deliveryWrite);return q.add(reason==="reverify"?"verify":"apply",{operationId:id,reason},{jobId:`magalu-delivery-write-${id}-${reason}-${crypto.randomUUID()}`,attempts:3,backoff:{type:"exponential",delay:5000},removeOnComplete:500,removeOnFail:1000});}
async function ensureDeliveryWriteRetentionSchedule(){const q=await getQueue(queueNames.deliveryWrite);const opts={attempts:2,backoff:{type:"exponential",delay:30000},removeOnComplete:50,removeOnFail:100};if(typeof q.upsertJobScheduler==="function")return q.upsertJobScheduler("magalu-delivery-write-retention-daily",{pattern:"37 4 * * *",tz:"America/Sao_Paulo"},{name:"retention",data:{reason:"scheduled"},opts});return q.add("retention",{reason:"scheduled"},{jobId:"magalu-delivery-write-retention-daily",repeat:{pattern:"37 4 * * *",tz:"America/Sao_Paulo"},...opts});}
async function closeQueues(){await Promise.all([...queues.values()].map(q=>q.close().catch(()=>{})));queues.clear();}
module.exports={getQueue,enqueueWebhookEvent,enqueueTokenRefresh,enqueueCatalogSync,enqueueHubResourceSync,enqueueCatalogReconcile,enqueueWriteOperation,enqueueAuditMaintenance,ensureAuditMaintenanceSchedule,enqueueSkuMassItems,enqueueSkuMassReverify,ensureSkuRetentionSchedule,enqueueOrdersSync,enqueueOrderReconcile,enqueueDeliveryReconcile,enqueueDeliveryWriteOperation,ensureDeliveryWriteRetentionSchedule,closeQueues,queueNames};
