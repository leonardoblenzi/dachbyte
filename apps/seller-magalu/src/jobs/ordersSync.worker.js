"use strict";

const { Worker } = require("bullmq");
const { ensureRedisConnected } = require("../config/redis");
const queueNames = require("../config/queueNames");
const accountRepository = require("../repositories/accountRepository");
const { fullOrderSync, reconcileOrder, reconcileDelivery } = require("../services/orderSyncService");
const { recordBestEffort, errorDetails } = require("../services/auditService");

let worker=null;
async function processOrdersJob(job){
  const account=await accountRepository.findAccountById(job.data.accountId);
  if(!account)throw new Error("Conta Magalu não encontrada para job de pedidos.");
  if(job.data.dachTenantId&&String(account.dach_tenant_id)!==String(job.data.dachTenantId)){const e=new Error("Tenant DACH divergente no job de pedidos Magalu.");e.code="MAGALU_ORDERS_TENANT_MISMATCH";throw e;}
  const base={source:"worker",accountId:account.id,dachTenantId:account.dach_tenant_id,magaluTenantId:account.magalu_tenant_id};
  try{
    if(job.name==="full-sync"){
      await recordBestEffort({...base,eventKey:"orders_sync_started",details:{job_id:job.id||null,reason:job.data.reason||"queue",read_only:true}});
      const result=await fullOrderSync(account.id,{reason:job.data.reason||"queue",jobId:job.id});
      await recordBestEffort({...base,eventKey:"orders_sync_completed",details:{job_id:job.id||null,status:result.status,scanned:result.scanned,failed:result.failed,order_pages:result.orderPages,delivery_pages:result.deliveryPages,read_only:true}});
      return result;
    }
    if(job.name==="reconcile-order"){
      const result=await reconcileOrder(account.id,job.data.code,{topic:job.data.reason||"manual"});
      await recordBestEffort({...base,eventKey:"order_reconciled",details:{job_id:job.id||null,code:job.data.code,reason:job.data.reason||"manual",read_only:true}});return result;
    }
    if(job.name==="reconcile-delivery"){
      const result=await reconcileDelivery(account.id,job.data.deliveryId,{topic:job.data.reason||"orders_delivery"});
      await recordBestEffort({...base,eventKey:"delivery_reconciled",details:{job_id:job.id||null,delivery_id:job.data.deliveryId,reason:job.data.reason||"orders_delivery",fallback:result?.fallback===true,read_only:true}});return result;
    }
    throw new Error(`Job de pedidos Magalu desconhecido: ${job.name}`);
  }catch(error){
    await recordBestEffort({...base,eventKey:"orders_sync_failed",outcome:"failed",severity:"error",requestId:error?.requestId||null,details:{job_id:job.id||null,name:job.name||null,error:errorDetails(error),read_only:true}});
    throw error;
  }
}
async function startOrdersSyncWorker(){if(worker)return worker;const connection=await ensureRedisConnected();worker=new Worker(queueNames.ordersSync,processOrdersJob,{connection,concurrency:2});worker.on("failed",(job,error)=>console.error("[seller-magalu:orders-worker] job failed",{job:job?.id||null,name:job?.name||null,message:error?.message||String(error)}));return worker;}
async function stopOrdersSyncWorker(){if(!worker)return;const current=worker;worker=null;await current.close();}
module.exports={startOrdersSyncWorker,stopOrdersSyncWorker,_test:{processOrdersJob}};
